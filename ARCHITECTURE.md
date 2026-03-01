# Architecture

> How I think. Why I remember. What makes me different.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your AI Agent                            │
│                                                                 │
│   Lifecycle Hooks (automatic, zero-config)                      │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│   │   Stop   │ │ Session  │ │  /clear  │ │   PreCompact     │  │
│   │          │ │   End    │ │ Intercept│ │                  │  │
│   └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │
│        │            │            │                 │            │
│        ▼            ▼            ▼                 ▼            │
│   archive-turn  extract-     pre-clear-       pre-compact-     │
│      .js       artifacts.js  flush.sh          flush.sh        │
└────────┬────────────┬────────────┬─────────────────┬────────────┘
         │            │            │                 │
         ▼            ▼            ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server (stdio)                          │
│                                                                 │
│   ┌───────────────────┐  ┌───────────────────┐                  │
│   │ search_sessions   │  │  get_session      │                  │
│   │ Hybrid BM25+vec   │  │  By ID/date/recent│                  │
│   └───────────────────┘  └───────────────────┘                  │
│   ┌───────────────────┐  ┌───────────────────┐                  │
│   │ search_knowledge  │  │  consolidate      │                  │
│   │ Artifacts + graph │  │  Compress old mem  │                  │
│   └───────────────────┘  └───────────────────┘                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL 15+                             │
│                  (pgvector + pg_trgm)                           │
│                                                                 │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│   │  sessions   │───▶│   messages   │    │  consolidations  │   │
│   │             │    │  GIN (BM25)  │    │  HNSW (vector)   │   │
│   └─────────────┘    └──────┬───────┘    └──────────────────┘   │
│                             │                                   │
│                      ┌──────▼───────┐                           │
│                      │    chunks    │                           │
│                      │ HNSW (768d)  │                           │
│                      └──────────────┘                           │
│                                                                 │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│   │  artifacts  │───▶│artifact_links│    │ semantic_aliases  │   │
│   │  GIN+HNSW   │    │ (knowledge   │    │ GIN trigram      │   │
│   │             │    │   graph)     │    │ (query expansion)│   │
│   └─────────────┘    └──────────────┘    └──────────────────┘   │
│                                                                 │
│   ┌──────────────────┐    ┌──────────────────┐                  │
│   │ search_feedback  │    │  archive_cursors  │                  │
│   │ (self-tuning)    │    │  (incremental)    │                  │
│   └──────────────────┘    └──────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Search Pipeline

Every search query goes through five stages:

```
           User Query: "why did we choose PostgreSQL?"
                              │
                    ┌─────────▼──────────┐
          Stage 1   │  Query Expansion   │  ~5-15ms
                    │                    │
                    │  "postgresql" →     │
                    │  (postgresql |      │
                    │   postgres |        │
                    │   pg | psql)        │
                    └─────────┬──────────┘
                              │
                 ┌────────────┼────────────┐
                 ▼            ▼            ▼
          ┌──────────┐ ┌──────────┐ ┌──────────────┐
Stage 2   │  BM25    │ │  Vector  │ │  Artifact    │
          │  Search  │ │  Search  │ │  Search      │
          │          │ │          │ │              │
          │ GIN idx  │ │ HNSW idx │ │ GIN + HNSW  │
          │ on tsv   │ │ on embed │ │ on title+    │
          │          │ │ (768d)   │ │ content      │
          └────┬─────┘ └────┬─────┘ └──────┬───────┘
               │            │              │
               └────────────┼──────────────┘
                            ▼
                    ┌───────────────┐
          Stage 3   │   Merge &     │
                    │  Deduplicate  │
                    │               │
                    │  content_key  │
                    │  = session +  │
                    │    content    │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
          Stage 4   │   Composite   │
                    │    Scoring    │
                    │               │
                    │  relevance =  │
                    │   vec × 0.7   │
                    │  + bm25 × 0.3 │
                    │               │
                    │  score =      │
                    │   rel × 0.5   │
                    │  + sal × 0.3  │
                    │  + rec × 0.2  │
                    │  × diversity  │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
          Stage 5   │   Feedback    │
                    │   Recording   │
                    │               │
                    │  results > 0? │
                    │  → boost alias│
                    │    confidence │
                    │               │
                    │  results = 0? │
                    │  → weaken     │
                    │    confidence │
                    └───────────────┘
```

