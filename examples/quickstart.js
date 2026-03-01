#!/usr/bin/env node

/**
 * Engram Quickstart
 *
 * Run: DATABASE_URL="postgresql://..." node examples/quickstart.js
 *
 * This demonstrates core Engram features in under 50 lines:
 * - Text chunking for embedding
 * - Cosine similarity between vectors
 * - Hybrid scoring with recency decay
 * - Query word extraction (stop word filtering)
 */

const { chunkText } = require('../lib/chunker');
const { cosineSimilarity } = require('../lib/embedder');
const { scoreResults, recencyDecay } = require('../lib/scorer');
const { STOP_WORDS } = require('../lib/query-expander');

// --- 1. Chunking: Split long text into embeddable segments ---
console.log('=== Text Chunking ===');
const longText = `
Engram is a memory system for AI agents. It uses hybrid search
combining BM25 keyword matching with vector semantic search.

The knowledge graph connects decisions to their consequences.
Every artifact links to related artifacts through typed edges:
caused_by, resolved_by, supersedes, contradicts.

Lifecycle hooks automatically save memories at key moments:
when you stop talking, when a session ends, before context
gets wiped, and before context gets compressed.
`.trim();

const chunks = chunkText(longText);
console.log(`Input: ${longText.length} chars → ${chunks.length} chunk(s)`);
chunks.forEach((c, i) => console.log(`  Chunk ${i + 1}: ${c.length} chars — "${c.slice(0, 60)}..."`));

// --- 2. Cosine Similarity: Compare vectors ---
console.log('\n=== Cosine Similarity ===');
const vecA = [0.8, 0.2, 0.5, 0.1, 0.9];
const vecB = [0.7, 0.3, 0.4, 0.2, 0.8];
const vecC = [0.1, 0.9, 0.1, 0.8, 0.1]; // very different
console.log(`Similar vectors:  ${cosineSimilarity(vecA, vecB).toFixed(4)}`);
console.log(`Different vectors: ${cosineSimilarity(vecA, vecC).toFixed(4)}`);

// --- 3. Recency Decay: How memories fade (and get reinforced) ---
console.log('\n=== Recency Decay (30-day half-life) ===');
const now = Date.now();
const ages = [0, 7, 30, 60, 90];
for (const days of ages) {
  const date = new Date(now - days * 86400000).toISOString();
  const noAccess = recencyDecay(date, now, 0);
  const withAccess = recencyDecay(date, now, 5);
  console.log(`  ${String(days).padStart(2)}d old: ${noAccess.toFixed(3)} (untouched) → ${withAccess.toFixed(3)} (accessed 5×)`);
}

// --- 4. Hybrid Scoring: Merge BM25 + vector results ---
console.log('\n=== Hybrid Scoring ===');
const results = scoreResults({
  bm25: [
    { content: 'PostgreSQL is the database', session_id: 's1', rank: 10, created_at: new Date().toISOString() },
    { content: 'Redis was considered but rejected', session_id: 's2', rank: 3, created_at: new Date(now - 30 * 86400000).toISOString() },
  ],
  vector: [
    { content: 'PostgreSQL is the database', session_id: 's1', similarity: 0.92, created_at: new Date().toISOString() },
  ],
  artifacts: [
    { id: 'a1', content: 'Chose PostgreSQL over Redis', title: 'DB Decision', salience: 0.9, rank: 5, created_at: new Date().toISOString() },
  ],
});

console.log('Ranked results:');
results.forEach((r, i) => {
  console.log(`  ${i + 1}. [${r.source}] score=${r.compositeScore.toFixed(3)} — "${r.content?.slice(0, 50)}"`);
});

// --- 5. Query Processing: Stop word filtering ---
console.log('\n=== Query Processing ===');
const query = 'what database did we choose for the project last week';
const words = query.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
console.log(`Query: "${query}"`);
console.log(`After stop words: [${words.join(', ')}]`);
console.log(`Removed: [${query.split(/\s+/).filter(w => STOP_WORDS.has(w)).join(', ')}]`);

console.log('\n✓ Engram core features working. Now wire it up to your AI agent!');
