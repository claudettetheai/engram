#!/usr/bin/env node

/**
 * Search & Retrieve Example
 *
 * Demonstrates how to query Engram's memory database directly
 * (without the MCP server) for custom integrations.
 *
 * Run: DATABASE_URL="postgresql://..." node examples/search-and-retrieve.js "your query"
 */

const { query, end } = require('../lib/db');
const { chunkText } = require('../lib/chunker');
const { scoreResults, recencyDecay } = require('../lib/scorer');

async function searchMemories(searchQuery) {
  console.log(`\nSearching for: "${searchQuery}"\n`);

  // 1. BM25 keyword search using PostgreSQL full-text search
  console.log('--- BM25 Keyword Search ---');
  const tsQuery = searchQuery.split(/\s+/).filter(w => w.length > 2).join(' & ');

  const bm25Results = await query(`
    SELECT m.content, m.role, m.session_id, m.created_at,
           ts_rank(m.tsv, to_tsquery('english', $1)) AS rank
    FROM claude_memory.messages m
    WHERE m.tsv @@ to_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT 10
  `, [tsQuery]);

  console.log(`  Found ${bm25Results.rows.length} keyword matches`);

  // 2. Get active artifacts (decisions, knowledge, errors)
  console.log('\n--- Knowledge Graph Artifacts ---');
  const artifacts = await query(`
    SELECT id, artifact_type, title, content, salience, access_count, created_at,
           ts_rank(to_tsvector('english', title || ' ' || content),
                   to_tsquery('english', $1)) AS rank
    FROM claude_memory.artifacts
    WHERE status = 'active'
      AND to_tsvector('english', title || ' ' || content) @@ to_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT 5
  `, [tsQuery]);

  console.log(`  Found ${artifacts.rows.length} relevant artifacts`);
  for (const a of artifacts.rows) {
    console.log(`  [${a.artifact_type}] ${a.title} (salience: ${a.salience})`);
  }

  // 3. Hybrid scoring
  console.log('\n--- Hybrid Scored Results ---');
  const scored = scoreResults({
    bm25: bm25Results.rows,
    artifacts: artifacts.rows,
  });

  for (const r of scored.slice(0, 5)) {
    const preview = (r.content || r.title || '').slice(0, 80).replace(/\n/g, ' ');
    console.log(`  ${r.compositeScore.toFixed(3)} [${r.source}] ${preview}`);
  }

  // 4. Session stats
  console.log('\n--- Memory Stats ---');
  const stats = await query(`
    SELECT
      (SELECT COUNT(*) FROM claude_memory.sessions) AS total_sessions,
      (SELECT COUNT(*) FROM claude_memory.messages) AS total_messages,
      (SELECT COUNT(*) FROM claude_memory.chunks) AS total_chunks,
      (SELECT COUNT(*) FROM claude_memory.artifacts WHERE status = 'active') AS active_artifacts
  `);

  const s = stats.rows[0];
  console.log(`  Sessions: ${s.total_sessions}`);
  console.log(`  Messages: ${s.total_messages}`);
  console.log(`  Chunks: ${s.total_chunks}`);
  console.log(`  Active artifacts: ${s.active_artifacts}`);

  await end();
}

const searchQuery = process.argv[2] || 'database architecture decision';
searchMemories(searchQuery).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
