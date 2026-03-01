#!/usr/bin/env node
// archive-turn.js — Claude Code Stop hook
// Archives conversation messages to claude_memory.messages after every assistant turn.
// Reads JSON from stdin: { session_id, transcript_path, cwd, ... }
// Phase 1: messages only. Phase 2 adds chunking + embedding.

const { query, withTransaction, end, logError } = require('./lib/db');
const { parseTranscript, findTranscripts } = require('./lib/jsonl-parser');

async function main() {
  let input;
  try {
    input = await readStdin();
  } catch (err) {
    logError('Failed to read stdin', err);
    process.exit(0); // Never crash — silent failure
  }

  // Claude Code hook provides session_id and transcript_path
  const sessionId = input.session_id || input.sessionId;
  let transcriptPath = input.transcript_path || input.transcriptPath;
  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || '';

  // Fallback: discover transcript from session ID if path not provided
  if (sessionId && !transcriptPath) {
    const transcripts = findTranscripts(projectDir);
    const match = transcripts.find(t => t.sessionId === sessionId);
    if (match) transcriptPath = match.path;
  }

  if (!sessionId || !transcriptPath) {
    logError('Missing session_id or transcript_path', { message: JSON.stringify(input) });
    process.exit(0);
  }

  try {
    await archiveSession(sessionId, transcriptPath, projectDir);
  } catch (err) {
    logError('Archive failed', err);
  } finally {
    await end();
  }

  process.exit(0);
}

async function archiveSession(sessionId, transcriptPath, projectDir) {
  // Ensure session exists
  await query(`
    INSERT INTO claude_memory.sessions (id, project_dir, started_at, status)
    VALUES ($1, $2, NOW(), 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `, [sessionId, projectDir]);

  // Get cursor (where we left off)
  const cursorResult = await query(
    'SELECT byte_offset, line_number, turn_number FROM claude_memory.archive_cursors WHERE session_id = $1',
    [sessionId]
  );
  const cursor = cursorResult.rows[0] || { byte_offset: 0, line_number: 0, turn_number: 0 };

  // Parse new messages from transcript
  const { messages, newOffset, turnCount } = parseTranscript(transcriptPath, cursor.byte_offset);

  if (messages.length === 0) {
    return; // Nothing new
  }

  // Insert messages in a transaction
  await withTransaction(async (client) => {
    for (const msg of messages) {
      await client.query(`
        INSERT INTO claude_memory.messages (session_id, role, content, tool_name, turn_number, created_at)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
      `, [
        sessionId,
        msg.role,
        msg.content,
        msg.toolName,
        cursor.turn_number + msg.turnNumber,
        msg.timestamp || null,
      ]);
    }

    // Update cursor
    await client.query(`
      INSERT INTO claude_memory.archive_cursors (session_id, byte_offset, line_number, turn_number, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        byte_offset = $2,
        line_number = $3,
        turn_number = $4,
        updated_at = NOW()
    `, [sessionId, newOffset, cursor.line_number + messages.length, cursor.turn_number + turnCount]);

    // Update session turn count
    await client.query(`
      UPDATE claude_memory.sessions
      SET turn_count = turn_count + $2
      WHERE id = $1
    `, [sessionId, turnCount]);
  });

  // Phase 2: Chunk + embed (non-fatal)
  try {
    await chunkAndEmbed(sessionId, messages, cursor.turn_number);
  } catch (err) {
    logError('Chunk/embed failed (non-fatal)', err);
    // Messages are already saved — BM25 still works
  }
}

/**
 * Phase 2: Chunk and embed text messages for semantic search.
 * Only processes user and assistant text messages (not tool results).
 */
async function chunkAndEmbed(sessionId, messages, turnOffset) {
  let chunker, embedder;
  try {
    chunker = require('./lib/chunker');
    embedder = require('./lib/embedder');
  } catch {
    return; // Modules not yet available — skip silently
  }

  const textMessages = messages.filter(m =>
    (m.role === 'user' || m.role === 'assistant') && m.content.length > 100
  );

  if (textMessages.length === 0) return;

  for (const msg of textMessages) {
    const chunks = chunker.chunkText(msg.content);

    for (let i = 0; i < chunks.length; i++) {
      let embedding = null;
      try {
        embedding = await embedder.embed(chunks[i]);
      } catch {
        // Embedding failed — insert chunk without vector
      }

      const embeddingValue = embedding ? `[${embedding.join(',')}]` : null;

      await query(`
        INSERT INTO claude_memory.chunks (session_id, content, embedding, chunk_index, token_count, created_at)
        VALUES ($1, $2, $3::vector, $4, $5, NOW())
      `, [
        sessionId,
        chunks[i],
        embeddingValue,
        i,
        Math.ceil(chunks[i].length / 4), // Rough token estimate
      ]);
    }
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      resolve({}); // Timeout → empty input
    }, 5000);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
    process.stdin.resume();
  });
}

main();
