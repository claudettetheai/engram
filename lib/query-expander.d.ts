export interface ExpansionDetail {
  matchedAlias: string;
  canonical: string;
  category: string;
  matchType: 'exact' | 'fuzzy';
  similarity: number;
  siblings: string[];
}

export interface Expansion {
  word: string;
  matchType: 'exact' | 'fuzzy';
  details: ExpansionDetail[];
  expandedTo: string[];
}

export interface ExpandedQuery {
  /** Expanded tsquery string with OR groups, or null if no significant words */
  expandedTsQuery: string | null;
  /** Original tsquery string (unexpanded), or null */
  originalTsQuery: string | null;
  /** Details of each expansion performed */
  expansions: Expansion[];
}

/**
 * Expand a search query using semantic aliases from the database.
 * Performs exact match then fuzzy trigram matching for each word.
 *
 * @param searchQuery - Raw natural language search query
 * @returns Expanded query with OR groups and expansion details
 */
export function expandQuery(searchQuery: string): Promise<ExpandedQuery>;

/**
 * Record search feedback for automatic confidence tuning.
 * Boosts alias confidence when expansions find results, weakens when they don't.
 */
export function recordFeedback(
  originalQuery: string,
  expandedQuery: string | null,
  expansions: Expansion[],
  resultCount: number,
  searchTool: 'sessions' | 'knowledge'
): Promise<void>;

/** Set of English stop words that are filtered from queries */
export const STOP_WORDS: Set<string>;
