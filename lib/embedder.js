// embedder.js — Local embedding via @xenova/transformers
// Model: Xenova/bge-base-en-v1.5 (768 dimensions)
// Lazy-loads model on first call, reuses pipeline for subsequent calls

const MODEL_NAME = 'Xenova/bge-base-en-v1.5';
const EMBEDDING_DIM = 768;

let pipeline = null;
let pipelinePromise = null;

/**
 * Get or initialize the embedding pipeline (lazy, singleton)
 */
async function getPipeline() {
  if (pipeline) return pipeline;
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    // Dynamic import for ESM module
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = await createPipeline('feature-extraction', MODEL_NAME, {
      quantized: true,
    });
    return pipeline;
  })();

  return pipelinePromise;
}

/**
 * Generate embedding for a single text string
 * @param {string} text
 * @returns {Promise<number[]>} 768-dimensional embedding vector
 */
async function embed(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot embed empty text');
  }

  // BGE models benefit from "Represent this sentence: " prefix for retrieval
  const prefixed = `Represent this sentence: ${text.slice(0, 8000)}`;
  const pipe = await getPipeline();
  const output = await pipe(prefixed, { pooling: 'mean', normalize: true });

  // Convert from tensor to plain array
  const embedding = Array.from(output.data);

  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM} dimensions, got ${embedding.length}`);
  }

  return embedding;
}

/**
 * Generate embeddings for multiple texts (batched)
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    try {
      results.push(await embed(text));
    } catch {
      results.push(null); // Non-fatal per item
    }
  }
  return results;
}

/**
 * Compute cosine similarity between two vectors
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity score (0 to 1 for normalized vectors)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { embed, embedBatch, cosineSimilarity, EMBEDDING_DIM, MODEL_NAME };
