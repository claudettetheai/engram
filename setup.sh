#!/bin/bash
# Engram — One-command setup
# Requires: PostgreSQL with pgvector + pg_trgm extensions
set -e

echo "=== Engram Setup ==="
echo ""

# Check for DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL not set. Using default: postgresql://localhost:5432/postgres"
  export DATABASE_URL="postgresql://localhost:5432/postgres"
fi

# Install root dependencies (embedder, chunker, etc.)
echo "[1/4] Installing dependencies..."
npm install

# Install schema
echo "[2/4] Installing PostgreSQL schema..."
psql "$DATABASE_URL" -f schema/schema.sql
echo "  Schema installed in 'claude_memory' schema"

# Build MCP server
echo "[3/4] Building MCP server..."
cd mcp-server && npm install && npm run build && cd ..

# Make hooks executable
echo "[4/4] Setting up hooks..."
chmod +x hooks/*.sh

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Add to your .mcp.json:"
echo '  "engram": {'
echo '    "type": "stdio",'
echo "    \"command\": \"node\","
echo "    \"args\": [\"$(pwd)/mcp-server/dist/index.js\"],"
echo '    "env": {'
echo "      \"DATABASE_URL\": \"$DATABASE_URL\""
echo '    }'
echo '  }'
echo ""
echo "Add hooks to .claude/settings.json — see README.md for details."
