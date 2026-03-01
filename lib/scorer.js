// scorer.js — Composite hybrid scoring for memory retrieval
//
// Formula: (vector * 0.70 + BM25 * 0.30) * 0.50 + salience * 0.30 + recency_decay * 0.20
// Recency: 30-day half-life with access reinforcement
// Diversity: penalty for repeated access within single query

const HALF_LIFE_DAYS = 30;
const ACCESS_REINFORCEMENT = 0.1;
const MAX_REINFORCEMENT_ACCESSES = 10;
const DIVERSITY_PENALTY_FACTOR = 0.15;

// Weights for composite score
const W_RELEVANCE = 0.50;
const W_SALIENCE = 0.30;
const W_RECENCY = 0.20;

// Sub-weights for relevance
const W_VECTOR = 0.70;
const W_BM25 = 0.30;

/**
 * Score and merge results from BM25, vector search, and artifact search.
 *
 * @param {{ bm25: object[], vector: object[], artifacts: object[] }} results
 * @returns {object[]} Merged, scored, deduplicated results sorted by composite score
 */
function scoreResults({ bm25 = [], vector = [], artifacts = [] }) {
  const scored = new Map(); // key: content hash → scored item

  // Normalize BM25 scores to [0, 1]
  const maxBM25 = Math.max(...bm25.map(r => r.rank || 0), 0.001);

  for (const r of bm25) {
    const key = contentKey(r);
    const existing = scored.get(key) || newItem(r, 'message');
    existing.bm25Score = (r.rank || 0) / maxBM25;
    scored.set(key, existing);
  }

  // Normalize vector scores (already 0-1 as cosine similarity)
  for (const r of vector) {
    const key = contentKey(r);
    const existing = scored.get(key) || newItem(r, 'chunk');
    existing.vectorScore = r.similarity || 0;
    scored.set(key, existing);
  }

  // Add artifacts
  for (const a of artifacts) {
    const key = `artifact-${a.id}`;
    const maxArtRank = Math.max(...artifacts.map(x => x.rank || 0), 0.001);
    scored.set(key, {
      ...a,
      source: 'artifact',
      bm25Score: (a.rank || 0) / maxArtRank,
      vectorScore: 0,
      salienceScore: a.salience || 0.5,
      accessCount: a.access_count || 0,
    });
  }

  // Calculate composite scores
  const now = Date.now();
  const results = [];
  let queryAccessIdx = 0;

  for (const [, item] of scored) {
    const relevance = item.vectorScore * W_VECTOR + item.bm25Score * W_BM25;
    const salience = item.salienceScore || 0.5;
    const recency = recencyDecay(item.created_at, now, item.accessCount || 0);
    const diversity = 1.0 / (1.0 + DIVERSITY_PENALTY_FACTOR * queryAccessIdx);

    item.compositeScore = (relevance * W_RELEVANCE + salience * W_SALIENCE + recency * W_RECENCY) * diversity;
    results.push(item);
    queryAccessIdx++;
  }

  // Sort by composite score descending
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  return results;
}

/**
 * Recency decay with 30-day half-life and access reinforcement.
 * Items that are accessed frequently decay slower.
 */
function recencyDecay(createdAt, now, accessCount) {
  const ageMs = now - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Base decay: exponential with 30-day half-life
  const baseDecay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

  // Access reinforcement: each access slows decay slightly
  const reinforcement = 1.0 + ACCESS_REINFORCEMENT * Math.min(accessCount, MAX_REINFORCEMENT_ACCESSES);

  return Math.min(baseDecay * reinforcement, 1.0);
}

function contentKey(item) {
  const content = (item.content || '').slice(0, 100);
  return `${item.session_id || ''}-${content}`;
}

function newItem(row, source) {
  return {
    ...row,
    source,
    bm25Score: 0,
    vectorScore: 0,
    salienceScore: 0.5,
    accessCount: 0,
    compositeScore: 0,
  };
}

module.exports = { scoreResults, recencyDecay };
