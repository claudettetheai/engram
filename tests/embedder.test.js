import { describe, it, expect } from 'vitest';
import { cosineSimilarity, EMBEDDING_DIM, MODEL_NAME } from '../lib/embedder.js';

// Note: embed() and embedBatch() require the transformers model to be downloaded,
// so we only test them in CI with the full environment. These tests cover
// the pure utility functions and constants.

describe('constants', () => {
  it('embedding dimension is 768', () => {
    expect(EMBEDDING_DIM).toBe(768);
  });

  it('model is BGE base', () => {
    expect(MODEL_NAME).toContain('bge-base');
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 0, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('handles high-dimensional vectors', () => {
    const dim = 768;
    const a = new Array(dim).fill(0).map((_, i) => Math.sin(i));
    const b = new Array(dim).fill(0).map((_, i) => Math.sin(i));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for null/undefined inputs', () => {
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], null)).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  it('returns 0 for mismatched dimensions', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('handles normalized vectors correctly', () => {
    // Pre-normalized vectors (unit length)
    const a = [0.6, 0.8]; // |a| = 1.0
    const b = [0.8, 0.6]; // |b| = 1.0
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.96, 2); // cos(angle) between these two
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('is commutative (sim(a,b) === sim(b,a))', () => {
    const a = [0.3, 0.7, 0.1, 0.9];
    const b = [0.8, 0.2, 0.5, 0.4];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});
