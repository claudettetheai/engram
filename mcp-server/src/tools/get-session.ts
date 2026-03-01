// memory_get_session — Retrieve full session context by ID or date
// Wraps retrieve-context.js recentContext() logic

import { query } from '../lib/db.js';

interface SessionInfo {
  id: string;
  started_at: string;
  ended_at: string | null;
  turn_count: number;
  message_count: number;
  summary: string | null;
  status: string;
}

interface SessionMessage {
  role: string;
  content: string;
  turn_number: number;
  created_at: string;
}

interface SessionResult {
  session: SessionInfo;
  messages: SessionMessage[];
}

export async function getSession(
  sessionId?: string,
  date?: string,
  recentCount?: number
): Promise<SessionResult | SessionResult[] | { sessions: SessionInfo[] }> {
  // Mode 1: Get specific session by ID
  if (sessionId) {
    return await getSessionById(sessionId);
  }

  // Mode 2: Get sessions by date
  if (date) {
    return await getSessionsByDate(date);
  }

  // Mode 3: Recent sessions (default: last 5)
  return await getRecentSessions(Math.min(Math.max(recentCount || 5, 1), 50));
}

async function getSessionById(sessionId: string): Promise<SessionResult> {
  const sessionRes = await query(`
    SELECT s.id, s.started_at, s.ended_at, s.turn_count, s.summary, s.status,
           COUNT(m.id) AS message_count
    FROM claude_memory.sessions s
    LEFT JOIN claude_memory.messages m ON m.session_id = s.id
    WHERE s.id = $1 OR s.id LIKE $2
    GROUP BY s.id
    LIMIT 1
  `, [sessionId, `${sessionId.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`]);

  if (sessionRes.rows.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const session = sessionRes.rows[0];

  const messagesRes = await query(`
    SELECT role, content, turn_number, created_at
    FROM claude_memory.messages
    WHERE session_id = $1
    ORDER BY id ASC
    LIMIT 200
  `, [session.id]);

  return {
    session: {
      id: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      turn_count: session.turn_count,
      message_count: parseInt(session.message_count),
      summary: session.summary,
      status: session.status,
    },
    messages: messagesRes.rows.map((m: any) => ({
      role: m.role,
      content: (m.content || '').slice(0, 2000),
      turn_number: m.turn_number,
      created_at: m.created_at,
    })),
  };
}

async function getSessionsByDate(date: string): Promise<{ sessions: SessionInfo[] }> {
  const sessionsRes = await query(`
    SELECT s.id, s.started_at, s.ended_at, s.turn_count, s.summary, s.status,
           COUNT(m.id) AS message_count
    FROM claude_memory.sessions s
    LEFT JOIN claude_memory.messages m ON m.session_id = s.id
    WHERE s.started_at::date = $1::date
    GROUP BY s.id
    ORDER BY s.started_at DESC
  `, [date]);

  return {
    sessions: sessionsRes.rows.map((s: any) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      turn_count: s.turn_count,
      message_count: parseInt(s.message_count),
      summary: s.summary,
      status: s.status,
    })),
  };
}

async function getRecentSessions(count: number): Promise<{ sessions: SessionInfo[] }> {
  const sessionsRes = await query(`
    SELECT s.id, s.started_at, s.ended_at, s.turn_count, s.summary, s.status,
           COUNT(m.id) AS message_count,
           MAX(m.created_at) AS last_message
    FROM claude_memory.sessions s
    LEFT JOIN claude_memory.messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT $1
  `, [count]);

  return {
    sessions: sessionsRes.rows.map((s: any) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      turn_count: s.turn_count,
      message_count: parseInt(s.message_count),
      summary: s.summary,
      status: s.status,
    })),
  };
}

export const getSessionTool = {
  name: 'memory_get_session',
  description: 'Retrieve full session details — messages, summary, and metadata. Can fetch by session ID (or prefix), by date, or list recent sessions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session UUID (or first 8 chars). Returns full message history for that session.',
      },
      date: {
        type: 'string',
        description: 'Date in YYYY-MM-DD format. Returns all sessions from that day.',
      },
      recent_count: {
        type: 'number',
        description: 'Number of recent sessions to list (default: 5, max: 20). Used when neither session_id nor date is provided.',
      },
    },
  },
};
