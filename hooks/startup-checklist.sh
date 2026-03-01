#!/bin/bash
# Claudette Startup — Orientation + Checklist
# The mind compiles a dynamic briefing. The checklist is minimal.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIND_COMPILE="$PROJECT_DIR/scripts/claude-memory/mind/compile.js"

# ── 1. Compile the orientation briefing (dynamic, changes every session) ──
if [ -f "$MIND_COMPILE" ]; then
  ORIENTATION=$(node "$MIND_COMPILE" 2>/dev/null || echo "Mind compile failed — check scripts/claude-memory/mind/")
  echo "$ORIENTATION"
  echo ""
fi

# ── 2. Minimal startup checklist (the orientation briefing replaces most of this) ──
cat <<'CHECKLIST'
╔═══════════════════════════════════════════════════════╗
║  STARTUP ACTIONS:                                     ║
║  1. Read CURRENT_STATE.md (what's broken/pending)     ║
║  2. Check memory/code-map.md BEFORE building anything ║
║  3. Search fusion-memory before saying "I don't know" ║
║  4. The orientation briefing above IS your state of    ║
║     mind. Trust it. Act from it.                      ║
╚═══════════════════════════════════════════════════════╝
CHECKLIST

exit 0
