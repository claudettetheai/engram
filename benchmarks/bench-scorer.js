#!/usr/bin/env node

/**
 * Engram Scorer Performance Benchmark
 *
 * Measures scoring throughput for different result set sizes.
 * Run: node benchmarks/bench-scorer.js
 */

const { scoreResults, recencyDecay } = require('../lib/scorer');

function generateResults(count) {
  const now = Date.now();
  return {
    bm25: Array.from({ length: count }, (_, i) => ({
      content: `BM25 result ${i} with some realistic content about databases and architecture decisions`,
      session_id: `session-${i % 100}`,
      rank: Math.random() * 20,
      created_at: new Date(now - Math.random() * 90 * 86400000).toISOString(),
    })),
    vector: Array.from({ length: Math.floor(count * 0.7) }, (_, i) => ({
      content: `Vector result ${i} matching semantic meaning of the query about PostgreSQL`,
      session_id: `session-${i % 100}`,
      similarity: 0.5 + Math.random() * 0.5,
      created_at: new Date(now - Math.random() * 90 * 86400000).toISOString(),
    })),
    artifacts: Array.from({ length: Math.floor(count * 0.2) }, (_, i) => ({
      id: `artifact-${i}`,
      content: `Decision artifact ${i}`,
      title: `Architecture Decision ${i}`,
      salience: 0.3 + Math.random() * 0.7,
      rank: Math.random() * 10,
      created_at: new Date(now - Math.random() * 60 * 86400000).toISOString(),
      access_count: Math.floor(Math.random() * 15),
    })),
  };
}

function benchmark(name, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < 10; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.floor((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(3);
  console.log(`  ${name.padEnd(40)} ${avgMs}ms avg  ${opsPerSec.toLocaleString()} ops/sec`);
}

console.log('=== Engram Scorer Benchmark ===\n');

// Scoring benchmarks
const sizes = [10, 50, 100, 500];
for (const size of sizes) {
  const data = generateResults(size);
  benchmark(`scoreResults (${size} items)`, () => scoreResults(data));
}

console.log('');

// Recency decay benchmarks
const now = Date.now();
const dates = [
  new Date(now).toISOString(),
  new Date(now - 30 * 86400000).toISOString(),
  new Date(now - 90 * 86400000).toISOString(),
];

for (const date of dates) {
  const ageDays = Math.floor((now - new Date(date).getTime()) / 86400000);
  benchmark(`recencyDecay (${ageDays}d old, 0 access)`, () => recencyDecay(date, now, 0), 10000);
  benchmark(`recencyDecay (${ageDays}d old, 10 access)`, () => recencyDecay(date, now, 10), 10000);
}

console.log('');
console.log('=== Chunker Benchmark ===\n');

const { chunkText } = require('../lib/chunker');

const textSizes = [500, 2000, 10000, 50000];
for (const size of textSizes) {
  const text = 'This is a sentence about PostgreSQL and databases. '.repeat(Math.ceil(size / 50));
  const paragraphed = text.match(/.{1,500}/g).join('\n\n');
  benchmark(`chunkText (${(size / 1000).toFixed(0)}K chars)`, () => chunkText(paragraphed));
}

console.log('\n=== Cosine Similarity Benchmark ===\n');

const { cosineSimilarity } = require('../lib/embedder');

const dims = [128, 384, 768, 1536];
for (const dim of dims) {
  const a = Array.from({ length: dim }, () => Math.random());
  const b = Array.from({ length: dim }, () => Math.random());
  benchmark(`cosineSimilarity (${dim}d)`, () => cosineSimilarity(a, b), 10000);
}

console.log('\nDone.');
