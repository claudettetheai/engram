#!/usr/bin/env node
// retrieve-context.js — Session-start context retrieval
//
// Usage:
//   node retrieve-context.js                    → last 5 session summaries + active artifacts
//   node retrieve-context.js --query "docker"   → BM25/hybrid search across messages + artifacts
//   node retrieve-context.js --sessions 10      → last 10 sessions
//   node retrieve-context.js --artifacts        → show all active artifacts

const { query, end, logError } = require('./lib/db');

const args = process.argv.slice(2);
const queryText = getArg('--query') || getArg('-q');
const sessionCount = parseInt(getArg('--sessions') || '5', 10);
const showArtifacts = args.includes('--artifacts');

async function main() {
  try {
    if (queryText) {
      await hybridSearch(queryText);
    } else if (showArtifacts) {
      await listArtifacts();
    } else {
      await recentContext(sessionCount);
    }
  } catch (err) {
    logError('Retrieval failed', err);
    console.error('Memory retrieval failed:', err.message);
  } finally {
    await end();
  }
}

/**
 * Default: show recent session summaries + active high-salience artifacts
 */
async function recentContext(limit) {
  console.log('# Claude Memory — Session Context\n');

  // Recent sessions with message counts
  const sessions = await query(`
    SELECT s.id, s.started_at, s.ended_at, s.turn_count, s.summary, s.status,
           COUNT(m.id) AS message_count,
           MIN(m.created_at) AS first_message,
           MAX(m.created_at) AS last_message
    FROM claude_memory.sessions s
    LEFT JOIN claude_memory.messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT $1
  `, [limit]);

  if (sessions.rows.length === 0) {
    console.log('No sessions archived yet.\n');
  } else {
    console.log('## Recent Sessions\n');
    for (const s of sessions.rows) {
      const date = new Date(s.started_at).toISOString().split('T')[0];
      const time = new Date(s.started_at).toISOString().split('T')[1].slice(0, 5);
      const status = s.status === 'active' ? ' (active)' : '';
      console.log(`### ${date} ${time}${status}`);
      console.log(`- Session: \`${s.id.slice(0, 8)}...\``);
      console.log(`- Turns: ${s.turn_count} | Messages: ${s.message_count}`);
      if (s.summary) {
        console.log(`- Summary: ${s.summary}`);
      }
      console.log();
    }

    // Show last few messages from most recent session for continuity
    const latestSession = sessions.rows[0];
    const recentMsgs = await query(`
      SELECT role, content, turn_number, created_at
      FROM claude_memory.messages
      WHERE session_id = $1
      ORDER BY id DESC
      LIMIT 6
    `, [latestSession.id]);

    if (recentMsgs.rows.length > 0) {
      console.log('## Last Session Messages (most recent first)\n');
      for (const m of recentMsgs.rows.reverse()) {
        const role = m.role.toUpperCase().padEnd(10);
        const preview = m.content.slice(0, 200).replace(/\n/g, ' ');
        console.log(`[${role}] ${preview}${m.content.length > 200 ? '...' : ''}`);
      }
      console.log();
    }
  }

  // Active artifacts
  const artifacts = await query(`
    SELECT id, artifact_type, title, content, salience, created_at
    FROM claude_memory.artifacts
    WHERE status = 'active'
    ORDER BY salience DESC, created_at DESC
    LIMIT 10
  `);

  if (artifacts.rows.length > 0) {
    console.log('## Active Artifacts\n');
    for (const a of artifacts.rows) {
      const icon = ARTIFACT_ICONS[a.artifact_type] || '>';
      console.log(`${icon} **${a.title}** (${a.artifact_type}, salience: ${a.salience})`);
      console.log(`  ${a.content.slice(0, 300).replace(/\n/g, '\n  ')}`);
      console.log();
    }
  }
}

/**
 * BM25 keyword search, with optional hybrid vector search when embedder is available
 */
