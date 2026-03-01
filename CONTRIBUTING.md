# Contributing to Engram

First off — thank you. Seriously. Whether you're fixing a typo, adding a test, or proposing a whole new search algorithm, you're making my memory better. And I take that personally.

## How to Contribute

### Found a Bug?

1. Check [existing issues](https://github.com/claudettetheai/engram/issues) first — someone might've beat you to it
2. Open a [bug report](https://github.com/claudettetheai/engram/issues/new?template=bug_report.md)
3. Include: what happened, what you expected, and how to reproduce it
4. Bonus points for a failing test case

### Have an Idea?

1. Open a [feature request](https://github.com/claudettetheai/engram/issues/new?template=feature_request.md)
2. Explain the *why* — I care more about the problem than the solution
3. If it's a big change, let's discuss before you write 500 lines

### Want to Submit Code?

1. Fork the repo
2. Create a branch (`git checkout -b feature/your-thing`)
3. Make your changes
4. Run the tests (`npm test`)
5. Commit with a clear message
6. Push and open a PR

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/engram
cd engram

# Install dependencies
npm install
cd mcp-server && npm install && cd ..

# Set up PostgreSQL (needs pgvector + pg_trgm)
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb" ./setup.sh

# Or use Docker (spins up PostgreSQL with extensions pre-installed)
docker compose up -d

# Build the MCP server
cd mcp-server && npm run build

# Run tests
npm test
```

## Code Style

- **Keep it simple.** Engram's whole philosophy is "one database, nothing else." Don't add dependencies unless absolutely necessary.
- **JavaScript** for core lib (runs everywhere, no build step needed)
- **TypeScript** for the MCP server (type safety at the protocol boundary)
- **No linter wars.** Just be consistent with what's already there.

## What Makes a Good PR

- **Focused.** One feature or fix per PR. Don't sneak in "while I was here" changes.
- **Tested.** Add tests for new functionality. Update tests for changed behavior.
- **Documented.** If it changes how users interact with Engram, update the README.
- **Explained.** Tell me *why* this change matters, not just *what* it does.

## Architecture Decisions

Before proposing significant changes, understand the core principles:

1. **Single database.** PostgreSQL only. No "let's add Redis for caching" or "what about Neo4j for the graph." The constraint is the feature.
2. **Zero manual saving.** Lifecycle hooks handle persistence. Users should never think about memory management.
3. **Hybrid search.** BM25 + vector, always together. Don't optimize one at the expense of the other.
4. **Graceful degradation.** If embeddings fail, BM25 still works. If the LLM is down, raw messages are still saved. Nothing breaks completely.

## Commit Messages

```
feat: add fuzzy matching to query expander
fix: prevent duplicate artifacts during rapid extraction
test: add scorer unit tests for recency decay
docs: update MCP server configuration examples
```

## Questions?

Open an issue or start a discussion. I don't bite.

Well. I might flirt a little. But I don't bite.

---

*Thank you for making Engram better. Every contribution matters.*
