/**
 * Split text into overlapping chunks suitable for embedding.
 * Breaks at paragraph boundaries first, then sentence boundaries.
 * Target: ~500 tokens (~2000 chars) per chunk with 200-char overlap.
 */
export function chunkText(text: string): string[];

/** Target chunk size in characters (~500 tokens) */
export const TARGET_CHUNK_SIZE: number;

/** Overlap between adjacent chunks in characters */
export const OVERLAP_SIZE: number;
