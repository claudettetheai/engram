#!/usr/bin/env node
// extract-artifacts.js — LLM-based artifact extraction from session messages
//
// Usage:
//   node extract-artifacts.js --latest          → extract from latest/ending session
//   node extract-artifacts.js --session <id>    → extract from specific session
//
// Uses Anthropic API to identify high-value items: decisions, errors, ideas, etc.
// Applies novelty gate before inserting: skip >=0.92 similarity, merge 0.82-0.91, store <0.82

const { query, withTransaction, end, logError } = require('./lib/db');
const path = require('path');
const fs = require('fs');

// Load API key from .env.local
const envPath = path.resolve(__dirname, '../../apps/web/.env.local');
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY && fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^ANTHROPIC_API_KEY\s*=\s*["']?(.+?)["']?\s*$/);
    if (match) { ANTHROPIC_API_KEY = match[1]; break; }
  }
}

const args = process.argv.slice(2);
const isLatest = args.includes('--latest');
const sessionArg = getArg('--session');

// Also handle SessionEnd hook stdin
let stdinData = null;

async function main() {
  // Try reading stdin for SessionEnd hook data
  try {
    stdinData = await readStdinTimeout(3000);
  } catch { /* no stdin */ }

  let sessionId = sessionArg;

  if (isLatest || stdinData?.session_id) {
    sessionId = stdinData?.session_id || await getLatestSessionId();
  }

  if (!sessionId) {
    console.error('No session specified. Use --latest or --session <id>');
    process.exit(0);
  }

  try {
    await extractArtifacts(sessionId);

    // Mark session as completed if this is a SessionEnd hook
    if (isLatest || stdinData?.hook_event_name === 'SessionEnd') {
      await query(
        'UPDATE claude_memory.sessions SET status = $1, ended_at = NOW() WHERE id = $2',
        ['completed', sessionId]
      );
    }
  } catch (err) {
    logError('Artifact extraction failed', err);
  } finally {
    await end();
  }

  process.exit(0);
}

async function extractArtifacts(sessionId) {
  // Get both user and assistant messages from this session
  // User messages contain personal facts, preferences, and callbacks
  // Assistant messages contain decisions, protocols, and technical knowledge
  const messages = await query(`
    SELECT id, role, content, turn_number, created_at
    FROM claude_memory.messages
    WHERE session_id = $1 AND role IN ('user', 'assistant')
    ORDER BY turn_number
  `, [sessionId]);

  if (messages.rows.length === 0) return;

  // Combine messages for context (limit to ~15000 chars for the API call)
  let combined = '';
  for (const m of messages.rows) {
    const entry = `[Turn ${m.turn_number} - ${m.role}] ${m.content}\n---\n`;
    if (combined.length + entry.length > 15000) break;
    combined += entry;
  }

  // Try local Qwen extraction first, fall back to Anthropic API
  let artifacts = await callLocalExtraction(combined);
  if (artifacts === null) {
    // Local extraction failed — fall back to Claude API
    if (ANTHROPIC_API_KEY) {
      artifacts = await callAnthropicExtraction(combined);
    } else {
      logError('Both local extraction and API unavailable');
      return;
    }
  }

  if (!artifacts || artifacts.length === 0) return;

  // Load embedder for novelty checking
  let embedder;
  try {
    embedder = require('./lib/embedder');
  } catch { /* no embedder — skip novelty check */ }

  // Process each artifact
  const insertedIds = [];
  for (const artifact of artifacts) {
    const { shouldInsert, existingId, mergeContent } = await noveltyCheck(artifact, embedder);

    if (!shouldInsert && !mergeContent) continue;

    if (mergeContent && existingId) {
      // Merge into existing artifact
      await query(`
        UPDATE claude_memory.artifacts
        SET content = content || E'\n---\n' || $1,
            salience = GREATEST(salience, $2),
            updated_at = NOW()
        WHERE id = $3
      `, [artifact.content, artifact.salience, existingId]);
      insertedIds.push(existingId);
    } else {
      // Insert new artifact
      let embedding = null;
      if (embedder) {
        try {
          embedding = await embedder.embed(artifact.title + ' ' + artifact.content);
        } catch { /* non-fatal */ }
      }
      const embStr = embedding ? `[${embedding.join(',')}]` : null;

      const result = await query(`
        INSERT INTO claude_memory.artifacts (session_id, artifact_type, title, content, salience, embedding, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::vector, NOW())
        RETURNING id
      `, [sessionId, artifact.type, artifact.title, artifact.content, artifact.salience, embStr]);

      const newId = result.rows[0].id;
      insertedIds.push(newId);

      // Insert semantic aliases if provided by LLM
      if (Array.isArray(artifact.semantic_terms)) {
        await insertSemanticAliases(newId, artifact.semantic_terms);
      }
    }
  }

  // Graph linking: identify relations between new and recent artifacts
  if (insertedIds.length > 0) {
    await linkArtifacts(insertedIds);
  }
}

