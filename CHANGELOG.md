# Changelog

All notable changes to Engram will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-28

### Added
- Hybrid BM25 + vector search across sessions and messages
- Knowledge graph with artifact extraction and linking
- 4 lifecycle hooks: Stop, SessionEnd, UserPromptSubmit, PreCompact
- Self-tuning query expansion via semantic aliases
- 30-day temporal decay with access reinforcement
- MCP server with 4 tools: search_sessions, get_session, search_knowledge, consolidate
- Local embeddings via @xenova/transformers (768-dim BGE-base-en-v1.5)
- PostgreSQL schema with pgvector HNSW indexes and pg_trgm GIN indexes
- Chunk consolidation for long-term memory compaction
- Incremental transcript ingestion with cursor-based resume
- Claude Code JSONL transcript parser
- One-command setup script

### Production Stats
- 250,000+ memories archived
- 5,000+ sessions processed
- 100+ days in continuous production
- Zero data loss
