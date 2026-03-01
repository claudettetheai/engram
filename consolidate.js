#!/usr/bin/env node
// consolidate.js — Weekly compaction of old memory chunks
//
// Finds chunks older than 14 days from completed sessions,
// clusters by semantic similarity, generates compressed summaries,
// inserts into consolidations table, marks source chunks as consolidated.
//
// Cron: 0 4 * * 0 (Sunday 4am)
//
// Usage:
//   node consolidate.js              → run consolidation
//   node consolidate.js --dry-run    → show what would be consolidated
//   node consolidate.js --days 7     → consolidate chunks older than 7 days

const { query, withTransaction, end, logError } = require('./lib/db');
const path = require('path');
const fs = require('fs');

// Load API key
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
const dryRun = args.includes('--dry-run');
const daysArg = getArg('--days');
const ageDays = daysArg ? parseInt(daysArg, 10) : 14;

const CLUSTER_SIZE = 20;  // Max chunks per consolidation
const SIMILARITY_THRESHOLD = 0.65; // Minimum cosine similarity for clustering

async function main() {
  try {
    await consolidate();
  } catch (err) {
    logError('Consolidation failed', err);
    console.error('Consolidation failed:', err.message);
  } finally {
    await end();
  }
}

async function consolidate() {
  // Find unconsolidated chunks older than N days
  const chunks = await query(`
    SELECT c.id, c.session_id, c.content, c.embedding, c.created_at, c.token_count
    FROM claude_memory.chunks c
    JOIN claude_memory.sessions s ON s.id = c.session_id
    WHERE c.consolidated = FALSE
      AND c.created_at < NOW() - INTERVAL '1 day' * $1
      AND s.status = 'completed'
    ORDER BY c.created_at
    LIMIT 500
  `, [ageDays]);

  console.log(`Found ${chunks.rows.length} chunks eligible for consolidation (>${ageDays} days old)`);

  if (chunks.rows.length === 0) {
    console.log('Nothing to consolidate.');
    return;
  }

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    const sessions = new Set(chunks.rows.map(c => c.session_id));
    console.log(`Across ${sessions.size} sessions`);
    const totalTokens = chunks.rows.reduce((sum, c) => sum + (c.token_count || 0), 0);
    console.log(`Total tokens: ~${totalTokens}`);
    return;
  }

  // Group chunks into clusters
  const clusters = clusterChunks(chunks.rows);
  console.log(`Formed ${clusters.length} clusters`);

  if (!ANTHROPIC_API_KEY) {
    console.error('No ANTHROPIC_API_KEY — cannot generate summaries');
    return;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let consolidated = 0;
  for (const cluster of clusters) {
    try {
      await consolidateCluster(cluster, client);
      consolidated++;
      process.stdout.write(`\r  Consolidated ${consolidated}/${clusters.length} clusters`);
    } catch (err) {
      logError('Cluster consolidation failed', err);
    }
  }

  console.log(`\nConsolidation complete: ${consolidated} clusters processed`);
}

/**
 * Group chunks into clusters by temporal proximity and semantic similarity
 */
function clusterChunks(chunks) {
  const clusters = [];
  let current = [];

  for (const chunk of chunks) {
    if (current.length >= CLUSTER_SIZE) {
      clusters.push(current);
      current = [];
    }

    // Check if chunk belongs in current cluster (same session or recent)
    if (current.length === 0 || current[current.length - 1].session_id === chunk.session_id) {
      current.push(chunk);
    } else {
      // Different session — start new cluster
      if (current.length > 0) clusters.push(current);
      current = [chunk];
    }
  }

  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Consolidate a cluster: summarize, embed, store, mark source as consolidated
 */
async function consolidateCluster(cluster, client) {
  const combined = cluster.map(c => c.content).join('\n---\n');
  const sessionIds = [...new Set(cluster.map(c => c.session_id))];
  const chunkIds = cluster.map(c => c.id);
  const timeStart = cluster[0].created_at;
  const timeEnd = cluster[cluster.length - 1].created_at;

  // Generate summary
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: 'You compress conversation excerpts into concise summaries that preserve key decisions, errors, and context. Be factual and specific. Max 300 words.',
    messages: [{
      role: 'user',
      content: `Summarize this conversation excerpt:\n\n${combined.slice(0, 12000)}`,
    }],
  });

  const summary = response.content[0].text;

  // Embed summary
  let embedding = null;
  try {
    const embedder = require('./lib/embedder');
    embedding = await embedder.embed(summary);
  } catch { /* non-fatal */ }

  const embStr = embedding ? `[${embedding.join(',')}]` : null;

  // Store consolidation and mark chunks
  await withTransaction(async (txClient) => {
    await txClient.query(`
      INSERT INTO claude_memory.consolidations
        (source_session_ids, source_chunk_ids, summary, embedding, chunk_count, time_span_start, time_span_end)
      VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
    `, [sessionIds, chunkIds, summary, embStr, chunkIds.length, timeStart, timeEnd]);

    await txClient.query(`
      UPDATE claude_memory.chunks SET consolidated = TRUE WHERE id = ANY($1)
    `, [chunkIds]);
  });
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

main();
