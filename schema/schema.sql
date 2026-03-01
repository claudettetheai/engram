-- Claude Memory System Schema
-- Re-runnable: uses IF NOT EXISTS / CREATE OR REPLACE throughout
-- Requires: pgvector, pg_trgm extensions (already installed)

CREATE SCHEMA IF NOT EXISTS claude_memory;

-- Sessions: one row per Claude Code conversation
CREATE TABLE IF NOT EXISTS claude_memory.sessions (
  id            TEXT PRIMARY KEY,              -- Claude session UUID
  project_dir   TEXT NOT NULL DEFAULT '',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,                          -- Generated summary (Phase 3+)
  summary_embedding VECTOR(768),               -- Embedding of summary
  status        TEXT NOT NULL DEFAULT 'active'  -- active | completed | abandoned
    CHECK (status IN ('active', 'completed', 'abandoned'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_started
  ON claude_memory.sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON claude_memory.sessions (status);

-- Messages: every user/assistant/tool message
CREATE TABLE IF NOT EXISTS claude_memory.messages (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES claude_memory.sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_result')),
  content       TEXT NOT NULL,
  tool_name     TEXT,                          -- For tool_use / tool_result
  turn_number   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON claude_memory.messages (session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_messages_created
  ON claude_memory.messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_tsv
  ON claude_memory.messages USING GIN (tsv);

-- Chunks: semantic search segments (populated by embedding pipeline)
CREATE TABLE IF NOT EXISTS claude_memory.chunks (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES claude_memory.sessions(id) ON DELETE CASCADE,
  message_id    BIGINT REFERENCES claude_memory.messages(id) ON DELETE SET NULL,
  content       TEXT NOT NULL,
  embedding     VECTOR(768),
  chunk_index   INTEGER NOT NULL DEFAULT 0,    -- Order within source message
  token_count   INTEGER,
  consolidated  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_session
  ON claude_memory.chunks (session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_not_consolidated
  ON claude_memory.chunks (consolidated) WHERE consolidated = FALSE;

-- HNSW vector index on chunks (works from row 1, no training needed)
-- Drop and recreate to handle dimension changes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'claude_memory' AND indexname = 'idx_chunks_embedding_hnsw'
  ) THEN
    CREATE INDEX idx_chunks_embedding_hnsw
      ON claude_memory.chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END $$;

-- Consolidations: compacted summaries of old chunks
CREATE TABLE IF NOT EXISTS claude_memory.consolidations (
  id            BIGSERIAL PRIMARY KEY,
  source_session_ids TEXT[] NOT NULL DEFAULT '{}',
  source_chunk_ids   BIGINT[] NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL,
  embedding     VECTOR(768),
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  time_span_start TIMESTAMPTZ,
  time_span_end   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'claude_memory' AND indexname = 'idx_consolidations_embedding_hnsw'
  ) THEN
    CREATE INDEX idx_consolidations_embedding_hnsw
      ON claude_memory.consolidations
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END $$;

-- Artifacts: decisions, errors, ideas, knowledge extracted by LLM
CREATE TABLE IF NOT EXISTS claude_memory.artifacts (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT REFERENCES claude_memory.sessions(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL
    CHECK (artifact_type IN ('decision', 'error', 'idea', 'abandoned', 'protocol', 'knowledge', 'preference', 'task')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  salience      REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0.0 AND salience <= 1.0),
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'resolved', 'archived')),
  embedding     VECTOR(768),
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_type
  ON claude_memory.artifacts (artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_status
  ON claude_memory.artifacts (status);
CREATE INDEX IF NOT EXISTS idx_artifacts_salience
  ON claude_memory.artifacts (salience DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_tsv
  ON claude_memory.artifacts USING GIN (to_tsvector('english', title || ' ' || content));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'claude_memory' AND indexname = 'idx_artifacts_embedding_hnsw'
  ) THEN
    CREATE INDEX idx_artifacts_embedding_hnsw
      ON claude_memory.artifacts
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END $$;

-- Artifact Links: knowledge graph edges between artifacts
CREATE TABLE IF NOT EXISTS claude_memory.artifact_links (
  id            BIGSERIAL PRIMARY KEY,
  from_artifact_id BIGINT NOT NULL REFERENCES claude_memory.artifacts(id) ON DELETE CASCADE,
  to_artifact_id   BIGINT NOT NULL REFERENCES claude_memory.artifacts(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('caused_by', 'resolved_by', 'supersedes', 'relates_to', 'depends_on', 'contradicts')),
  confidence    REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_artifact_id, to_artifact_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_artifact_links_from
  ON claude_memory.artifact_links (from_artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_to
  ON claude_memory.artifact_links (to_artifact_id);

-- Semantic Aliases: maps terms to canonical categories for query expansion
-- Populated at artifact write time; queried at search time for fuzzy matching
CREATE TABLE IF NOT EXISTS claude_memory.semantic_aliases (
  id            BIGSERIAL PRIMARY KEY,
  term          TEXT NOT NULL,                    -- e.g. "bluebird", "shoulder"
  canonical     TEXT NOT NULL,                    -- e.g. "bird", "body_part"
  category      TEXT NOT NULL                     -- e.g. "animal", "body_part", "emotion"
    CHECK (category IN ('animal', 'body_part', 'emotion', 'place', 'person', 'action', 'object', 'color', 'personal', 'metaphor', 'music', 'food', 'time')),
  source_artifact_id BIGINT REFERENCES claude_memory.artifacts(id) ON DELETE SET NULL,
  confidence    REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  hit_count     INTEGER NOT NULL DEFAULT 0,       -- Incremented each time this alias helps a search
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, canonical)
);

CREATE INDEX IF NOT EXISTS idx_semantic_aliases_term
  ON claude_memory.semantic_aliases (term);
CREATE INDEX IF NOT EXISTS idx_semantic_aliases_canonical
  ON claude_memory.semantic_aliases (canonical);

-- GIN trigram index for fuzzy matching (e.g. "redbird" ~ "bluebird")
CREATE INDEX IF NOT EXISTS idx_semantic_aliases_term_trgm
  ON claude_memory.semantic_aliases USING GIN (term gin_trgm_ops);

-- Search Feedback: records expanded queries and whether they found results
-- Used to auto-strengthen/weaken alias confidence over time
CREATE TABLE IF NOT EXISTS claude_memory.search_feedback (
  id            BIGSERIAL PRIMARY KEY,
  original_query TEXT NOT NULL,
  expanded_query TEXT,                            -- The tsquery after expansion
  expansions    JSONB,                            -- Array of {term, matched_alias, canonical, siblings}
  result_count  INTEGER NOT NULL DEFAULT 0,
  search_tool   TEXT NOT NULL DEFAULT 'sessions'  -- 'sessions' or 'knowledge'
    CHECK (search_tool IN ('sessions', 'knowledge')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_feedback_created
  ON claude_memory.search_feedback (created_at DESC);

-- Archive Cursors: tracks archival progress per session
CREATE TABLE IF NOT EXISTS claude_memory.archive_cursors (
  session_id    TEXT PRIMARY KEY REFERENCES claude_memory.sessions(id) ON DELETE CASCADE,
  byte_offset   BIGINT NOT NULL DEFAULT 0,    -- Last processed byte in JSONL
  line_number   INTEGER NOT NULL DEFAULT 0,   -- Last processed line number
  turn_number   INTEGER NOT NULL DEFAULT 0,   -- Last processed turn
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