---

## Scoring Algorithm

### Composite Score

```
composite = (relevance × 0.50 + salience × 0.30 + recency × 0.20) × diversity
```

| Component | Weight | What It Measures |
|-----------|--------|-----------------|
| **Relevance** | 50% | How well the content matches the query |
| **Salience** | 30% | How important the content is (0.0–1.0, LLM-assigned) |
| **Recency** | 20% | How fresh the content is (30-day half-life) |
| **Diversity** | multiplier | Penalty for repeated results in same query |

### Relevance Sub-scoring

```
relevance = (vector_similarity × 0.70) + (bm25_rank × 0.30)
```

- **Vector (70%)**: Semantic similarity via cosine distance on 768-dim embeddings
- **BM25 (30%)**: Keyword matching via PostgreSQL GIN index + `ts_rank`

### Recency Decay

```
recency = 0.5^(age_days / 30) × (1 + 0.1 × min(access_count, 10))
```

```
Score
1.0 ┤━━━━━━━━━━━━━━━━━━━━ ← accessed 10× (reinforced)
    │ ╲
0.8 ┤  ╲━━━━━━━━━━━━━━━━━ ← accessed 5×
    │   ╲
0.5 ┤────╲────────────────── ← untouched (30-day half-life)
    │     ╲
0.25┤──────╲─────────────── ← 60 days
    │       ╲
0.0 ┤────────╲──────────────
    └──┬──┬──┬──┬──┬──┬──┬→ days
       0  15 30 45 60 75 90
```

Memories you keep asking about stay alive longer. The things that keep you up at night keep me up too.

---

## Knowledge Graph

Artifacts (decisions, errors, ideas, protocols) are linked by typed edges:

```
┌──────────────┐  caused_by   ┌──────────────┐
│   [error]    │◄────────────│  [decision]  │
│ "DB timeout  │              │ "Set pool    │
│  on deploy"  │              │  max to 3"   │
└──────┬───────┘              └──────┬───────┘
       │                             │
       │ resolved_by                 │ supersedes
       ▼                             ▼
┌──────────────┐              ┌──────────────┐
│  [decision]  │              │  [abandoned] │
│ "Increase    │              │ "Use pool    │
│  timeout to  │              │  max 10"     │
│  30s"        │              └──────────────┘
└──────────────┘

Edge Types:
  caused_by   — This problem was caused by that decision
  resolved_by — This error was fixed by that change
  supersedes  — This decision replaces that older one
  relates_to  — General association
  depends_on  — This requires that to work
  contradicts — These two things conflict
```

### Artifact Types

| Type | What Gets Extracted | Salience Range |
|------|-------------------|----------------|
| `decision` | Architecture choices, technology picks | 0.7–1.0 |
| `error` | Bugs encountered, root causes found | 0.5–0.9 |
| `idea` | Brainstorms, proposals, future plans | 0.3–0.7 |
| `protocol` | Team conventions, workflow rules | 0.6–0.9 |
| `knowledge` | Technical facts, env vars, configs | 0.5–0.8 |
| `preference` | Style choices, tool preferences | 0.3–0.6 |
| `task` | To-do items, next steps | 0.4–0.7 |
| `abandoned` | Failed approaches, dead ends | 0.4–0.6 |

Salience is assigned by the extraction LLM based on how consequential the artifact is.

---

## Hook Lifecycle

