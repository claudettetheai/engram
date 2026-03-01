// Parse Claude Code JSONL transcripts
// Each line is a JSON object with a top-level "type" field and nested "message" object
//
// Actual format (from Claude Code 2.x):
//   { type: "user", message: { role: "user", content: "..." | [...] }, timestamp, ... }
//   { type: "assistant", message: { role: "assistant", content: [...] }, timestamp, ... }
//   { type: "progress", ... }  — skip
//   { type: "file-history-snapshot", ... }  — skip

const fs = require('fs');
const path = require('path');

// Top-level types to skip (not useful for memory)
const SKIP_TYPES = new Set([
  'progress',
  'file-history-snapshot',
  'ping',
  'system',
]);

/**
 * Parse a JSONL transcript file, optionally starting from a byte offset.
 * Returns { messages, newOffset, turnCount }
 *
 * Messages are normalized to: { role, content, toolName, turnNumber, rawType, timestamp }
 */
function parseTranscript(filePath, byteOffset = 0) {
  if (!fs.existsSync(filePath)) {
    return { messages: [], newOffset: 0, turnCount: 0 };
  }

  // PostgreSQL BIGINT returns as string in node-pg — coerce to integer
  const offset = typeof byteOffset === 'string' ? parseInt(byteOffset, 10) : Number(byteOffset) || 0;

  const stat = fs.statSync(filePath);
  if (stat.size <= offset) {
    return { messages: [], newOffset: offset, turnCount: 0 };
  }

  // Read from offset
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);

  const text = buffer.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());

  const messages = [];
  let turnNumber = 0;
  let lastUserTurn = -1;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    // Skip irrelevant message types
    if (parsed.type && SKIP_TYPES.has(parsed.type)) continue;

    const normalized = normalizeMessage(parsed);
    if (normalized) {
      // Count user turns (a user text message, not a tool_result response)
      if (normalized.role === 'user' && !normalized.isToolResult) {
        turnNumber++;
        lastUserTurn = turnNumber;
      }
      normalized.turnNumber = turnNumber;
      messages.push(normalized);
    }
  }

  return {
    messages,
    newOffset: stat.size,
    turnCount: turnNumber,
  };
}

/**
 * Normalize a raw JSONL entry into our standard format.
 * Returns null for entries we should skip.
 */
function normalizeMessage(entry) {
  const topType = entry.type; // "user", "assistant", "progress", etc.
  const msg = entry.message;  // { role, content }

  if (!msg) return null;

  const timestamp = entry.timestamp || null;

  // Handle user messages
  if (topType === 'user') {
    const msgContent = msg.content;

    // Check if this is a tool_result response (user type but contains tool_result blocks)
    if (Array.isArray(msgContent)) {
      const hasToolResult = msgContent.some(b => b.type === 'tool_result');
      if (hasToolResult) {
        const content = extractToolResultContent(msgContent);
        if (!content || content.length < 5) return null;
        return {
          role: 'tool_result',
          content: truncate(content, 10000),
          toolName: null,
          rawType: 'tool_result',
          timestamp,
          isToolResult: true,
        };
      }
    }

    // Regular user text message
    const content = extractTextContent(msgContent);
    if (!content || content.length < 2) return null;
    return {
      role: 'user',
      content: truncate(content, 50000),
      toolName: null,
      rawType: 'user',
      timestamp,
      isToolResult: false,
    };
  }

  // Handle assistant messages
  if (topType === 'assistant') {
    const content = extractAssistantContent(msg.content);
    if (!content || content.length < 2) return null;
    return {
      role: 'assistant',
      content: truncate(content, 50000),
      toolName: null,
      rawType: 'assistant',
      timestamp,
      isToolResult: false,
    };
  }

  return null;
}

/**
 * Extract text content from message.content (string or array of content blocks)
 */
function extractTextContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return null;
}

/**
 * Extract content from tool_result blocks (user type entries that contain tool responses)
 */
function extractToolResultContent(content) {
  if (!Array.isArray(content)) return null;

  return content
    .map(block => {
      if (block.type === 'tool_result') {
        // tool_result blocks have content as string or nested
        if (typeof block.content === 'string') return block.content;
        // Sometimes content is very long (file reads, etc.) — take first portion
        if (typeof block.content === 'object') return JSON.stringify(block.content).slice(0, 5000);
        return '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract assistant content, including tool_use descriptions but skipping thinking blocks
 */
function extractAssistantContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text;
        if (block.type === 'thinking') return null; // Skip thinking blocks
        if (block.type === 'tool_use') {
          // Include tool invocation as structured info
          const inputSummary = block.input
            ? JSON.stringify(block.input).slice(0, 500)
            : '';
          return `[Tool: ${block.name}] ${inputSummary}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return null;
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n... [truncated]';
}

/**
 * Find all JSONL transcript files across ALL project directories.
 * Archives everything — not just fusion-platform sessions.
 * Every conversation is worth remembering.
 */
function findTranscripts(projectDir) {
  const home = process.env.HOME || '/Users/boney';

  // Scan multiple locations: current user's .claude AND any migrated old .claude dirs
  const searchDirs = [
    path.join(home, '.claude/projects'),
    path.join(home, 'Downloads/.claude/projects'),  // Migrated from old machines
  ];

  const transcripts = [];
  const seenSessionIds = new Set();

  for (const claudeDir of searchDirs) {
    if (!fs.existsSync(claudeDir)) continue;

    let dirEntries;
    try {
      dirEntries = fs.readdirSync(claudeDir);
    } catch { continue; }

    for (const dirName of dirEntries) {
      const fullDir = path.join(claudeDir, dirName);
      try {
        if (!fs.statSync(fullDir).isDirectory()) continue;
      } catch { continue; }

      // Archive ALL project directories — every session matters
      let files;
      try {
        files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(fullDir, file);
        const sessionId = path.basename(file, '.jsonl');

        // Deduplicate: if same session ID found in multiple locations, take the first
        if (seenSessionIds.has(sessionId)) continue;
        seenSessionIds.add(sessionId);

        try {
          const stat = fs.statSync(fullPath);
          transcripts.push({
            path: fullPath,
            sessionId,
            size: stat.size,
            modified: stat.mtime,
            projectName: dirName,
          });
        } catch { continue; }
      }
    }
  }

  return transcripts.sort((a, b) => b.modified - a.modified);
}

module.exports = { parseTranscript, findTranscripts, normalizeMessage, extractTextContent };
