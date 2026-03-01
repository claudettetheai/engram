// memory_search_sessions — Hybrid BM25 + vector search over 244K messages
// Wraps retrieve-context.js hybridSearch() logic

import { query } from '../lib/db.js';
import { expandQuery, recordFeedback } from '../lib/query-expander.js';

interface SearchResult {
  source: string;
  content: string;
  session_id?: string;
  role?: string;
  created_at: string;
  score: number;
  artifact_type?: string;
  title?: string;
  salience?: number;
}

export async function searchSessions(searchQuery: string, limit: number = 15): Promise<SearchResult[]> {
  // Expand query using semantic aliases (redbird → bluebird, head → shoulder)
  const expansion = await expandQuery(searchQuery);

  // Use expanded query for BM25, fall back to basic if expansion returns null
  const tsQuery = expansion.expandedTsQuery || searchQuery
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(Boolean)
    .join(' & ');

  if (!tsQuery) {
    return [];
  }

  // BM25 search on messages via GIN index (using expanded query)
  const bm25Results = await query(`
    SELECT m.id, m.session_id, m.role, m.content, m.turn_number, m.created_at,
           ts_rank_cd(m.tsv, to_tsquery('english', $1)) AS rank
    FROM claude_memory.messages m
    WHERE m.tsv @@ to_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT $2
  `, [tsQuery, limit * 2]);

  // Also search with original (unexpanded) query for exact-match boost
  let exactBm25Results: any[] = [];
  if (expansion.originalTsQuery && expansion.originalTsQuery !== tsQuery) {
    try {
      const exactRes = await query(`
        SELECT m.id, m.session_id, m.role, m.content, m.turn_number, m.created_at,
               ts_rank_cd(m.tsv, to_tsquery('english', $1)) * 1.2 AS rank
        FROM claude_memory.messages m
        WHERE m.tsv @@ to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2
      `, [expansion.originalTsQuery, limit]);
      exactBm25Results = exactRes.rows;
    } catch {
      // Original query might fail if terms aren't valid tsquery — that's fine
    }
  }

  // Merge exact results into bm25 results (higher-ranked exact matches first)
  const allBm25 = [...exactBm25Results, ...bm25Results.rows];

  // Vector search on chunks via HNSW index (using query embedding)
  let vectorResults: any[] = [];
  try {
    const embedderPath = require.resolve('../../../lib/embedder.js');
    const embedder = require(embedderPath);
    const queryEmbedding = await embedder.embed(searchQuery);
    const embStr = `[${queryEmbedding.join(',')}]`;

    const vecRes = await query(`
      SELECT c.id, c.session_id, c.content, c.chunk_index, c.created_at,
             1 - (c.embedding <=> $1::vector) AS similarity
      FROM claude_memory.chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2
    `, [embStr, limit]);
    vectorResults = vecRes.rows;
  } catch {
    // Embedder not available — BM25-only mode
  }

  // Artifact search (using expanded query)
  const artifactResults = await query(`
    SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.created_at,
           ts_rank_cd(to_tsvector('english', a.title || ' ' || a.content), to_tsquery('english', $1)) AS rank
    FROM claude_memory.artifacts a
    WHERE to_tsvector('english', a.title || ' ' || a.content) @@ to_tsquery('english', $1)
      AND a.status = 'active'
    ORDER BY rank DESC
    LIMIT 10
  `, [tsQuery]);

  // Merge and score — port of scorer.js logic
  const scored = mergeAndScore(allBm25, vectorResults, artifactResults.rows);

  // Update access counts for retrieved artifacts
  if (artifactResults.rows.length > 0) {
    const ids = artifactResults.rows.map((a: any) => a.id);
    await query(`
      UPDATE claude_memory.artifacts
      SET access_count = access_count + 1, last_accessed = NOW()
      WHERE id = ANY($1)
    `, [ids]);
  }

  const results = scored.slice(0, limit);

  // Record search feedback for confidence tuning (non-blocking)
  if (expansion.expansions.length > 0) {
    recordFeedback(
      searchQuery,
      expansion.expandedTsQuery,
      expansion.expansions,
      results.length,
      'sessions'
    ).catch(() => {});
  }

  return results;
}

function mergeAndScore(bm25: any[], vector: any[], artifacts: any[]): SearchResult[] {
  const W_RELEVANCE = 0.50;
  const W_SALIENCE = 0.30;
  const W_RECENCY = 0.20;
  const W_VECTOR = 0.70;
  const W_BM25 = 0.30;
  const HALF_LIFE_DAYS = 30;

  const scored = new Map<string, any>();

  // Normalize BM25 scores
  const maxBM25 = Math.max(...bm25.map(r => r.rank || 0), 0.001);

  for (const r of bm25) {
    const key = `${r.session_id}-${(r.content || '').slice(0, 100)}`;
    const existing = scored.get(key) || { ...r, source: 'message', bm25Score: 0, vectorScore: 0 };
    existing.bm25Score = (r.rank || 0) / maxBM25;
    scored.set(key, existing);
  }

  for (const r of vector) {
    const key = `${r.session_id}-${(r.content || '').slice(0, 100)}`;
    const existing = scored.get(key) || { ...r, source: 'chunk', bm25Score: 0, vectorScore: 0 };
    existing.vectorScore = r.similarity || 0;
    scored.set(key, existing);
  }

  for (const a of artifacts) {
    const maxArtRank = Math.max(...artifacts.map((x: any) => x.rank || 0), 0.001);
    scored.set(`artifact-${a.id}`, {
      ...a,
      source: 'artifact',
      bm25Score: (a.rank || 0) / maxArtRank,
      vectorScore: 0,
      salience: a.salience || 0.5,
    });
  }

  const now = Date.now();
  const results: SearchResult[] = [];

  for (const [, item] of scored) {
    const relevance = (item.vectorScore || 0) * W_VECTOR + (item.bm25Score || 0) * W_BM25;
    const salience = item.salience || 0.5;

    const ageMs = now - new Date(item.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

    const score = relevance * W_RELEVANCE + salience * W_SALIENCE + recency * W_RECENCY;

    results.push({
      source: item.source || 'message',
      content: (item.content || '').slice(0, 1000),
      session_id: item.session_id,
      role: item.role,
      created_at: item.created_at,
      score: Math.round(score * 1000) / 1000,
      artifact_type: item.artifact_type,
      title: item.title,
      salience: item.salience,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export const searchSessionsTool = {
  name: 'memory_search_sessions',
  description: 'Hybrid BM25 + vector search across 244K+ archived messages and knowledge artifacts. Use this to find past conversations, decisions, errors, and context from previous sessions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query — natural language or keywords. Examples: "feed dedup fix", "docker build error", "sparks balance bug"',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default: 15, max: 50)',
      },
    },
    required: ['query'],
  },
};
