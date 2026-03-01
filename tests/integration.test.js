import { describe, it, expect } from 'vitest';
import { chunkText } from '../lib/chunker.js';
import { cosineSimilarity } from '../lib/embedder.js';
import { scoreResults, recencyDecay } from '../lib/scorer.js';
import { STOP_WORDS } from '../lib/query-expander.js';
import { normalizeMessage, extractTextContent } from '../lib/jsonl-parser.js';

/**
 * Integration tests — verify components work together correctly.
 * These test simulate real-world pipelines without a database.
 */

describe('end-to-end search pipeline (mocked)', () => {
  it('chunks then scores then ranks produces correct ordering', () => {
    const memories = [
      { text: 'We chose PostgreSQL for the database because of pgvector support.', age: 2, access: 5 },
      { text: 'Redis was considered for caching but we decided against it.', age: 30, access: 0 },
      { text: 'The deployment pipeline uses Docker Compose in production.', age: 7, access: 2 },
    ];

    const now = Date.now();
    const bm25 = memories.map((m, i) => ({
      content: m.text,
      session_id: `s${i}`,
      rank: m.text.toLowerCase().includes('postgresql') ? 10 : 2,
      created_at: new Date(now - m.age * 86400000).toISOString(),
      access_count: m.access,
    }));

    const results = scoreResults({ bm25 });
    expect(results[0].content).toContain('PostgreSQL');
    expect(results[results.length - 1].content).toContain('Redis');
  });

  it('chunking preserves all searchable keywords', () => {
    const conversation = [
      'We discussed PostgreSQL vs MySQL for the main database.',
      'The decision was PostgreSQL due to pgvector for embeddings.',
      'MySQL lacks native vector search support.',
      'We also considered Redis for caching layer.',
    ].join('\n\n').repeat(10); // Make it long enough to chunk

    const chunks = chunkText(conversation);
    const allText = chunks.join(' ');

    expect(allText).toContain('PostgreSQL');
    expect(allText).toContain('MySQL');
    expect(allText).toContain('pgvector');
    expect(allText).toContain('Redis');
  });

  it('stop word filtering preserves technical terms', () => {
    const query = 'what is the PostgreSQL database we chose for vector search';
    const words = query.split(/\s+/)
      .map(w => w.toLowerCase().replace(/[^\w]/g, ''))
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));

    expect(words).toContain('postgresql');
    expect(words).toContain('database');
    expect(words).toContain('chose');
    expect(words).toContain('vector');
    expect(words).toContain('search');
    expect(words).not.toContain('what');
    expect(words).not.toContain('the');
    expect(words).not.toContain('we');
    expect(words).not.toContain('for');
  });

  it('cosine similarity detects related content', () => {
    // Simulated embeddings (not real, but tests the math)
    const postgresEmbed = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4];
    const mysqlEmbed =    [0.85, 0.15, 0.75, 0.25, 0.65, 0.35, 0.55, 0.45];
    const cookingEmbed =  [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];

    const pgSim = cosineSimilarity(postgresEmbed, mysqlEmbed);
    const cookSim = cosineSimilarity(postgresEmbed, cookingEmbed);

    // Database topics should be more similar to each other than to cooking
    expect(pgSim).toBeGreaterThan(cookSim);
    expect(pgSim).toBeGreaterThan(0.9);
  });

  it('message normalization feeds clean data to chunker', () => {
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Internal reasoning here' },
          { type: 'text', text: 'PostgreSQL with pgvector provides native vector search. '.repeat(50) },
        ],
      },
    };

    const normalized = normalizeMessage(entry);
    expect(normalized).not.toBeNull();
    expect(normalized.content).not.toContain('Internal reasoning');

    const chunks = chunkText(normalized.content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain('PostgreSQL');
  });

  it('recency decay integrates correctly with scoring', () => {
    const now = Date.now();

    // Two identical results, different ages
    const results = scoreResults({
      bm25: [
        { content: 'Recent PostgreSQL decision', session_id: 's1', rank: 10, created_at: new Date().toISOString() },
        { content: 'Old PostgreSQL decision', session_id: 's2', rank: 10, created_at: new Date(now - 60 * 86400000).toISOString() },
      ],
    });

    // Both have same rank, but recent one should score higher
    expect(results[0].content).toContain('Recent');
    const scoreDiff = results[0].compositeScore - results[1].compositeScore;
    expect(scoreDiff).toBeGreaterThan(0);
  });

  it('full pipeline: parse, chunk, score, rank', () => {
    // Simulate a complete memory retrieval pipeline
    const rawMessages = [
      { type: 'user', message: { role: 'user', content: 'Should we use PostgreSQL?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes, PostgreSQL with pgvector gives us native vector search for embeddings. '.repeat(30) }] } },
    ];

    // Step 1: Normalize
    const normalized = rawMessages.map(m => normalizeMessage(m)).filter(Boolean);
    expect(normalized).toHaveLength(2);

    // Step 2: Extract text
    const fullText = normalized.map(m => m.content).join('\n\n');

    // Step 3: Chunk
    const chunks = chunkText(fullText);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Step 4: Score (simulate search results)
    const now = Date.now();
    const results = scoreResults({
      bm25: chunks.map((c, i) => ({
        content: c,
        session_id: 's1',
        rank: c.includes('pgvector') ? 8 : 3,
        created_at: new Date().toISOString(),
      })),
    });

    // Step 5: Verify ranking makes sense
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].compositeScore).toBeGreaterThan(0);
  });

  it('handles empty result sets gracefully', () => {
    const results = scoreResults({ bm25: [], vector: [], artifacts: [] });
    expect(results).toEqual([]);
  });

  it('handles mixed sources in same result set', () => {
    const now = new Date().toISOString();
    const results = scoreResults({
      bm25: [{ content: 'keyword hit', session_id: 's1', rank: 5, created_at: now }],
      vector: [{ content: 'semantic match', session_id: 's2', similarity: 0.8, created_at: now }],
      artifacts: [{ id: 'a1', content: 'decision', title: 'DB Choice', salience: 0.9, rank: 3, created_at: now }],
    });

    expect(results).toHaveLength(3);
    const sources = results.map(r => r.source);
    expect(sources).toContain('message');
    expect(sources).toContain('chunk');
    expect(sources).toContain('artifact');
  });

  it('extractTextContent handles all Claude message formats', () => {
    // String content
    expect(extractTextContent('plain text')).toBe('plain text');

    // Content block array
    expect(extractTextContent([
      { type: 'text', text: 'block 1' },
      { type: 'text', text: 'block 2' },
    ])).toBe('block 1\nblock 2');

    // Mixed types
    expect(extractTextContent([
      { type: 'text', text: 'visible' },
      { type: 'image', source: {} },
    ])).toBe('visible');
  });

  it('chunker output feeds cleanly into scorer', () => {
    const text = 'Important database decision. '.repeat(100);
    const chunks = chunkText(text);
    const now = new Date().toISOString();

    const bm25 = chunks.map((c, i) => ({
      content: c,
      session_id: 's1',
      rank: chunks.length - i,
      created_at: now,
    }));

    const results = scoreResults({ bm25 });
    expect(results.length).toBe(chunks.length);
    // All results should have valid composite scores
    for (const r of results) {
      expect(r.compositeScore).toBeGreaterThan(0);
      expect(r.compositeScore).toBeLessThanOrEqual(1);
    }
  });
});
