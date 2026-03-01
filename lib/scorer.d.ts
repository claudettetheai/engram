export interface SearchInput {
  content?: string;
  session_id?: string;
  rank?: number;
  similarity?: number;
  created_at?: string;
  id?: string;
  salience?: number;
  access_count?: number;
  [key: string]: unknown;
}

export interface ScoredResult extends SearchInput {
  source: 'message' | 'chunk' | 'artifact';
  bm25Score: number;
  vectorScore: number;
  salienceScore: number;
  accessCount: number;
  compositeScore: number;
}

/**
 * Score and merge results from BM25, vector search, and artifact search.
 * Returns merged, scored, deduplicated results sorted by composite score.
 */
export function scoreResults(results: {
  bm25?: SearchInput[];
  vector?: SearchInput[];
  artifacts?: SearchInput[];
}): ScoredResult[];

/**
 * Calculate recency decay with 30-day half-life and access reinforcement.
 * Items accessed frequently decay slower.
 *
 * @param createdAt - ISO date string or Date
 * @param now - Current timestamp in milliseconds
 * @param accessCount - Number of times this item has been accessed
 * @returns Decay score between 0 and 1
 */
export function recencyDecay(
  createdAt: string | Date,
  now: number,
  accessCount: number
): number;