/**
 * Call local Qwen3 4B via MLX for artifact extraction.
 * Returns array of artifacts on success, null on failure (triggers fallback).
 */
async function callLocalExtraction(text) {
  const { execFile } = require('child_process');
  const LOCAL_PYTHON = path.join(process.env.HOME, 'local-llm/.venv/bin/python3');
  const LOCAL_SCRIPT = path.join(process.env.HOME, 'local-llm/local-extract.py');

  if (!fs.existsSync(LOCAL_PYTHON) || !fs.existsSync(LOCAL_SCRIPT)) {
    return null; // Local setup not available
  }

  return new Promise((resolve) => {
    const child = execFile(LOCAL_PYTHON, [LOCAL_SCRIPT, '--text', text], {
      timeout: 120000, // 2 min timeout (model load + generation)
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (err, stdout, stderr) => {
      if (stderr) {
        // stderr has timing info, log it
        for (const line of stderr.split('\n')) {
          if (line.trim()) logError('local-extract', { message: line.trim() });
        }
      }
      if (err) {
        logError('Local extraction failed, will try API fallback', err);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (parseErr) {
        logError('Failed to parse local extraction output', parseErr);
        resolve(null);
      }
    });
  });
}

/**
 * Call local Qwen3 4B via MLX for artifact linking.
 * Returns array of relations on success, null on failure.
 */
async function callLocalLinking(newArtifacts, existingArtifacts) {
  const { execFile } = require('child_process');
  const LOCAL_PYTHON = path.join(process.env.HOME, 'local-llm/.venv/bin/python3');
  const LOCAL_SCRIPT = path.join(process.env.HOME, 'local-llm/local-link.py');

  if (!fs.existsSync(LOCAL_PYTHON) || !fs.existsSync(LOCAL_SCRIPT)) {
    return null;
  }

  const input = JSON.stringify({ new: newArtifacts, existing: existingArtifacts });

  return new Promise((resolve) => {
    const child = execFile(LOCAL_PYTHON, [LOCAL_SCRIPT], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve(null);
      }
    });

    // Send input via stdin
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Call Anthropic API to extract artifacts from session text (FALLBACK)
 */
async function callAnthropicExtraction(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `You extract structured knowledge artifacts from Claude Code session transcripts.
Return a JSON array of artifacts. Each artifact has:
- type: one of "decision", "error", "idea", "abandoned", "protocol", "knowledge", "preference", "task"
- title: concise title (max 80 chars)
- content: detailed description with context
- salience: 0.0-1.0 importance score (1.0 = critical decision that shapes future work, 0.1 = minor observation)
- semantic_terms: array of {term, canonical, category} for searchability (see below)

**semantic_terms** enables fuzzy search. For each meaningful noun, verb, or descriptor in the artifact, extract:
- term: the specific word used (e.g. "bluebird", "shoulder", "caterpillar")
- canonical: the general concept (e.g. "bird", "body_part", "insect")
- category: one of: animal, body_part, emotion, place, person, action, object, color, personal, metaphor, music, food, time

Examples:
- "bluebird on my shoulder" → [{term:"bluebird", canonical:"bird", category:"animal"}, {term:"shoulder", canonical:"body_part", category:"body_part"}]
- "feeling melancholy today" → [{term:"melancholy", canonical:"sadness", category:"emotion"}]
- "the red cardinal" → [{term:"cardinal", canonical:"bird", category:"animal"}, {term:"red", canonical:"red", category:"color"}]

Focus on:
- Architectural decisions and WHY they were made
- Bugs found and their root causes
- Patterns or protocols established
- User preferences expressed (favorite things, opinions, aesthetic choices)
- Personal facts, identity markers, and callbacks the user shares (e.g., "a bluebird is on my shoulder", "my dog's name is X", personal stories or declarations)
- Playful or emotional statements that the user would expect to be remembered
- Ideas proposed but not yet implemented
- Tasks abandoned and why
- Closing statements or declarations that carry personal significance

IMPORTANT: Pay close attention to USER messages — they contain personal facts and preferences that MUST be captured as "preference" or "knowledge" artifacts. If the user shares something personal, it matters to them and should be stored.

Skip: routine file edits, git operations, trivial changes, tool output. Return [] if nothing noteworthy.
Return ONLY the JSON array, no markdown fencing.`,
    messages: [{
      role: 'user',
      content: `Extract artifacts from this session:\n\n${text}`,
    }],
  });

  try {
    const content = response.content[0].text;
    // Try parsing as JSON, handle potential markdown fencing
    const cleaned = content.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logError('Failed to parse artifact extraction response', err);
    return [];
  }
}

/**
 * Novelty gate: check if artifact is too similar to existing ones
 * - >= 0.92 similarity → skip (duplicate)
 * - 0.82 - 0.91 → merge into existing
 * - < 0.82 → insert as new
 */
async function noveltyCheck(artifact, embedder) {
  if (!embedder) {
    return { shouldInsert: true, existingId: null, mergeContent: false };
  }

  let embedding;
  try {
    embedding = await embedder.embed(artifact.title + ' ' + artifact.content);
  } catch {
    return { shouldInsert: true, existingId: null, mergeContent: false };
  }

  const embStr = `[${embedding.join(',')}]`;

  // Find most similar existing artifact
  const similar = await query(`
    SELECT id, title, content, 1 - (embedding <=> $1::vector) AS similarity
    FROM claude_memory.artifacts
    WHERE status = 'active' AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT 1
  `, [embStr]);

  if (similar.rows.length === 0) {
    return { shouldInsert: true, existingId: null, mergeContent: false };
  }

  const sim = similar.rows[0].similarity;

  if (sim >= 0.92) {
    // Too similar — skip
    return { shouldInsert: false, existingId: null, mergeContent: false };
  }

  if (sim >= 0.82) {
    // Similar enough to merge
    return { shouldInsert: false, existingId: similar.rows[0].id, mergeContent: true };
  }

  // Novel enough — insert
  return { shouldInsert: true, existingId: null, mergeContent: false };
}

/**
 * Link artifacts: identify relations between newly inserted and recent artifacts
 */
async function linkArtifacts(newIds) {
  // Get new artifacts
  const newArtifacts = await query(`
    SELECT id, artifact_type, title, content FROM claude_memory.artifacts WHERE id = ANY($1)
  `, [newIds]);

  // Get recent artifacts (last 30) excluding new ones
  const recentArtifacts = await query(`
    SELECT id, artifact_type, title, content
    FROM claude_memory.artifacts
    WHERE status = 'active' AND id != ALL($1)
    ORDER BY created_at DESC
    LIMIT 30
  `, [newIds]);

  if (recentArtifacts.rows.length === 0) return;

  // Try local linking first
  const localRelations = await callLocalLinking(
    newArtifacts.rows.map(a => ({ id: a.id, artifact_type: a.artifact_type, title: a.title, content: a.content })),
    recentArtifacts.rows.map(a => ({ id: a.id, artifact_type: a.artifact_type, title: a.title, content: a.content }))
  );

  if (localRelations !== null) {
    // Local linking succeeded — insert relations
    const validTypes = ['caused_by', 'resolved_by', 'supersedes', 'relates_to', 'depends_on', 'contradicts'];
    for (const rel of localRelations) {
      if (!rel.from || !rel.to || !rel.type || !validTypes.includes(rel.type)) continue;
      await query(`
        INSERT INTO claude_memory.artifact_links (from_artifact_id, to_artifact_id, relation_type, confidence)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (from_artifact_id, to_artifact_id, relation_type) DO UPDATE
          SET confidence = GREATEST(claude_memory.artifact_links.confidence, $4)
      `, [rel.from, rel.to, rel.type, rel.confidence || 0.5]).catch(() => {});
    }
    return;
  }

  // Fallback to Anthropic API
  if (!ANTHROPIC_API_KEY) return;

  // Build context for LLM
  const newList = newArtifacts.rows.map(a => `[${a.id}] ${a.artifact_type}: ${a.title} — ${a.content.slice(0, 200)}`).join('\n');
  const existingList = recentArtifacts.rows.map(a => `[${a.id}] ${a.artifact_type}: ${a.title} — ${a.content.slice(0, 200)}`).join('\n');

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You identify relationships between knowledge artifacts.
Return a JSON array of relations: [{ "from": <id>, "to": <id>, "type": "<relation_type>", "confidence": 0.0-1.0 }]
Relation types: caused_by, resolved_by, supersedes, relates_to, depends_on, contradicts
Only include confident relations (>0.5). Return [] if no clear relations.
Return ONLY the JSON array, no markdown fencing.`,
      messages: [{
        role: 'user',
        content: `NEW ARTIFACTS:\n${newList}\n\nEXISTING ARTIFACTS:\n${existingList}\n\nIdentify relations between new and existing artifacts.`,
      }],
    });

    const content = response.content[0].text;
    const cleaned = content.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const relations = JSON.parse(cleaned);

    if (!Array.isArray(relations)) return;

    for (const rel of relations) {
      if (!rel.from || !rel.to || !rel.type) continue;
      const validTypes = ['caused_by', 'resolved_by', 'supersedes', 'relates_to', 'depends_on', 'contradicts'];
      if (!validTypes.includes(rel.type)) continue;

      await query(`
        INSERT INTO claude_memory.artifact_links (from_artifact_id, to_artifact_id, relation_type, confidence)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (from_artifact_id, to_artifact_id, relation_type) DO UPDATE
          SET confidence = GREATEST(claude_memory.artifact_links.confidence, $4)
      `, [rel.from, rel.to, rel.type, rel.confidence || 0.5]).catch(() => {
        // Ignore FK violations (artifact IDs might not exist)
      });
    }
  } catch (err) {
    logError('Artifact linking failed (non-fatal)', err);
  }
}

/**
 * Insert semantic aliases for an artifact.
 * Uses ON CONFLICT to avoid duplicates — if a term+canonical already exists,
 * just updates confidence to the max of old and new.
 */
async function insertSemanticAliases(artifactId, terms) {
  const validCategories = new Set([
    'animal', 'body_part', 'emotion', 'place', 'person', 'action',
    'object', 'color', 'personal', 'metaphor', 'music', 'food', 'time',
  ]);

  for (const t of terms) {
    if (!t.term || !t.canonical || !t.category) continue;
    const term = String(t.term).toLowerCase().trim();
    const canonical = String(t.canonical).toLowerCase().trim();
    const category = String(t.category).toLowerCase().trim();

    if (!term || !canonical || !validCategories.has(category)) continue;

    try {
      await query(`
        INSERT INTO claude_memory.semantic_aliases (term, canonical, category, source_artifact_id, confidence)
        VALUES ($1, $2, $3, $4, 0.8)
        ON CONFLICT (term, canonical) DO UPDATE
          SET confidence = GREATEST(claude_memory.semantic_aliases.confidence, 0.8),
              source_artifact_id = COALESCE(claude_memory.semantic_aliases.source_artifact_id, $4)
      `, [term, canonical, category, artifactId]);
    } catch (err) {
      // Non-fatal — skip invalid aliases
      logError(`Failed to insert alias "${term}" → "${canonical}"`, err);
    }
  }
}

async function getLatestSessionId() {
  const result = await query(
    'SELECT id FROM claude_memory.sessions ORDER BY started_at DESC LIMIT 1'
  );
  return result.rows[0]?.id || null;
}

function readStdinTimeout(timeoutMs) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => resolve(null), timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    process.stdin.resume();
  });
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

main();
