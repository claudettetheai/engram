#!/usr/bin/env node

/**
 * Custom Hook Examples for Engram
 *
 * Engram's lifecycle hooks fire automatically at key moments.
 * This file shows how to create custom hooks for your own agent.
 *
 * Hook events (Claude Code):
 *   Stop           → Agent stops responding (save conversation)
 *   SessionEnd     → Session fully closes (extract knowledge)
 *   UserPromptSubmit → User sends a message (intercept /clear)
 *   PreCompact     → Context about to be compressed (archive first)
 */

// Example 1: Custom Stop hook — save to external service
// Add to .claude/settings.json:
// { "hooks": { "Stop": [{ "type": "command", "command": "node your-hook.js" }] } }

const fs = require('fs');

/**
 * Read hook input from stdin (Claude Code passes JSON)
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
    // Timeout after 1 second if no input
    setTimeout(() => resolve(null), 1000);
  });
}

/**
 * Example: Log every conversation turn to a file
 */
async function logTurnHook() {
  const input = await readStdin();
  if (!input) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  };

  const logPath = '/tmp/engram-hook-log.jsonl';
  fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  console.log(`[hook] Logged turn to ${logPath}`);
}

/**
 * Example: Send webhook notification on session end
 */
async function webhookNotifyHook() {
  const input = await readStdin();
  if (!input) return;

  // Replace with your actual webhook URL
  const webhookUrl = process.env.ENGRAM_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'session_end',
        sessionId: input.session_id,
        timestamp: new Date().toISOString(),
      }),
    });
    console.log('[hook] Webhook sent');
  } catch (err) {
    console.error('[hook] Webhook failed:', err.message);
  }
}

/**
 * Example: Backup memories before /clear
 */
async function preClearBackupHook() {
  const input = await readStdin();
  if (!input?.input) return;

  // Check if user is about to /clear
  if (input.input.includes('/clear')) {
    console.log('[hook] /clear detected — backing up memories...');
    // Your backup logic here (pg_dump, file copy, etc.)
  }
}

// Run the appropriate hook based on args
const hookName = process.argv[2] || 'log';
const hooks = {
  log: logTurnHook,
  webhook: webhookNotifyHook,
  backup: preClearBackupHook,
};

if (hooks[hookName]) {
  hooks[hookName]().catch(err => {
    console.error(`[hook:${hookName}] Error:`, err.message);
    process.exit(0); // Always exit clean — never block the agent
  });
} else {
  console.log(`Usage: node custom-hooks.js [${Object.keys(hooks).join('|')}]`);
}
