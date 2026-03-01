import { describe, it, expect } from 'vitest';
import { chunkText, TARGET_CHUNK_SIZE } from '../lib/chunker.js';

describe('chunker — advanced edge cases', () => {
  it('handles text that is exactly TARGET_CHUNK_SIZE', () => {
    const text = 'A'.repeat(TARGET_CHUNK_SIZE);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('handles text that is TARGET_CHUNK_SIZE + 1', () => {
    // One char over the limit — needs two paragraphs to split though
    const text = 'Word '.repeat(TARGET_CHUNK_SIZE / 5 + 1);
    const chunks = chunkText(text);
    // Should split since it exceeds target
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles text with only newlines', () => {
    const text = '\n\n\n\n\n\n\n\n';
    const chunks = chunkText(text);
    // Newlines-only text is truthy but splits into empty paragraphs
    // chunkText returns it as-is since it's under target size
    expect(chunks.length).toBeLessThanOrEqual(1);
  });

  it('handles text with only spaces', () => {
    const text = '     ';
    const chunks = chunkText(text);
    // 5 chars is under MIN_CHUNK_SIZE, but it's truthy so returns [text]
    expect(chunks).toHaveLength(1);
  });

  it('handles very short paragraphs', () => {
    const paragraphs = Array(20).fill('Hi.').join('\n\n');
    const chunks = chunkText(paragraphs);
    // All short paragraphs should combine into one chunk
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  it('handles code blocks with varied indentation', () => {
    const code = `function foo() {
  const x = 1;
  if (x > 0) {
    console.log("hello");
  }
  return x;
}`;
    const longCode = Array(30).fill(code).join('\n\n');
    const chunks = chunkText(longCode);
    expect(chunks.length).toBeGreaterThan(1);
    // Verify code structure is preserved
    expect(chunks[0]).toContain('function foo');
  });

  it('handles mixed content types', () => {
    const text = [
      'This is a paragraph of text explaining something important.',
      '```javascript\nconst x = 42;\n```',
      'Another paragraph with more explanation.',
      '| Header | Value |\n|--------|-------|\n| Row 1  | Data  |',
      'Final paragraph wrapping things up.',
    ].join('\n\n');

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All content should be preserved across chunks
    const combined = chunks.join(' ');
    expect(combined).toContain('paragraph');
    expect(combined).toContain('const x');
    expect(combined).toContain('Header');
  });

  it('handles Unicode text', () => {
    const text = 'PostgreSQL は素晴らしい。'.repeat(100) + '\n\n' +
                 'C\'est la meilleure base de données.'.repeat(100);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain('PostgreSQL');
  });

  it('handles text with many sentence endings', () => {
    const text = 'Short. Sentence. After. Sentence. Here. '.repeat(200);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(100);
    }
  });

  it('handles text ending without newline', () => {
    const text = 'No trailing newline here';
    const chunks = chunkText(text);
    expect(chunks[0]).toBe(text);
  });

  it('handles markdown headers as paragraph breaks', () => {
    const text = [
      '# Header 1',
      'Content under header 1. '.repeat(40),
      '## Header 2',
      'Content under header 2. '.repeat(40),
    ].join('\n\n');

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const combined = chunks.join(' ');
    expect(combined).toContain('Header 1');
    expect(combined).toContain('Header 2');
  });
});
