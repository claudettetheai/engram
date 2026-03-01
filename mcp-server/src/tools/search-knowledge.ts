// memory_search_knowledge — Search artifacts + relationship graph traversal

import { query } from '../lib/db.js';
import { expandQuery, recordFeedback } from '../lib/query-expander.js';

interface Artifact {
  id: number;
  artifact_type: string;
  title: string;
  content: string;
  salience: number;
  status: string;
  access_count: number;
  created_at: string;
  links: ArtifactLink[];
}

interface ArtifactLink {
  relation_type: string;
  direction: 'outgoing' | 'incoming';
  linked_artifact: {
    id: number;
    title: string;
    artifact_type: string;
    salience: number;
  };
}

interface KnowledgeResult {
  artifacts: Artifact[];
  stats: {
    total_artifacts: number;
    total_links: number;
    types: Record<string, number>;
  };
}

export async function searchKnowledge(
  searchQuery?: string,
  artifactType?: string,
  includeArchived?: boolean
): Promise<KnowledgeResult> {
  let artifacts: any[];

  if (searchQuery) {
    // Expand query using semantic aliases
    const expansion = await expandQuery(searchQuery);

    const tsQuery = expansion.expandedTsQuery || searchQuery
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => w.replace(/[^\w]/g, ''))
      .filter(Boolean)
      .join(' & ');

    if (!tsQuery) {
      return { artifacts: [], stats: { total_artifacts: 0, total_links: 0, types: {} } };
    }

    const statusFilter = includeArchived ? '' : "AND a.status = 'active'";
    const typeFilter = artifactType ? 'AND a.artifact_type = $2' : '';
    const params: unknown[] = [tsQuery];
    if (artifactType) params.push(artifactType);

    const res = await query(`
      SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.status,
             a.access_count, a.created_at,
             ts_rank_cd(to_tsvector('english', a.title || ' ' || a.content), to_tsquery('english', $1)) AS rank
      FROM claude_memory.artifacts a
      WHERE to_tsvector('english', a.title || ' ' || a.content) @@ to_tsquery('english', $1)
        ${statusFilter} ${typeFilter}
      ORDER BY rank DESC, a.salience DESC
      LIMIT 20
    `, params);

    artifacts = res.rows;

    // Also try vector search on artifact embeddings
    try {
      const embedderPath = require.resolve('../../../lib/embedder.js');
      const embedder = require(embedderPath);
      const queryEmbedding = await embedder.embed(searchQuery);
      const embStr = `[${queryEmbedding.join(',')}]`;

      const vecRes = await query(`
        SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.status,
               a.access_count, a.created_at,
               1 - (a.embedding <=> $1::vector) AS similarity
        FROM claude_memory.artifacts a
        WHERE a.embedding IS NOT NULL ${statusFilter}
        ORDER BY a.embedding <=> $1::vector
        LIMIT 10
      `, [embStr]);

      // Merge vector results (deduplicate by id)
      const existingIds = new Set(artifacts.map(a => a.id));
      for (const r of vecRes.rows) {
        if (!existingIds.has(r.id) && (r.similarity || 0) > 0.5) {
          artifacts.push(r);
        }
      }
    } catch {
      // Embedder not available
    }

    // Record search feedback (non-blocking)
    if (expansion.expansions.length > 0) {
      recordFeedback(
        searchQuery,
        expansion.expandedTsQuery,
        expansion.expansions,
        artifacts.length,
        'knowledge'
      ).catch(() => {});
    }
  } else {
    // No query — list all active artifacts
    const statusFilter = includeArchived ? '' : "WHERE a.status = 'active'";
    const typeFilter = artifactType
      ? (includeArchived ? `WHERE a.artifact_type = $1` : `AND a.artifact_type = $1`)
      : '';
    const params: unknown[] = artifactType ? [artifactType] : [];

    const res = await query(`
      SELECT a.id, a.artifact_type, a.title, a.content, a.salience, a.status,
             a.access_count, a.created_at
      FROM claude_memory.artifacts a
      ${statusFilter} ${typeFilter}
      ORDER BY a.salience DESC, a.created_at DESC
      LIMIT 50
    `, params);

    artifacts = res.rows;
  }

  // Fetch relationship graph links for found artifacts
  if (artifacts.length > 0) {
    const ids = artifacts.map(a => a.id);
    const linksRes = await query(`
      SELECT al.from_artifact_id, al.to_artifact_id, al.relation_type, al.confidence,
             af.id AS from_id, af.title AS from_title, af.artifact_type AS from_type, af.salience AS from_salience,
             at2.id AS to_id, at2.title AS to_title, at2.artifact_type AS to_type, at2.salience AS to_salience
      FROM claude_memory.artifact_links al
      JOIN claude_memory.artifacts af ON af.id = al.from_artifact_id
      JOIN claude_memory.artifacts at2 ON at2.id = al.to_artifact_id
      WHERE al.from_artifact_id = ANY($1) OR al.to_artifact_id = ANY($1)
    `, [ids]);

    // Attach links to artifacts
    const linkMap = new Map<number, ArtifactLink[]>();
    for (const link of linksRes.rows) {
      for (const id of ids) {
        if (!linkMap.has(id)) linkMap.set(id, []);
        if (link.from_artifact_id === id) {
          linkMap.get(id)!.push({
            relation_type: link.relation_type,
            direction: 'outgoing',
            linked_artifact: {
              id: link.to_id,
              title: link.to_title,
              artifact_type: link.to_type,
              salience: link.to_salience,
            },
          });
        } else if (link.to_artifact_id === id) {
          linkMap.get(id)!.push({
            relation_type: link.relation_type,
            direction: 'incoming',
            linked_artifact: {
              id: link.from_id,
              title: link.from_title,
              artifact_type: link.from_type,
              salience: link.from_salience,
            },
          });
        }
      }
    }

    for (const a of artifacts) {
      a.links = linkMap.get(a.id) || [];
    }

    // Update access counts
    await query(`
      UPDATE claude_memory.artifacts
      SET access_count = access_count + 1, last_accessed = NOW()
      WHERE id = ANY($1)
    `, [ids]);
  }

  // Stats
  const statsRes = await query(`
    SELECT
      (SELECT COUNT(*) FROM claude_memory.artifacts WHERE status = 'active') AS total_artifacts,
      (SELECT COUNT(*) FROM claude_memory.artifact_links) AS total_links
  `);
  const typesRes = await query(`
    SELECT artifact_type, COUNT(*) AS count
    FROM claude_memory.artifacts WHERE status = 'active'
    GROUP BY artifact_type ORDER BY count DESC
  `);

  const types: Record<string, number> = {};
  for (const row of typesRes.rows) {
    types[row.artifact_type] = parseInt(row.count);
  }

  return {
    artifacts: artifacts.map(a => ({
      id: a.id,
      artifact_type: a.artifact_type,
      title: a.title,
      content: (a.content || '').slice(0, 2000),
      salience: a.salience,
      status: a.status,
      access_count: a.access_count,
      created_at: a.created_at,
      links: a.links || [],
    })),
    stats: {
      total_artifacts: parseInt(statsRes.rows[0].total_artifacts),
      total_links: parseInt(statsRes.rows[0].total_links),
      types,
    },
  };
}

export const searchKnowledgeTool = {
  name: 'memory_search_knowledge',
  description: 'Search the knowledge graph — artifacts (decisions, errors, ideas, protocols, preferences) with relationship links. Without a query, lists all active artifacts by salience.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query for artifacts. Omit to list all active artifacts.',
      },
      artifact_type: {
        type: 'string',
        description: 'Filter by type: decision, error, idea, abandoned, protocol, knowledge, preference, task',
        enum: ['decision', 'error', 'idea', 'abandoned', 'protocol', 'knowledge', 'preference', 'task'],
      },
      include_archived: {
        type: 'boolean',
        description: 'Include archived/superseded artifacts (default: false)',
      },
    },
  },
};
