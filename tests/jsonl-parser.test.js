import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeMessage, extractTextContent } from '../lib/jsonl-parser.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('extractTextContent', () => {
  it('returns string content as-is', () => {
    expect(extractTextContent('hello world')).toBe('hello world');
  });

  it('extracts text from content blocks array', () => {
    const content = [
      { type: 'text', text: 'First part' },
      { type: 'text', text: 'Second part' },
    ];
    expect(extractTextContent(content)).toBe('First part\nSecond part');
  });

  it('handles mixed block types', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'image', source: 'base64...' },
      { type: 'text', text: 'World' },
    ];
    expect(extractTextContent(content)).toBe('Hello\nWorld');
  });

  it('handles plain string in array', () => {
    const content = ['just a string'];
    expect(extractTextContent(content)).toBe('just a string');
  });

  it('returns null for non-string non-array', () => {
    expect(extractTextContent(null)).toBeNull();
    expect(extractTextContent(undefined)).toBeNull();
    expect(extractTextContent(42)).toBeNull();
  });

  it('handles empty array', () => {
    expect(extractTextContent([])).toBe('');
  });
});

describe('normalizeMessage', () => {
  it('normalizes a user text message', () => {
    const entry = {
      type: 'user',
      message: { role: 'user', content: 'What database are we using?' },
      timestamp: '2026-02-28T12:00:00Z',
    };
    const result = normalizeMessage(entry);
    expect(result).not.toBeNull();
    expect(result.role).toBe('user');
    expect(result.content).toBe('What database are we using?');
    expect(result.isToolResult).toBe(false);
  });

  it('normalizes a user message with content blocks', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello from blocks' }],
      },
    };
    const result = normalizeMessage(entry);
    expect(result.role).toBe('user');
    expect(result.content).toBe('Hello from blocks');
  });

  it('normalizes an assistant message', () => {
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is my response' }],
      },
    };
    const result = normalizeMessage(entry);
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('Here is my response');
  });

  it('detects tool_result in user messages', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'File contents here with enough text to pass min length' },
        ],
      },
    };
    const result = normalizeMessage(entry);
    expect(result).not.toBeNull();
    expect(result.role).toBe('tool_result');
    expect(result.isToolResult).toBe(true);
  });

  it('skips thinking blocks in assistant messages', () => {
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Internal reasoning...' },
          { type: 'text', text: 'Visible response' },
        ],
      },
    };
    const result = normalizeMessage(entry);
    expect(result.content).toBe('Visible response');
    expect(result.content).not.toContain('Internal reasoning');
  });

  it('includes tool_use info in assistant messages', () => {
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file' },
          { type: 'tool_use', name: 'Read', input: { path: '/foo/bar.js' } },
        ],
      },
    };
    const result = normalizeMessage(entry);
    expect(result.content).toContain('Let me read that file');
    expect(result.content).toContain('[Tool: Read]');
  });

  it('returns null for messages without message field', () => {
    expect(normalizeMessage({ type: 'progress' })).toBeNull();
    expect(normalizeMessage({})).toBeNull();
  });

  it('returns null for very short content', () => {
    const entry = {
      type: 'user',
      message: { role: 'user', content: 'x' },
    };
    expect(normalizeMessage(entry)).toBeNull();
  });

  it('truncates very long content', () => {
    const longContent = 'A'.repeat(100000);
    const entry = {
      type: 'user',
      message: { role: 'user', content: longContent },
    };
    const result = normalizeMessage(entry);
    expect(result.content.length).toBeLessThan(60000);
    expect(result.content).toContain('[truncated]');
  });
});

describe('parseTranscript', () => {
  // We import dynamically to avoid issues with the fs dependency
  let parseTranscript;
  let tmpDir;
  let tmpFile;

  beforeAll(async () => {
    const mod = await import('../lib/jsonl-parser.js');
    parseTranscript = mod.parseTranscript;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
    tmpFile = path.join(tmpDir, 'test-session.jsonl');

    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello there' }, timestamp: '2026-02-28T12:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi! How can I help?' }] }, timestamp: '2026-02-28T12:00:01Z' }),
      JSON.stringify({ type: 'progress', progress: 50 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'What is Engram?' }, timestamp: '2026-02-28T12:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Engram is a memory system for AI agents.' }] }, timestamp: '2026-02-28T12:00:03Z' }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
  });

  it('parses a JSONL file', () => {
    const result = parseTranscript(tmpFile);
    expect(result.messages.length).toBe(4); // 2 user + 2 assistant (progress skipped)
    expect(result.turnCount).toBe(2); // 2 user turns
    expect(result.newOffset).toBeGreaterThan(0);
  });

  it('skips progress entries', () => {
    const result = parseTranscript(tmpFile);
    const types = result.messages.map(m => m.rawType);
    expect(types).not.toContain('progress');
  });

  it('returns empty for non-existent file', () => {
    const result = parseTranscript('/nonexistent/file.jsonl');
    expect(result.messages).toHaveLength(0);
    expect(result.turnCount).toBe(0);
  });

  it('supports byte offset resume', () => {
    // First parse to get offset
    const first = parseTranscript(tmpFile);
    // Parse again from end — should get nothing new
    const second = parseTranscript(tmpFile, first.newOffset);
    expect(second.messages).toHaveLength(0);
  });
});
