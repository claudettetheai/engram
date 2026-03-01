#!/usr/bin/env node
// catchup-ingestion.js — Discover and ingest new/incomplete Claude Code sessions
//
// Designed to run on a schedule (launchd every 30 min). Reuses migrate-history.js
// pipeline logic but focused on incremental catchup rather than full migration.
//
// What it does:
//   1. Finds all JSONL transcript files across project directories
//   2. Checks archive_cursors for incomplete sessions (file grew since last ingest)
//   3. Discovers brand-new sessions not yet in the database
//   4. Processes incrementally (from last cursor offset)
//
// Usage:
//   node catchup-ingestion.js               → run catchup
//   node catchup-ingestion.js --dry-run     → show what would be processed
//   node catchup-ingestion.js --full        → re-scan everything (like migrate)

const { query, withTransaction, end, logError } = require('./lib/db');
const { parseTranscript, findTranscripts } = require('./lib/jsonl-parser');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fullMode = args.includes('--full');
const skipEmbed = args.includes('--skip-embed');

const LOCK_FILE = '/tmp/claude-catchup-ingestion.pid';
const LOG_FILE = path.resolve(__dirname, 'catchup.log');

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  try {
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch {}
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      log(`Another instance running (PID ${pid}). Exiting.`);
      return false;
    } catch {
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('SIGINT', () => { releaseLock(); process.exit(0); });

async function main() {
  if (!acquireLock()) {
    await end();
    return;
  }

  try {
    const projectDir = path.resolve(__dirname, '../..');
    const transcripts = findTranscripts(projectDir);

    log(`Found ${transcripts.length} transcript files`);

    // Get existing sessions and their cursors
    const existingResult = await query(
      'SELECT id FROM claude_memory.sessions'
    );
    const existingSessions = new Set(existingResult.rows.map(r => r.id));

    const cursorsResult = await query(
      'SELECT session_id, byte_offset, line_number, turn_number FROM claude_memory.archive_cursors'
    );
    const cursors = new Map(cursorsResult.rows.map(r => [r.session_id, r]));

    // Categorize transcripts
    const newSessions = [];
    const updatedSessions = [];

    for (const t of transcripts) {
      if (!existingSessions.has(t.sessionId)) {
        newSessions.push(t);
      } else {
        // Check if file has grown since last cursor
        const cursor = cursors.get(t.sessionId);
        if (cursor) {
          try {
            const stat = fs.statSync(t.path);
            const offset = typeof cursor.byte_offset === 'string'
              ? parseInt(cursor.byte_offset, 10)
              : Number(cursor.byte_offset) || 0;
            if (stat.size > offset) {
              updatedSessions.push({ ...t, cursor });
            }
          } catch {}
        }
      }
    }

    log(`New sessions: ${newSessions.length} | Updated sessions: ${updatedSessions.length}`);

    if (dryRun) {
      log('\n--- DRY RUN ---');
      if (newSessions.length > 0) {
        log('\nNew sessions to ingest:');
        for (const t of newSessions.slice(0, 20)) {
          const date = t.modified.toISOString().split('T')[0];
          const sizeMB = (t.size / 1024 / 1024).toFixed(1);
          log(`  ${date} | ${t.sessionId.slice(0, 8)}... | ${sizeMB} MB | ${t.projectName}`);
        }
        if (newSessions.length > 20) log(`  ... and ${newSessions.length - 20} more`);
      }
      if (updatedSessions.length > 0) {
        log('\nSessions with new messages:');
        for (const t of updatedSessions.slice(0, 20)) {
          const date = t.modified.toISOString().split('T')[0];
          const offset = typeof t.cursor.byte_offset === 'string'
            ? parseInt(t.cursor.byte_offset, 10)
            : Number(t.cursor.byte_offset) || 0;
          const newBytes = t.size - offset;
          log(`  ${date} | ${t.sessionId.slice(0, 8)}... | +${(newBytes / 1024).toFixed(0)} KB new`);
        }
      }
      await end();
      return;
    }

    let processed = 0;
    let failed = 0;

    // Process new sessions
    for (const transcript of newSessions) {
      try {
        await processNewSession(transcript);
        processed++;
        if (processed % 10 === 0) {
          log(`  Progress: ${processed} processed, ${failed} failed`);
        }
      } catch (err) {
        failed++;
        logError(`Failed to process new session ${transcript.sessionId}`, err);
      }
    }

    // Process updated sessions (incremental from cursor)
    for (const transcript of updatedSessions) {
      try {
        await processUpdatedSession(transcript);
        processed++;
      } catch (err) {
        failed++;
        logError(`Failed to update session ${transcript.sessionId}`, err);
      }
    }

    log(`Catchup complete: ${processed} processed, ${failed} failed`);

    // Summary stats
    const totalResult = await query('SELECT COUNT(*) AS sessions FROM claude_memory.sessions');
    const msgResult = await query('SELECT COUNT(*) AS messages FROM claude_memory.messages');
    log(`Total: ${totalResult.rows[0].sessions} sessions, ${msgResult.rows[0].messages} messages`);

  } catch (err) {
    logError('Catchup failed', err);
    log(`FATAL: ${err.message}`);
  } finally {
    releaseLock();
    await end();
  }
}

async function processNewSession(transcript) {
  const { sessionId, path: filePath, modified } = transcript;
  const { messages, newOffset, turnCount } = parseTranscript(filePath, 0);

  if (messages.length === 0) return;

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO claude_memory.sessions (id, project_dir, started_at, ended_at, turn_count, status)
      VALUES ($1, $2, $3, $4, $5, 'completed')
      ON CONFLICT (id) DO NOTHING
    `, [
      sessionId,
      path.resolve(__dirname, '../..'),
      messages[0].timestamp || modified,
      messages[messages.length - 1].timestamp || modified,
      turnCount,
    ]);

    for (const msg of messages) {
      await client.query(`
        INSERT INTO claude_memory.messages (session_id, role, content, tool_name, turn_number, created_at)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, $7))
      `, [
        sessionId, msg.role, msg.content, msg.toolName,
        msg.turnNumber, msg.timestamp || null, modified,
      ]);
    }

    await client.query(`
      INSERT INTO claude_memory.archive_cursors (session_id, byte_offset, line_number, turn_number)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id) DO UPDATE SET
        byte_offset = EXCLUDED.byte_offset,
        line_number = EXCLUDED.line_number,
        turn_number = EXCLUDED.turn_number,
        updated_at = NOW()
    `, [sessionId, newOffset, messages.length, turnCount]);
  });

  // Best-effort embedding
  if (!skipEmbed) {
    await embedMessages(sessionId, messages);
  }
}

async function processUpdatedSession(transcript) {
  const { sessionId, path: filePath, modified, cursor } = transcript;
  const offset = typeof cursor.byte_offset === 'string'
    ? parseInt(cursor.byte_offset, 10)
    : Number(cursor.byte_offset) || 0;

  const { messages, newOffset, turnCount } = parseTranscript(filePath, offset);

  if (messages.length === 0) return;

  // Adjust turn numbers to continue from where we left off
  const baseTurn = typeof cursor.turn_number === 'string'
    ? parseInt(cursor.turn_number, 10)
    : Number(cursor.turn_number) || 0;

  await withTransaction(async (client) => {
    // Update session metadata
    await client.query(`
      UPDATE claude_memory.sessions
      SET turn_count = turn_count + $2,
          ended_at = COALESCE($3::timestamptz, NOW()),
          status = 'active'
      WHERE id = $1
    `, [sessionId, turnCount, messages[messages.length - 1].timestamp || null]);

    for (const msg of messages) {
      await client.query(`
        INSERT INTO claude_memory.messages (session_id, role, content, tool_name, turn_number, created_at)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
      `, [
        sessionId, msg.role, msg.content, msg.toolName,
        baseTurn + msg.turnNumber, msg.timestamp || null,
      ]);
    }

    await client.query(`
      UPDATE claude_memory.archive_cursors
      SET byte_offset = $2, line_number = line_number + $3, turn_number = $4, updated_at = NOW()
      WHERE session_id = $1
    `, [sessionId, newOffset, messages.length, baseTurn + turnCount]);
  });

  if (!skipEmbed) {
    await embedMessages(sessionId, messages);
  }
}

async function embedMessages(sessionId, messages) {
  try {
    const chunker = require('./lib/chunker');
    const embedder = require('./lib/embedder');

    const textMessages = messages.filter(m =>
      (m.role === 'user' || m.role === 'assistant') && m.content.length > 100
    );

    for (const msg of textMessages) {
      const chunks = chunker.chunkText(msg.content);
      for (let i = 0; i < chunks.length; i++) {
        let embedding = null;
        try {
          embedding = await embedder.embed(chunks[i]);
        } catch { /* non-fatal */ }

        const embStr = embedding ? `[${embedding.join(',')}]` : null;
        await query(`
          INSERT INTO claude_memory.chunks (session_id, content, embedding, chunk_index, token_count)
          VALUES ($1, $2, $3::vector, $4, $5)
        `, [sessionId, chunks[i], embStr, i, Math.ceil(chunks[i].length / 4)]);
      }
    }
  } catch {
    // Embedding modules not available
  }
}

main();
