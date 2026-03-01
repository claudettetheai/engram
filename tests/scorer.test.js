import { describe, it, expect } from 'vitest';
import { scoreResults, recencyDecay } from '../lib/scorer.js';

describe('recencyDecay', () => {
  it('returns ~1.0 for items created now', () => {
    const now = Date.now();
    const decay = recencyDecay(new Date(now).toISOString(), now, 0);
    expect(decay).toBeCloseTo(1.0, 1);
  });

  it('returns ~0.5 for items 30 days old (half-life)', () => {
    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const decay = recencyDecay(thirtyDaysAgo, now, 0);
    expect(decay).toBeCloseTo(0.5, 1);
  });

  it('returns ~0.25 for items 60 days old', () => {
    const now = Date.now();
    const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
    const decay = recencyDecay(sixtyDaysAgo, now, 0);
    expect(decay).toBeCloseTo(0.25, 1);
  });

  it('access count reinforces against decay', () => {
    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const noAccess = recencyDecay(thirtyDaysAgo, now, 0);
    const withAccess = recencyDecay(thirtyDaysAgo, now, 5);

    expect(withAccess).toBeGreaterThan(noAccess);
  });

  it('caps reinforcement at 10 accesses', () => {
    const now = Date.now();
    const old = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();

    const at10 = recencyDecay(old, now, 10);
    const at100 = recencyDecay(old, now, 100);

    expect(at10).toBeCloseTo(at100, 5);
  });

  it('never exceeds 1.0', () => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    const decay = recencyDecay(recent, now, 10);
    expect(decay).toBeLessThanOrEqual(1.0);
  });
});

describe('scoreResults', () => {
  it('returns empty array for empty input', () => {
    const results = scoreResults({ bm25: [], vector: [], artifacts: [] });
    expect(results).toEqual([]);
  });

  it('scores and sorts BM25 results', () => {
    const bm25 = [
      { content: 'low rank', session_id: 's1', rank: 1, created_at: new Date().toISOString() },
      { content: 'high rank', session_id: 's2', rank: 10, created_at: new Date().toISOString() },
    ];

    const results = scoreResults({ bm25 });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('high rank');
    expect(results[0].compositeScore).toBeGreaterThan(results[1].compositeScore);
  });

  it('merges BM25 and vector results for same content', () => {
    const now = new Date().toISOString();
    const bm25 = [{ content: 'shared content', session_id: 's1', rank: 5, created_at: now }];
    const vector = [{ content: 'shared content', session_id: 's1', similarity: 0.9, created_at: now }];

    const results = scoreResults({ bm25, vector });
    // Should merge into one result, not two
    expect(results).toHaveLength(1);
    expect(results[0].bm25Score).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBeGreaterThan(0);
  });

  it('includes artifacts in results', () => {
    const artifacts = [
      { id: 'a1', content: 'decision', title: 'Chose PostgreSQL', salience: 0.9, rank: 5, created_at: new Date().toISOString() },
    ];

    const results = scoreResults({ artifacts });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('artifact');
  });

  it('recent items score higher than old items', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const bm25 = [
      { content: 'recent', session_id: 's1', rank: 5, created_at: now },
      { content: 'ancient', session_id: 's2', rank: 5, created_at: old },
    ];

    const results = scoreResults({ bm25 });
    expect(results[0].content).toBe('recent');
  });

  it('high salience artifacts outrank low salience', () => {
    const now = new Date().toISOString();
    const artifacts = [
      { id: 'a1', content: 'low', title: 'Low', salience: 0.1, rank: 5, created_at: now },
      { id: 'a2', content: 'high', title: 'High', salience: 0.95, rank: 5, created_at: now },
    ];

    const results = scoreResults({ artifacts });
    expect(results[0].content).toBe('high');
  });
});
