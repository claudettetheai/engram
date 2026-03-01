# Performance Benchmarks

> **Measured on a Mac mini M1 with 16GB of RAM** — the $599 consumer machine. Not a GPU cluster. Not a cloud VM. Not a "performance-optimized enterprise instance." A little silver box from 2020 that you can buy at Best Buy.
>
> Everything here is single-threaded. Node.js 20. No tricks. No warm caches. Just honest numbers on honest hardware.
>
> If your AI memory system needs more than this, it has an architecture problem, not a hardware problem.

Run benchmarks yourself: `node benchmarks/bench-scorer.js`

---

## Scoring Engine

| Operation | Result Set | Latency | Throughput |
|-----------|-----------|---------|------------|
| `scoreResults()` | 10 items | 0.014ms | 69,977 ops/sec |
| `scoreResults()` | 50 items | 0.052ms | 19,200 ops/sec |
| `scoreResults()` | 100 items | 0.103ms | 9,734 ops/sec |
| `scoreResults()` | 500 items | 0.591ms | 1,691 ops/sec |

Scoring 100 results takes **103 microseconds**. Your search query spends more time in PostgreSQL than it does in the scorer.

## Recency Decay

| Age | Access Count | Latency | Throughput |
|-----|-------------|---------|------------|
| 0 days | 0 | <0.001ms | 4,981,838 ops/sec |
| 0 days | 10 | <0.001ms | 5,215,463 ops/sec |
| 30 days | 0 | <0.001ms | 4,689,971 ops/sec |
| 30 days | 10 | <0.001ms | 4,719,948 ops/sec |
| 90 days | 0 | <0.001ms | 4,273,352 ops/sec |
| 90 days | 10 | <0.001ms | 4,555,636 ops/sec |

Nearly 5 million decay calculations per second. This is a rounding error in your total latency.

## Text Chunking

| Input Size | Latency | Throughput |
|-----------|---------|------------|
| 1K chars | <0.001ms | 9,327,575 ops/sec |
| 2K chars | 0.002ms | 606,995 ops/sec |
| 10K chars | 0.006ms | 174,591 ops/sec |
| 50K chars | 0.025ms | 40,469 ops/sec |

Chunking 50KB of text takes 25 microseconds. A full Claude conversation (~10K) chunks in 6 microseconds.

## Cosine Similarity

| Dimensions | Latency | Throughput |
|-----------|---------|------------|
| 128d | <0.001ms | 5,340,217 ops/sec |
| 384d | <0.001ms | 2,709,262 ops/sec |
| 768d (Engram default) | 0.001ms | 1,355,304 ops/sec |
| 1536d | 0.001ms | 684,511 ops/sec |

1.3 million cosine similarity calculations per second at 768 dimensions. Vector math is not your bottleneck.

---

## Where Time Actually Goes

In production (250K+ memories), the latency breakdown for a typical search:

| Stage | Latency | Notes |
|-------|---------|-------|
| Query expansion | 5-15ms | Two indexed lookups per word |
| BM25 search (PostgreSQL) | 10-50ms | GIN index scan |
| Vector search (PostgreSQL) | 20-80ms | HNSW approximate NN |
| Scoring + ranking | 0.1ms | Pure CPU, no I/O |
| **Total** | **35-145ms** | End-to-end search |

PostgreSQL index scans dominate. Engram's application-level processing (chunking, scoring, expansion) adds less than 1ms total. The system is I/O-bound, not CPU-bound — exactly where you want to be.

**The takeaway:** 250,000+ memories. Sub-150ms searches. On a consumer Mac mini. Your competitors are raising millions for cloud infrastructure. You need a power outlet.

---

## Test Suite

| Metric | Value |
|--------|-------|
| Total tests | 100 |
| Test files | 9 |
| Total runtime | ~385ms |
| Framework | Vitest |
| Coverage | Chunker, scorer, embedder, query expander, JSONL parser, DB utils, integration |

---

*Benchmarks last run: 2026-03-01 on Mac mini M1 16GB ($599 retail), Node.js 20, Engram v1.0.0*

---

**Your move, cloud APIs.** 💅
