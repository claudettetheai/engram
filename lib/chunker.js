// chunker.js — Split text into ~500-token (~2000 char) chunks
// with 200-char overlap, breaking at paragraph/sentence boundaries

const TARGET_CHUNK_SIZE = 2000; // ~500 tokens
const OVERLAP_SIZE = 200;
const MIN_CHUNK_SIZE = 100;

/**
 * Split text into overlapping chunks suitable for embedding.
 * Breaks at paragraph boundaries first, then sentence boundaries.
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  if (!text || text.length < MIN_CHUNK_SIZE) return text ? [text] : [];
  if (text.length <= TARGET_CHUNK_SIZE) return [text];

  // Split into paragraphs first
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

  const chunks = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    // If adding this paragraph exceeds target, finalize current chunk
    if (currentChunk.length + para.length + 2 > TARGET_CHUNK_SIZE && currentChunk.length > MIN_CHUNK_SIZE) {
      chunks.push(currentChunk.trim());

      // Start new chunk with overlap from end of previous
      const overlap = getOverlap(currentChunk, OVERLAP_SIZE);
      currentChunk = overlap + '\n\n' + para;
    } else if (para.length > TARGET_CHUNK_SIZE) {
      // Paragraph itself is too long — split by sentences
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }

      const sentenceChunks = chunkBySentences(para);
      for (let i = 0; i < sentenceChunks.length; i++) {
        if (i === sentenceChunks.length - 1) {
          currentChunk = sentenceChunks[i];
        } else {
          chunks.push(sentenceChunks[i]);
        }
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(c => c.length >= MIN_CHUNK_SIZE);
}

/**
 * Split a long paragraph by sentence boundaries
 */
function chunkBySentences(text) {
  // Split on sentence endings (.!?) followed by space or newline
  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > TARGET_CHUNK_SIZE && current.length > MIN_CHUNK_SIZE) {
      chunks.push(current.trim());
      const overlap = getOverlap(current, OVERLAP_SIZE);
      current = overlap + ' ' + sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Get the last N characters of text, breaking at a word boundary
 */
function getOverlap(text, size) {
  if (text.length <= size) return text;
  const slice = text.slice(-size);
  // Find first space to avoid cutting mid-word
  const firstSpace = slice.indexOf(' ');
  return firstSpace > 0 ? slice.slice(firstSpace + 1) : slice;
}

module.exports = { chunkText, TARGET_CHUNK_SIZE, OVERLAP_SIZE };
