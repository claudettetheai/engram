#!/usr/bin/env node
// Total Recall Memory — MCP Server
//
// Production-grade persistent memory for AI agents.
// Exposes 4 tools over stdio transport:
//   memory_search_sessions  — Hybrid BM25 + vector search
//   memory_get_session      — Retrieve session by ID/date, or list recent
//   memory_search_knowledge — Artifact search + relationship graph
//   memory_consolidate      — Trigger chunk compaction

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSessions, searchSessionsTool } from './tools/search-sessions.js';
import { getSession, getSessionTool } from './tools/get-session.js';
import { searchKnowledge, searchKnowledgeTool } from './tools/search-knowledge.js';
import { consolidate, consolidateTool } from './tools/consolidate.js';
import { query } from './lib/db.js';

/** Sanitize error messages to prevent leaking internal paths or credentials */
function sanitizeError(err: any): string {
  const msg = err?.message || 'Unknown error';
  return msg
    .replace(/postgresql:\/\/[^\s"')]+/gi, 'DATABASE_URL')
    .replace(/\/Users\/[^\s"')]+/g, '[path]')
    .replace(/\/home\/[^\s"')]+/g, '[path]');
}

const server = new McpServer({
  name: 'engram',
  version: '1.0.0',
});

// Tool 1: Hybrid search across messages + artifacts
server.tool(
  searchSessionsTool.name,
  searchSessionsTool.description,
  {
    query: z.string().describe('Search query — natural language or keywords'),
    limit: z.number().optional().describe('Max results (default: 15, max: 50)'),
  },
  async ({ query: searchQuery, limit }) => {
    try {
      const results = await searchSessions(searchQuery, Math.min(limit || 15, 50));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Search failed: ${sanitizeError(err)}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Session retrieval
server.tool(
  getSessionTool.name,
  getSessionTool.description,
  {
    session_id: z.string().optional().describe('Session UUID or prefix'),
    date: z.string().optional().describe('Date (YYYY-MM-DD)'),
    recent_count: z.number().optional().describe('Number of recent sessions (default: 5)'),
  },
  async ({ session_id, date, recent_count }) => {
    try {
      const result = await getSession(session_id, date, recent_count);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Session retrieval failed: ${sanitizeError(err)}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Knowledge graph search
server.tool(
  searchKnowledgeTool.name,
  searchKnowledgeTool.description,
  {
    query: z.string().optional().describe('Search query for artifacts'),
    artifact_type: z.enum(['decision', 'error', 'idea', 'abandoned', 'protocol', 'knowledge', 'preference', 'task']).optional(),
    include_archived: z.boolean().optional().describe('Include archived artifacts'),
  },
  async ({ query: searchQuery, artifact_type, include_archived }) => {
    try {
      const result = await searchKnowledge(searchQuery, artifact_type, include_archived);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Knowledge search failed: ${sanitizeError(err)}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Consolidation trigger
server.tool(
  consolidateTool.name,
  consolidateTool.description,
  {
    dry_run: z.boolean().optional().describe('Preview only (default: true)'),
    days: z.number().optional().describe('Chunk age threshold in days (default: 14)'),
  },
  async ({ dry_run, days }) => {
    try {
      const result = await consolidate(dry_run !== false, days || 14);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Consolidation failed: ${sanitizeError(err)}` }],
        isError: true,
      };
    }
  }
);

// Resource: Memory system stats
server.resource(
  'memory-stats',
  'engram://stats',
  async (uri) => {
    try {
      const stats = await query(`
        SELECT
          (SELECT COUNT(*) FROM claude_memory.sessions) AS total_sessions,
          (SELECT COUNT(*) FROM claude_memory.messages) AS total_messages,
          (SELECT COUNT(*) FROM claude_memory.chunks) AS total_chunks,
          (SELECT COUNT(*) FROM claude_memory.chunks WHERE embedding IS NOT NULL) AS embedded_chunks,
          (SELECT COUNT(*) FROM claude_memory.artifacts WHERE status = 'active') AS active_artifacts,
          (SELECT COUNT(*) FROM claude_memory.consolidations) AS consolidations,
          (SELECT MAX(started_at) FROM claude_memory.sessions) AS last_session
      `);

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(stats.rows[0], null, 2),
        }],
      };
    } catch (err: any) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/plain',
          text: `Stats unavailable: ${err.message}`,
        }],
      };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[engram] MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[engram] Fatal: ${err.message}\n`);
  process.exit(1);
});
