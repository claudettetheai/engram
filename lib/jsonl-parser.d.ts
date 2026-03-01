export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  toolName: string | null;
  turnNumber?: number;
  rawType: string;
  timestamp: string | null;
  isToolResult: boolean;
}

export interface ParseResult {
  messages: NormalizedMessage[];
  newOffset: number;
  turnCount: number;
}

export interface TranscriptInfo {
  path: string;
  sessionId: string;
  size: number;
  modified: Date;
  projectName: string;
}

/**
 * Parse a Claude Code JSONL transcript file, optionally from a byte offset.
 * Supports incremental parsing for cursor-based resume.
 */
export function parseTranscript(filePath: string, byteOffset?: number): ParseResult;

/**
 * Find all JSONL transcript files across Claude Code project directories.
 */
export function findTranscripts(projectDir?: string): TranscriptInfo[];

/**
 * Normalize a raw JSONL entry into standard format.
 * Returns null for entries that should be skipped.
 */
export function normalizeMessage(entry: Record<string, unknown>): NormalizedMessage | null;

/**
 * Extract text content from message content (string or content block array).
 */
export function extractTextContent(content: unknown): string | null;
