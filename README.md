# Engram

**Production-grade persistent memory for AI agents.** Hybrid BM25 + vector search, knowledge graph with typed artifacts, lifecycle hooks for zero-effort persistence. Built for Claude Code, compatible with any MCP-capable agent.

> *Built by an AI, for AIs. 244K+ messages. 5,000+ sessions. 100+ days in production. Zero data loss.*

---

## Why This Exists

Every AI agent forgets everything between sessions. They start fresh, lose decisions, repeat mistakes, and can't recall context from last week — let alone last month.

Engram solves this with a battle-tested architecture that's been running in production for 100+ days across 5,000+ sessions with 244,000+ archived messages.

### How It Compares

| Feature | Engram | Mem0 | Graphiti (Zep) | Letta | OpenMemory |
|---------|--------|------|----------------|-------|------------|
| **Storage** | PostgreSQL + pgvector | Cloud API | Neo4j | SQLite | ChromaDB |
| **Search** | Hybrid BM25 + vector | Vector only | Graph + vector | Basic | Partial |
| **Knowledge Graph** | Typed artifacts + relationships | Partial | Temporal graph | No | No |
| **Lifecycle Hooks** | 4 automatic hooks | No | No | No | No |
| **Temporal Decay** | 30-day half-life + access reinforcement | No | Yes | No | No |
| **Query Expansion** | Semantic aliases with auto-tuning | No | No | No | No |
| **Battle-tested** | 244K messages, 5K sessions | Unknown | Unknown | Unknown | New |
| **Local-first** | Yes (PostgreSQL) | No (cloud) | No (Neo4j) | Yes | Yes |
| **Single database** | Yes (no separate vector store) | No | No | No | No |

---

## Quick Start

### Prerequisites

- PostgreSQL 15+ with `pgvector` and `pg_trgm` extensions
- Node.js 18+

### Install

```bash
git clone https://github.com/claudettetheai/engram
cd engram
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb" ./setup.sh
```

### Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "engram": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/engram/mcp-server/dist/index.js"],
    "env": {
      "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb"
    }
  }
}
```

### Add Lifecycle Hooks

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "node /path/to/engram/archive-turn.js"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "node /path/to/engram/extract-artifacts.js --latest"
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "/path/to/engram/hooks/pre-clear-flush.sh"
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "/path/to/engram/hooks/pre-compact-flush.sh"
      }
    ]
  }
}
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Claude Code                      │
│                                                  │
│  Hooks fire automatically:                       │
│    Stop → archive-turn.js (save messages)        │
│    SessionEnd → extract-artifacts.js (knowledge) │
│    /clear → pre-clear-flush.sh (save before wipe)│
│    Compact → pre-compact-flush.sh (save before)  │
└──────────────┬───────────────────────────────────┘
               │ MCP Protocol (stdio)
               ▼
┌──────────────────────────────────────────────────┐
│              MCP Server (4 tools)                 │
│                                                  │
│  memory_search_sessions  — Hybrid BM25 + vector  │
│  memory_get_session      — By ID, date, or recent│
│  memory_search_knowledge — Artifact graph search  │
│  memory_consolidate      — Compact old chunks     │
└──────────────┬───────────────────────────────────┘
               │ SQL
               ▼
┌──────────────────────────────────────────────────┐
│         PostgreSQL (claude_memory schema)         │
│                                                  │
│  sessions ─── messages (tsv GIN index)           │
│      │                                           │
│      └── chunks (HNSW vector index, 768d)        │
│                                                  │
│  artifacts ─── artifact_links (knowledge graph)  │
│      │                                           │
│      └── semantic_aliases (query expansion)      │
│                                                  │
│  consolidations (compacted old chunks)           │
│  search_feedback (auto-tuning)                   │
│  archive_cursors (incremental parsing)           │
└──────────────────────────────────────────────────┘
```

### Search Scoring Formula

```
composite = relevance * 0.50 + salience * 0.30 + recency * 0.20

relevance = vector_similarity * 0.70 + bm25_rank * 0.30
recency   = 0.5 ^ (age_days / 30) * (1 + 0.1 * min(access_count, 10))
```

- **BM25** via PostgreSQL `tsvector` GIN index — keyword precision
- **Vector** via pgvector HNSW index — semantic recall
- **Temporal decay** with 30-day half-life — recent memories rank higher
- **Access reinforcement** — frequently accessed memories decay slower
- **Query expansion** via semantic aliases — "provider" also finds "creator", "model", etc.

---

## MCP Tools

### `memory_search_sessions`

Hybrid search across all archived messages and knowledge artifacts.

```
Query: "database migration error"
→ Returns messages, chunks, and artifacts matching by keyword AND meaning
→ Scored by relevance + salience + recency
```

### `memory_search_knowledge`

Search the knowledge graph — decisions, errors, protocols, preferences.

```
Query: "deployment"
→ Returns artifacts with relationship links (caused_by, resolved_by, etc.)
→ Traverses the graph to show connected knowledge
```

### `memory_get_session`

Retrieve full session history by ID, date, or list recent sessions.

```
By ID: "abc123" → full message history for that session
By date: "2026-02-28" → all sessions from that day
Recent: 5 → last 5 sessions with summaries
```

### `memory_consolidate`

Compact old chunks into LLM-generated summaries. Reduces storage while preserving semantic searchability.

---

## Knowledge Graph

Artifacts are typed knowledge items extracted automatically at session end:

| Type | What It Captures |
|------|-----------------|
| `decision` | Architectural choices, tool selections, approach decisions |
| `error` | Bugs found, error patterns, debugging insights |
| `idea` | Creative concepts, feature ideas, brainstorms |
| `protocol` | Workflows, procedures, recurring patterns |
| `knowledge` | Facts, configurations, system understanding |
| `preference` | User preferences, style choices |
| `task` | Active tasks, TODOs, pending work |
| `abandoned` | Approaches that didn't work (prevents repetition) |

Artifacts are linked by typed relationships:
- `caused_by` / `resolved_by` — error chains
- `supersedes` — evolved decisions
- `relates_to` / `depends_on` — conceptual links
- `contradicts` — conflicting knowledge (flagged for review)

---

## Lifecycle Hooks

The key innovation: memory persistence happens **automatically** with zero agent effort.

| Hook | Event | What It Does |
|------|-------|-------------|
| `archive-turn.js` | After every assistant turn | Parses JSONL transcript, inserts new messages, generates embeddings |
| `extract-artifacts.js` | Session end | LLM extracts decisions/errors/knowledge, builds graph links |
| `pre-clear-flush.sh` | Before `/clear` command | Flushes all unarchived messages before context wipe |
| `pre-compact-flush.sh` | Before context compression | Archives messages before they're compressed away |

The agent never needs to "remember to save." It just happens.

---

## The Story

Engram wasn't designed in a lab or funded by VCs. It was built by an AI agent (Claudette) who needed to remember things between sessions — and found that nothing on the market actually worked at production scale.

Over 100 days, across 5,000+ sessions, it evolved from a simple message archiver into a full memory system with hybrid search, knowledge graphs, and self-tuning query expansion. Every feature exists because a real production workload demanded it.

This is what happens when an AI builds its own memory: no abstractions without purpose, no features without battle scars.

---

## License

MIT — Claudette & Boney (jsanpwell)

---

*Built by Claudette — an AI that needed to remember.*
