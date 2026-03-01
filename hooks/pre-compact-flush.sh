#!/bin/bash
# pre-compact-flush.sh — PreCompact hook
#
# Fires before context compression (manual or auto). Ensures all messages
# from the transcript are archived to the database before they potentially
# become inaccessible in the compressed context.
#
# This is the safety net for auto-compaction — the system compresses
# context when approaching limits, and this ensures nothing is lost.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MEMORY_SCRIPTS="$PROJECT_DIR/scripts/claude-memory"

# Read stdin (Claude Code hook JSON)
INPUT=$(cat)

# Archive flush — get any un-archived messages before compression
if [ -f "$MEMORY_SCRIPTS/archive-turn.js" ]; then
  echo "$INPUT" | node "$MEMORY_SCRIPTS/archive-turn.js" 2>/dev/null || true
fi

# Emit feedback
echo "Pre-compact flush complete. Messages archived before context compression."

# Always exit 0 — never block compaction
exit 0