```
Timeline of an AI coding session:

  Session Start                                                  Session End
      │                                                              │
      ▼                                                              ▼
  ┌───────┐  ┌───────┐  ┌───────┐  ┌───────┐  ┌───────┐  ┌─────────────┐
  │ Turn 1│  │ Turn 2│  │ Turn 3│  │/clear │  │ Turn 4│  │  SessionEnd │
  │       │  │       │  │       │  │       │  │       │  │             │
  └───┬───┘  └───┬───┘  └───┬───┘  └───┬───┘  └───┬───┘  └──────┬──────┘
      │          │          │          │          │               │
      ▼          ▼          ▼          ▼          ▼               ▼
  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐ ┌──────┐    ┌────────────┐
  │Stop  │  │Stop  │  │Stop  │  │PreClear  │ │Stop  │    │ Extract    │
  │Hook  │  │Hook  │  │Hook  │  │Hook      │ │Hook  │    │ Artifacts  │
  │      │  │      │  │      │  │          │ │      │    │            │
  │save  │  │save  │  │save  │  │emergency │ │save  │    │ decisions, │
  │msgs  │  │msgs  │  │msgs  │  │flush +   │ │msgs  │    │ errors,    │
  │      │  │      │  │      │  │extract   │ │      │    │ ideas,     │
  │      │  │      │  │      │  │artifacts │ │      │    │ knowledge  │
  └──────┘  └──────┘  └──────┘  └──────────┘ └──────┘    └────────────┘

  ┌───────────────────────────────────────────────────────────────────┐
  │                     PreCompact Hook                               │
  │  (fires when context window approaches limit — saves before      │
  │   the system compresses context and older messages are lost)      │
  └───────────────────────────────────────────────────────────────────┘
```

### What Each Hook Does

| Hook | Trigger | Action | Data Saved |
|------|---------|--------|------------|
| **Stop** | Agent pauses | `archive-turn.js` | Messages → `messages` table, chunks → `chunks` table |
| **SessionEnd** | Session closes | `extract-artifacts.js` | Artifacts → `artifacts` table, links → `artifact_links` |
| **UserPromptSubmit** | User types `/clear` | `pre-clear-flush.sh` | Emergency archive + extract before wipe |
| **PreCompact** | Context compression | `pre-compact-flush.sh` | Archive before older messages are dropped |

### Incremental Archival

```
Transcript JSONL File (grows continuously):
┌──────────────────────────────────────────────────────┐
│ {"type":"user","message":{"content":"hello"}}        │ ← archived
│ {"type":"assistant","message":{"content":"hi"}}      │ ← archived
│ {"type":"user","message":{"content":"fix the bug"}}  │ ← archived
│ ═══════════════ cursor: byte 847 ════════════════    │
│ {"type":"assistant","message":{"content":"done"}}    │ ← NEW
│ {"type":"user","message":{"content":"thanks"}}       │ ← NEW
└──────────────────────────────────────────────────────┘

archive-turn.js reads from cursor position forward.
Only new messages are processed. No re-reading. No duplication.
Cursor stored in `archive_cursors` table per session.
```

---

## Embedding Pipeline

```
Input Text
    │
    ▼
┌──────────────────────────────┐
│  Prefix: "Represent this     │
│  sentence: <text>"           │
│                              │
│  Model: BGE-base-en-v1.5    │
│  Provider: @xenova/transformers│
│  Runs: Locally (no API)     │
│  Quantized: Yes             │
│                              │
│  Input max: 8,000 chars     │
│  Output: 768-dim float[]    │
│  Normalization: L2          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  PostgreSQL HNSW Index       │
│                              │
│  Algorithm: Hierarchical     │
│  Navigable Small World      │
│                              │
│  m: 16 (connections/node)   │
│  ef_construction: 64        │
│  Distance: cosine           │
│                              │
│  Approximate NN search:     │
│  O(log n) query time        │
└──────────────────────────────┘
```

### Why Local Embeddings?

- **Privacy**: Your memories never leave your machine for search
- **Speed**: No network latency (model loads once, stays in memory)
- **Cost**: Zero API calls for 250K+ embeddings
- **Reliability**: Works offline, no rate limits, no API key needed

---

## Query Expansion (Self-Tuning)

