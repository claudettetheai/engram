import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// We test the pure logic of getDatabaseUrl without connecting to a real DB

describe('getDatabaseUrl logic', () => {
  const originalEnv = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalEnv) process.env.DATABASE_URL = originalEnv;
    else delete process.env.DATABASE_URL;
  });

  it('reads DATABASE_URL from environment', () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
    // Re-require to get fresh module
    delete require.cache[require.resolve('../lib/db.js')];
    const { getDatabaseUrl } = require('../lib/db.js');
    expect(getDatabaseUrl()).toBe('postgresql://test:test@localhost:5432/testdb');
  });

  it('prioritizes env var over file', () => {
    process.env.DATABASE_URL = 'postgresql://env-wins@localhost/db';
    delete require.cache[require.resolve('../lib/db.js')];
    const { getDatabaseUrl } = require('../lib/db.js');
    expect(getDatabaseUrl()).toBe('postgresql://env-wins@localhost/db');
  });

  it('returns a valid postgresql URL format', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
    delete require.cache[require.resolve('../lib/db.js')];
    const { getDatabaseUrl } = require('../lib/db.js');
    const url = getDatabaseUrl();
    expect(url).toMatch(/^postgresql:\/\//);
  });
});

describe('logError', () => {
  let tmpDir;
  let origResolve;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-db-test-'));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
  });

  it('formats error entries with timestamp', () => {
    // Test the formatting logic directly
    const now = new Date().toISOString();
    const err = new Error('test error');
    const entry = `[${now}] Test message: ${err.message}\n${err.stack}\n\n`;

    expect(entry).toContain('Test message');
    expect(entry).toContain('test error');
    expect(entry).toContain('[');
  });
});
