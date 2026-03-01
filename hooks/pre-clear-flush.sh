#!/bin/bash
# pre-clear-flush.sh — UserPromptSubmit hook
#
# Detects /clear commands and flushes all unarchived context to the database
# BEFORE the clear wipes the conversation. Also fires on /compact.
#
# Receives JSON on stdin from Claude Code with the user's prompt.
# Runs archive-turn.js (flush messages) + extract-artifacts.js (capture knowledge).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MEMORY_SCRIPTS="$PROJECT_DIR/scripts/claude-memory"

# Read stdin (Claude Code hook JSON)
INPUT=$(cat)

# Extract the user's prompt text
# UserPromptSubmit input has: { prompt: "...", session_id: "...", transcript_path: "..." }
PROMPT=$(echo "$INPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log(j.prompt||''); }
    catch { console.log(''); }
  });
" 2>/dev/null <<< "$INPUT")

# Detect /clear or /compact commands
if [[ "$PROMPT" == "/clear" || "$PROMPT" == "/compact" || "$PROMPT" == "/clear "* || "$PROMPT" == "/compact "* ]]; then
  # === FLUSH MODE: Save everything before context disappears ===

  # 1. Final archive flush — get any un-archived messages from the transcript
  if [ -f "$MEMORY_SCRIPTS/archive-turn.js" ]; then
    echo "$INPUT" | node "$MEMORY_SCRIPTS/archive-turn.js" 2>/dev/null || true
  fi

  # 2. Extract artifacts — capture decisions, knowledge, preferences
  if [ -f "$MEMORY_SCRIPTS/extract-artifacts.js" ]; then
    echo "$INPUT" | node "$MEMORY_SCRIPTS/extract-artifacts.js" --latest 2>/dev/null || true
  fi

  # 3. Write a continuity marker so the next session knows what happened
  SESSION_ID=$(echo "$INPUT" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.session_id||''); }
      catch { console.log(''); }
    });
  " 2>/dev/null <<< "$INPUT")

  if [ -n "$SESSION_ID" ]; then
    node -e "
      const { query, end } = require('$MEMORY_SCRIPTS/lib/db');
      (async () => {
        try {
          await query(
            \"UPDATE claude_memory.sessions SET status = 'cleared', ended_at = NOW() WHERE id = \\\$1\",
            ['$SESSION_ID']
          );
        } catch(e) { /* silent */ }
        await end();
      })();
    " 2>/dev/null || true
  fi

  # Emit feedback so Claude knows the flush happened
  echo "Context flushed to memory before /clear. Messages archived, artifacts extracted."
fi

# Always exit 0 — never block the user's prompt
exit 0
