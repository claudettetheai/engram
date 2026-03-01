import { describe, it, expect } from 'vitest';
import { STOP_WORDS } from '../lib/query-expander.js';

// These tests cover the pure logic parts of query-expander
// without requiring a database connection. Integration tests
// for actual expansion are in the CI pipeline with PostgreSQL.

describe('STOP_WORDS', () => {
  it('contains common English articles', () => {
    expect(STOP_WORDS.has('a')).toBe(true);
    expect(STOP_WORDS.has('an')).toBe(true);
    expect(STOP_WORDS.has('the')).toBe(true);
  });

  it('contains common pronouns', () => {
    expect(STOP_WORDS.has('i')).toBe(true);
    expect(STOP_WORDS.has('you')).toBe(true);
    expect(STOP_WORDS.has('he')).toBe(true);
    expect(STOP_WORDS.has('she')).toBe(true);
    expect(STOP_WORDS.has('we')).toBe(true);
    expect(STOP_WORDS.has('they')).toBe(true);
  });

  it('contains prepositions and conjunctions', () => {
    expect(STOP_WORDS.has('in')).toBe(true);
    expect(STOP_WORDS.has('on')).toBe(true);
    expect(STOP_WORDS.has('and')).toBe(true);
    expect(STOP_WORDS.has('or')).toBe(true);
    expect(STOP_WORDS.has('but')).toBe(true);
  });

  it('does NOT contain meaningful technical words', () => {
    expect(STOP_WORDS.has('database')).toBe(false);
    expect(STOP_WORDS.has('memory')).toBe(false);
    expect(STOP_WORDS.has('search')).toBe(false);
    expect(STOP_WORDS.has('vector')).toBe(false);
    expect(STOP_WORDS.has('postgresql')).toBe(false);
    expect(STOP_WORDS.has('error')).toBe(false);
    expect(STOP_WORDS.has('bug')).toBe(false);
  });

  it('has a reasonable size (40-100 entries)', () => {
    expect(STOP_WORDS.size).toBeGreaterThan(40);
    expect(STOP_WORDS.size).toBeLessThan(100);
  });

  it('all entries are lowercase single words', () => {
    for (const word of STOP_WORDS) {
      expect(word).toBe(word.toLowerCase());
      expect(word).not.toContain(' ');
      expect(word.length).toBeGreaterThan(0);
    }
  });
});

describe('query word extraction logic', () => {
  // Replicates the word extraction logic from expandQuery
  function extractWords(query) {
    return query
      .toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^\w]/g, ''))
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  it('extracts meaningful words from a query', () => {
    const words = extractWords('find the database error from last week');
    expect(words).toContain('find');
    expect(words).toContain('database');
    expect(words).toContain('error');
    expect(words).toContain('last');
    expect(words).toContain('week');
    expect(words).not.toContain('the');
    expect(words).not.toContain('from');
  });

  it('handles special characters in queries', () => {
    const words = extractWords('what happened with @user #bug?!');
    expect(words).toContain('happened');
    expect(words).toContain('user');
    expect(words).toContain('bug');
  });

  it('returns empty for all-stop-word queries', () => {
    const words = extractWords('the a an is it');
    expect(words).toHaveLength(0);
  });

  it('filters single-character words', () => {
    const words = extractWords('I need a fix for x');
    expect(words).not.toContain('x');
    expect(words).toContain('need');
    expect(words).toContain('fix');
  });

  it('lowercases everything', () => {
    const words = extractWords('PostgreSQL HNSW Vector');
    expect(words).toContain('postgresql');
    expect(words).toContain('hnsw');
    expect(words).toContain('vector');
  });
});
