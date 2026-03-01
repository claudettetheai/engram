import { describe, it, expect } from 'vitest';
import { scoreResults, recencyDecay } from '../lib/scorer.js';

describe('scorer — advanced scenarios', () => {
  const now = Date.now();
  const fresh = new Date().toISOString();
  const weekOld = new Date(now - 7 * 86400000).toISOString();
  const monthOld = new Date(now - 30 * 86400000).toISOString();

  it('vector-only results still score', () => {
    const results = scoreResults({
      vector: [
        { content: 'semantic match', session_id: 's1', similarity: 0.85, created_at: fresh },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].compositeScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0.85);
    expect(results[0].bm25Score).toBe(0);
  });

  it('bm25-only results still score', () => {
    const results = scoreResults({
      bm25: [
        { content: 'keyword match', session_id: 's1', rank: 5, created_at: fresh },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].compositeScore).toBeGreaterThan(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it('artifact-only results still score', () => {
    const results = scoreResults({
      artifacts: [
        { id: 'a1', content: 'decision', title: 'Test', salience: 0.8, rank: 3, created_at: fresh },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('artifact');
  });

  it('deduplicates same content from BM25 and vector', () => {
    const results = scoreResults({
      bm25: [
        { content: 'identical content here', session_id: 's1', rank: 8, created_at: fresh },
      ],
      vector: [
        { content: 'identical content here', session_id: 's1', similarity: 0.9, created_at: fresh },
      ],
    });
    // Same session_id + same content prefix = deduplicated
    expect(results).toHaveLength(1);
    // Should have both scores
    expect(results[0].bm25Score).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBeGreaterThan(0);
  });

  it('different sessions are not deduplicated', () => {
    const results = scoreResults({
      bm25: [
        { content: 'same words', session_id: 's1', rank: 5, created_at: fresh },
        { content: 'same words', session_id: 's2', rank: 5, created_at: fresh },
      ],
    });
    expect(results).toHaveLength(2);
  });

  it('handles large result sets', () => {
    const bm25 = Array.from({ length: 50 }, (_, i) => ({
      content: `Result number ${i}`,
      session_id: `s${i}`,
      rank: 50 - i,
      created_at: new Date(now - i * 86400000).toISOString(),
    }));

    const results = scoreResults({ bm25 });
    expect(results).toHaveLength(50);
    // First result should have highest score
    expect(results[0].compositeScore).toBeGreaterThanOrEqual(results[49].compositeScore);
  });

  it('diversity penalty reduces scores for later results', () => {
    const bm25 = Array.from({ length: 5 }, (_, i) => ({
      content: `Item ${i}`,
      session_id: `s${i}`,
      rank: 10, // all same rank
      created_at: fresh, // all same time
    }));

    const results = scoreResults({ bm25 });
    // Later results should have lower scores due to diversity penalty
    for (let i = 1; i < results.length; i++) {
      // All have same relevance/recency, so only diversity changes
      // Note: Map iteration order isn't guaranteed to match rank order,
      // but the diversity penalty should create score variation
      expect(results[0].compositeScore).toBeGreaterThanOrEqual(results[i].compositeScore);
    }
  });

  it('handles missing created_at gracefully', () => {
    const results = scoreResults({
      bm25: [
        { content: 'no date', session_id: 's1', rank: 5 },
      ],
    });
    // Should not throw, should still return result
    expect(results).toHaveLength(1);
  });

  it('handles zero-rank BM25 results', () => {
    const results = scoreResults({
      bm25: [
        { content: 'zero rank', session_id: 's1', rank: 0, created_at: fresh },
        { content: 'has rank', session_id: 's2', rank: 5, created_at: fresh },
      ],
    });
    expect(results).toHaveLength(2);
    const zeroRank = results.find(r => r.content === 'zero rank');
    expect(zeroRank.bm25Score).toBe(0);
  });
});

describe('recencyDecay — edge cases', () => {
  const now = Date.now();

  it('handles future dates (negative age)', () => {
    const future = new Date(now + 86400000).toISOString();
    const decay = recencyDecay(future, now, 0);
    // Future should have high score (> 1.0 is possible, capped to 1.0)
    expect(decay).toBeLessThanOrEqual(1.0);
  });

  it('handles very old dates (years ago)', () => {
    const yearsAgo = new Date(now - 365 * 86400000).toISOString();
    const decay = recencyDecay(yearsAgo, now, 0);
    expect(decay).toBeCloseTo(0, 2); // Should be essentially 0
  });

  it('handles Date objects as well as ISO strings', () => {
    const dateObj = new Date(now - 15 * 86400000);
    const isoStr = dateObj.toISOString();
    const fromObj = recencyDecay(dateObj, now, 0);
    const fromStr = recencyDecay(isoStr, now, 0);
    expect(fromObj).toBeCloseTo(fromStr, 5);
  });

  it('exactly at half-life boundary', () => {
    const exactlyThirty = new Date(now - 30 * 86400000).toISOString();
    const decay = recencyDecay(exactlyThirty, now, 0);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  it('access count of 0 vs 1 makes measurable difference', () => {
    const old = new Date(now - 30 * 86400000).toISOString();
    const noAccess = recencyDecay(old, now, 0);
    const oneAccess = recencyDecay(old, now, 1);
    expect(oneAccess).toBeGreaterThan(noAccess);
    expect(oneAccess - noAccess).toBeCloseTo(0.05, 2); // 0.1 * 0.5 = 0.05
  });
});
