import { describe, it, expect } from 'vitest';
import { chunkText, TARGET_CHUNK_SIZE, OVERLAP_SIZE } from '../lib/chunker.js';

describe('chunker', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const text = 'Hello, this is a short message.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('returns single chunk for text under target size', () => {
    const text = 'A'.repeat(TARGET_CHUNK_SIZE - 1);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
  });

  it('splits long text into multiple chunks', () => {
    // Create text with multiple paragraphs exceeding target
    const paragraph = 'This is a test paragraph with enough words to be meaningful. '.repeat(20);
    const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('all chunks meet minimum size', () => {
    const paragraph = 'Sentence one. Sentence two. Sentence three. '.repeat(30);
    const text = [paragraph, paragraph, paragraph].join('\n\n');
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(100);
    }
  });

  it('chunks have overlap between them', () => {
    const para1 = 'First paragraph content with unique words like alpaca and quantum. '.repeat(25);
    const para2 = 'Second paragraph about different topics like databases and vectors. '.repeat(25);
    const text = para1 + '\n\n' + para2;
    const chunks = chunkText(text);

    if (chunks.length >= 2) {
      // The end of chunk N should overlap with start of chunk N+1
      const endOfFirst = chunks[0].slice(-OVERLAP_SIZE);
      // Some portion of the end of first chunk should appear in second chunk
      const overlapWords = endOfFirst.split(' ').filter(w => w.length > 3);
      const hasOverlap = overlapWords.some(word => chunks[1].includes(word));
      expect(hasOverlap).toBe(true);
    }
  });

  it('handles single very long paragraph by splitting on sentences', () => {
    const text = 'This is sentence number one. '.repeat(200); // ~5600 chars, no paragraph breaks
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TARGET_CHUNK_SIZE + OVERLAP_SIZE + 100);
    }
  });

  it('preserves all content (no data loss)', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const paragraphs = words.map(w => `The ${w} section contains important data. `.repeat(20));
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text);

    // Every unique word should appear in at least one chunk
    for (const word of words) {
      const found = chunks.some(c => c.includes(word));
      expect(found).toBe(true);
    }
  });
});
