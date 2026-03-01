/**
 * Generate embedding for a single text string.
 * Uses BGE-base-en-v1.5 (768 dimensions) locally via @xenova/transformers.
 * Model is lazy-loaded on first call.
 *
 * @param text - Text to embed (max ~8000 chars)
 * @returns 768-dimensional embedding vector
 */
export function embed(text: string): Promise<number[]>;

/**
 * Generate embeddings for multiple texts.
 * Non-fatal per item — returns null for failed embeddings.
 *
 * @param texts - Array of texts to embed
 * @returns Array of 768-dim vectors (or null for failures)
 */
export function embedBatch(texts: string[]): Promise<(number[] | null)[]>;

/**
 * Compute cosine similarity between two vectors.
 *
 * @returns Similarity score (-1 to 1 for general vectors, 0 to 1 for normalized)
 */
export function cosineSimilarity(a: number[], b: number[]): number;

/** Embedding dimension (768 for BGE-base-en-v1.5) */
export const EMBEDDING_DIM: number;

/** Model identifier */
export const MODEL_NAME: string;