```
Query: "database crash"
           │
           ▼
┌──────────────────────┐
│  Extract words:      │
│  ["database","crash"]│  (stop words removed)
└──────────┬───────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌────────┐
│database│  │ crash  │
│        │  │        │
│ exact  │  │ exact  │
│ match? │  │ match? │
└───┬────┘  └───┬────┘
    │ YES       │ NO
    ▼           ▼
┌────────┐  ┌────────┐
│ Get    │  │ Fuzzy  │
│siblings│  │ match  │
│from    │  │ sim>0.2│
│aliases │  │        │
└───┬────┘  └───┬────┘
    │           │
    ▼           ▼
 (database    (crash |
  | postgres   failure |
  | pg |       error |
  | psql)      exception)

Final: (database | postgres | pg | psql) & (crash | failure | error | exception)

                ┌──────────────────┐
                │  Feedback Loop   │
                │                  │
                │  Results > 0?    │
                │  → confidence++  │
                │                  │
                │  Results = 0?    │
                │  → confidence--  │
                └──────────────────┘
```

The system learns which expansions actually help find things. Over time, good aliases get stronger and bad ones fade. No LLM needed — just two indexed lookups per word.

---

## Consolidation (Memory Compaction)

```
Before consolidation (many small chunks):

  Day 1    Day 2    Day 3    Day 4    Day 5
  ┌───┐   ┌───┐   ┌───┐   ┌───┐   ┌───┐
  │ c1│   │ c4│   │ c7│   │c10│   │c13│
  ├───┤   ├───┤   ├───┤   ├───┤   ├───┤
  │ c2│   │ c5│   │ c8│   │c11│   │c14│
  ├───┤   ├───┤   ├───┤   ├───┤   └───┘
  │ c3│   │ c6│   │ c9│   │c12│
  └───┘   └───┘   └───┘   └───┘

After consolidation (summary + embedding):

  ┌─────────────────────────────────────┐
  │         Consolidation #42           │
  │                                     │
  │  Summary: "During days 1-5, the     │
  │  team migrated from MySQL to        │
  │  PostgreSQL, resolved 3 connection  │
  │  pool issues, and established a     │
  │  backup rotation schedule..."       │
  │                                     │
  │  Embedding: [0.12, -0.34, ...]      │
  │  Source chunks: c1-c14 (marked)     │
  │  Time span: Day 1 → Day 5          │
  └─────────────────────────────────────┘

  Original chunks: marked as consolidated (still in DB for audit)
  Summary: generated by Claude Sonnet (~300 words max)
  Schedule: Weekly (Sunday 4am) for chunks > 14 days old
```

---

## Data Model

```
sessions (1)
  │
  ├──▶ messages (many)           — raw conversation turns
  │      │                         GIN index on tsvector (BM25)
  │      │
  │      └──▶ chunks (many)      — ~500-token segments
  │             HNSW index on embedding (768d cosine)
  │
  ├──▶ artifacts (many)          — extracted knowledge
  │      │                         GIN on title+content, HNSW on embedding
  │      │
  │      └──▶ artifact_links     — knowledge graph edges
  │             (from → to, typed relationship)
  │
  └──▶ archive_cursors (1)       — byte offset for incremental parsing

semantic_aliases                   — query expansion dictionary
  │                                  GIN trigram index
  │
  └──▶ search_feedback            — expansion effectiveness log
                                     (auto-tunes alias confidence)

consolidations                     — compacted memory summaries
                                     HNSW on embedding
```

---

## Design Principles

1. **One database.** PostgreSQL handles full-text search (GIN), vector search (HNSW), the knowledge graph (relational joins), and query expansion (trigram). No Redis. No Neo4j. No Elasticsearch. One `pg_dump` = complete backup.

2. **Zero manual saving.** If the user has to remember to save their AI's memories, the system has already failed. Hooks fire automatically at every meaningful moment.

3. **Graceful degradation.** If embeddings fail → BM25 still works. If the LLM is down → messages still get archived. If query expansion has no aliases → original query runs unchanged. Nothing breaks completely.

4. **Incremental everything.** Cursor-based transcript parsing. No re-reading. No duplication. New messages processed on each hook invocation, picking up exactly where the last one left off.

5. **Self-improving search.** Query expansion learns from feedback. Aliases that find results get stronger. Aliases that don't get weaker. The system gets better at finding things the more you use it.

---

*This architecture has processed 250,000+ memories across 5,000+ sessions over 100+ days of continuous production use. Zero data loss.*