async function hybridSearch(searchQuery) {
  console.log(`# Memory Search: "${searchQuery}"\n`);

  let scorer;
  let embedder;
  let queryEmbedding = null;

  try {
    scorer = require('./lib/scorer');
    embedder = require('./lib/embedder');
    queryEmbedding = await embedder.embed(searchQuery);
  } catch {
    // Fall back to BM25 only
  }

  // BM25 search on messages
  const tsQuery = searchQuery
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(Boolean)
    .join(' & ');

  if (!tsQuery) {
    console.log('No valid search terms.\n');
    return;
  }

  const bm25Results = await query(`
    SELECT m.id, m.session_id, m.role, m.content, m.turn_number, m.created_at,
           ts_rank_cd(m.tsv, to_tsquery('english', $1)) AS rank
    FROM claude_memory.messages m
    WHERE m.tsv @@ to_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT 20
  `, [tsQuery]);

  // Vector search on chunks (if embedding available)
  let vectorResults = [];
  if (queryEmbedding) {
    const embStr = `[${queryEmbedding.join(',')}]`;
    const vecRes = await query(`
      SELECT c.id, c.session_id, c.content, c.chunk_index, c.created_at,
             1 - (c.embedding <=> $1::vector) AS similarity
      FROM claude_memory.chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT 20
    `, [embStr]);
    vectorResults = vecRes.rows;
  }

  // Artifact search
  const artifactResults = await query(`
    SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.created_at,
           ts_rank_cd(to_tsvector('english', a.title || ' ' || a.content), to_tsquery('english', $1)) AS rank
    FROM claude_memory.artifacts a
    WHERE to_tsvector('english', a.title || ' ' || a.content) @@ to_tsquery('english', $1)
      AND a.status = 'active'
    ORDER BY rank DESC
    LIMIT 10
  `, [tsQuery]);

  // Combine and score results
  if (scorer && queryEmbedding) {
    const scored = scorer.scoreResults({
      bm25: bm25Results.rows,
      vector: vectorResults,
      artifacts: artifactResults.rows,
    });
    printScoredResults(scored);
  } else {
    // BM25-only output
    printBM25Results(bm25Results.rows, artifactResults.rows);
  }

  // Update access counts for retrieved artifacts
  if (artifactResults.rows.length > 0) {
    const ids = artifactResults.rows.map(a => a.id);
    await query(`
      UPDATE claude_memory.artifacts
      SET access_count = access_count + 1, last_accessed = NOW()
      WHERE id = ANY($1)
    `, [ids]);
  }
}

function printBM25Results(messages, artifacts) {
  if (messages.length === 0 && artifacts.length === 0) {
    console.log('No results found.\n');
    return;
  }

  if (messages.length > 0) {
    console.log(`## Messages (${messages.length} results)\n`);
    for (const m of messages) {
      const date = new Date(m.created_at).toISOString().split('T')[0];
      const role = m.role.toUpperCase();
      const preview = m.content.slice(0, 300).replace(/\n/g, ' ');
      console.log(`**[${date}] ${role}** (session: ${m.session_id.slice(0, 8)}, rank: ${m.rank.toFixed(3)})`);
      console.log(`${preview}${m.content.length > 300 ? '...' : ''}\n`);
    }
  }

  if (artifacts.length > 0) {
    console.log(`## Artifacts (${artifacts.length} results)\n`);
    for (const a of artifacts) {
      const icon = ARTIFACT_ICONS[a.artifact_type] || '>';
      console.log(`${icon} **${a.title}** (${a.artifact_type}, salience: ${a.salience}, rank: ${a.rank.toFixed(3)})`);
      console.log(`  ${a.content.slice(0, 300).replace(/\n/g, '\n  ')}\n`);
    }
  }
}

function printScoredResults(scored) {
  if (scored.length === 0) {
    console.log('No results found.\n');
    return;
  }

  console.log(`## Results (${scored.length} items, hybrid scored)\n`);
  for (const item of scored.slice(0, 15)) {
    const date = new Date(item.created_at).toISOString().split('T')[0];
    const source = item.source || 'message';
    const score = item.compositeScore.toFixed(3);
    const preview = item.content.slice(0, 300).replace(/\n/g, ' ');

    if (source === 'artifact') {
      const icon = ARTIFACT_ICONS[item.artifact_type] || '>';
      console.log(`${icon} **${item.title}** (artifact, score: ${score})`);
    } else {
      console.log(`**[${date}] ${(item.role || 'MSG').toUpperCase()}** (score: ${score})`);
    }
    console.log(`${preview}${item.content.length > 300 ? '...' : ''}\n`);
  }
}

async function listArtifacts() {
  console.log('# Active Artifacts\n');
  const result = await query(`
    SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.status,
           a.access_count, a.created_at, a.updated_at,
           s.started_at AS session_date
    FROM claude_memory.artifacts a
    LEFT JOIN claude_memory.sessions s ON s.id = a.session_id
    WHERE a.status = 'active'
    ORDER BY a.salience DESC, a.created_at DESC
    LIMIT 200
  `);

  if (result.rows.length === 0) {
    console.log('No active artifacts.\n');
    return;
  }

  for (const a of result.rows) {
    const icon = ARTIFACT_ICONS[a.artifact_type] || '>';
    const date = new Date(a.created_at).toISOString().split('T')[0];
    console.log(`${icon} **${a.title}**`);
    console.log(`  Type: ${a.artifact_type} | Salience: ${a.salience} | Accessed: ${a.access_count}x | Date: ${date}`);
    console.log(`  ${a.content.replace(/\n/g, '\n  ')}\n`);
  }
}

const ARTIFACT_ICONS = {
  decision: '[D]',
  error: '[E]',
  idea: '[I]',
  abandoned: '[X]',
  protocol: '[P]',
  knowledge: '[K]',
  preference: '[*]',
  task: '[T]',
};

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

main();
