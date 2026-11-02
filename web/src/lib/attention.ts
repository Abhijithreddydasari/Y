// Scaled dot-product attention over toy embeddings, computed locally for the attention widget.
// The model only supplies tokens and a temperature; every score here is derived deterministically,
// so the same spec always shows the same weights. These are not a real model's weights.

export const DIM = 8;
const EMBED_SCALE = 2.2; // large enough that unscaled dot products visibly saturate softmax

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function random(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vector(seed: number): number[] {
  const next = random(seed);
  return Array.from({ length: DIM }, () => (next() * 2 - 1) * EMBED_SCALE);
}

// Fixed small projections (identity plus seeded noise), so attention is not just self-similarity.
const W_Q = Array.from({ length: DIM }, (_, i) => vector(1000 + i).map((v) => v / EMBED_SCALE / Math.sqrt(DIM)));
const W_K = Array.from({ length: DIM }, (_, i) => vector(2000 + i).map((v) => v / EMBED_SCALE / Math.sqrt(DIM)));

function project(weights: number[][], v: number[]): number[] {
  return weights.map((row, i) => row.reduce((sum, w, j) => sum + w * v[j], 0) + v[i]);
}

/** Token embedding: hashed word vector plus a sinusoidal position term. */
export function embed(token: string, position: number): number[] {
  const base = vector(hash(token.toLowerCase()));
  return base.map((v, i) => v + 0.6 * (i % 2 ? Math.cos : Math.sin)(position / Math.pow(10, (2 * Math.floor(i / 2)) / DIM)));
}

export function softmax(scores: readonly number[]): number[] {
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / total);
}

export interface AttentionResult { scores: number[][]; weights: number[][] }

/** weights[i][j]: how much query token i attends to key token j. Rows sum to 1. */
export function attention(tokens: readonly string[], temperature: number, scaled = true): AttentionResult {
  const embeddings = tokens.map((t, i) => embed(t, i));
  const queries = embeddings.map((e) => project(W_Q, e));
  const keys = embeddings.map((e) => project(W_K, e));
  const divisor = (scaled ? Math.sqrt(DIM) : 1) * Math.max(temperature, 1e-3);
  const scores = queries.map((q) => keys.map((k) => q.reduce((sum, v, i) => sum + v * k[i], 0) / divisor));
  return { scores, weights: scores.map(softmax) };
}
