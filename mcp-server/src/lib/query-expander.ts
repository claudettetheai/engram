// query-expander.ts — Semantic alias expansion for memory search (MCP server port)
//
// At search time:
// 1. Split query into significant words (drop stop words)
// 2. For each word, exact-match lookup in semantic_aliases
// 3. If no exact match, trigram fuzzy match (similarity > 0.3)
// 4. For each match, find all sibling terms sharing the same canonical
// 5. Build expanded tsquery: (redbird | bluebird) & (head | shoulder)

import { query } from './db.js';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of',
  'and', 'or', 'but', 'not', 'with', 'from', 'by', 'as', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its',
  'our', 'their', 'i', 'me', 'you', 'he', 'she', 'we', 'they',
  'what', 'which', 'who', 'whom', 'when', 'where', 'how', 'why',
  'if', 'then', 'so', 'just', 'about', 'up', 'out', 'no', 'yes',
  'all', 'any', 'some', 'very', 'too', 'also', 'than', 'more',
]);

const MIN_FUZZY_SIMILARITY = 0.2;

function sanitizeForTsquery(term: string): string {
  const words = term.replace(/[^\w\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  return words.join(' <-> ');
}

export interface ExpansionDetail {
  matchedAlias: string;
  canonical: string;
  category: string;
  matchType: string;
  similarity: number;
  siblings: string[];
}

export interface WordExpansion {
  word: string;
  matchType: string;
  details: ExpansionDetail[];
  expandedTo: string[];
}

export interface QueryExpansionResult {
  expandedTsQuery: string | null;
  originalTsQuery: string | null;
  expansions: WordExpansion[];
}

export async function expandQuery(searchQuery: string): Promise<QueryExpansionResult> {
  const words = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  if (words.length === 0) {
    return { expandedTsQuery: null, originalTsQuery: null, expansions: [] };
  }

  const originalTsQuery = words.join(' & ');
  const expansions: WordExpansion[] = [];
  const expandedGroups: string[] = [];

  for (const word of words) {
    // Step 1: Try exact match
    let aliasResult = await query(`
      SELECT term, canonical, category, confidence
      FROM claude_memory.semantic_aliases
      WHERE term = $1 AND confidence > 0.2
      ORDER BY confidence DESC
      LIMIT 5
    `, [word]);

    let matchedAliases = aliasResult.rows;
    let matchType = 'exact';

    // Step 2: If no exact match, try trigram fuzzy match
    if (matchedAliases.length === 0) {
      aliasResult = await query(`
        SELECT term, canonical, category, confidence,
               similarity(term, $1) AS sim
        FROM claude_memory.semantic_aliases
        WHERE similarity(term, $1) > $2 AND confidence > 0.2
        ORDER BY similarity(term, $1) DESC
        LIMIT 5
      `, [word, MIN_FUZZY_SIMILARITY]);

      matchedAliases = aliasResult.rows;
      matchType = 'fuzzy';
    }

    if (matchedAliases.length === 0) {
      expandedGroups.push(word);
      continue;
    }

    // Step 3: For each canonical found, get all sibling terms
    const allTerms = new Set([word]);
    const expansionDetails: ExpansionDetail[] = [];

    for (const alias of matchedAliases) {
      allTerms.add(alias.term);

      const siblingsResult = await query(`
        SELECT term, MAX(confidence) AS conf
        FROM claude_memory.semantic_aliases
        WHERE canonical = $1 AND confidence > 0.3
        GROUP BY term
        ORDER BY conf DESC
        LIMIT 10
      `, [alias.canonical]);

      const siblings = siblingsResult.rows.map((r: any) => r.term);
      for (const s of siblings) allTerms.add(s);

      expansionDetails.push({
        matchedAlias: alias.term,
        canonical: alias.canonical,
        category: alias.category,
        matchType,
        similarity: alias.sim || 1.0,
        siblings,
      });
    }

    const termsArray = [...allTerms].map(sanitizeForTsquery);
    expandedGroups.push(
      termsArray.length > 1
        ? `(${termsArray.join(' | ')})`
        : termsArray[0]
    );

    expansions.push({
      word,
      matchType,
      details: expansionDetails,
      expandedTo: termsArray,
    });

    // Increment hit_count
    const matchedTerms = matchedAliases.map((a: any) => a.term);
    if (matchedTerms.length > 0) {
      await query(`
        UPDATE claude_memory.semantic_aliases
        SET hit_count = hit_count + 1
        WHERE term = ANY($1)
      `, [matchedTerms]).catch(() => {});
    }
  }

  const expandedTsQuery = expandedGroups.join(' & ');

  return { expandedTsQuery, originalTsQuery, expansions };
}

export async function recordFeedback(
  originalQuery: string,
  expandedQuery: string | null,
  expansions: WordExpansion[],
  resultCount: number,
  searchTool: string
): Promise<void> {
  try {
    await query(`
      INSERT INTO claude_memory.search_feedback
        (original_query, expanded_query, expansions, result_count, search_tool)
      VALUES ($1, $2, $3::jsonb, $4, $5)
    `, [
      originalQuery,
      expandedQuery,
      JSON.stringify(expansions),
      resultCount,
      searchTool,
    ]);

    // Auto-tune confidence
    if (expansions.length > 0) {
      const allMatchedTerms: string[] = [];
      for (const exp of expansions) {
        for (const detail of exp.details) {
          allMatchedTerms.push(detail.matchedAlias);
        }
      }

      if (allMatchedTerms.length > 0) {
        if (resultCount > 0) {
          await query(`
            UPDATE claude_memory.semantic_aliases
            SET confidence = LEAST(confidence + 0.02, 1.0)
            WHERE term = ANY($1)
          `, [allMatchedTerms]).catch(() => {});
        } else {
          await query(`
            UPDATE claude_memory.semantic_aliases
            SET confidence = GREATEST(confidence - 0.05, 0.1)
            WHERE term = ANY($1)
          `, [allMatchedTerms]).catch(() => {});
        }
      }
    }
  } catch {
    // Non-fatal
  }
}
