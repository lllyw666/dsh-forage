import type { Candidate, Intent, RankedCandidate } from "../types.js";
import { clamp, tokenizeForSimilarity } from "../util/text.js";
import { candidateText, rankCandidatesWithBoosts, type RankOptions, type ScoreBoost } from "./index.js";

/** A pluggable embedding source. Implementations must return one vector per input. */
export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, offline fallback: hashed bag-of-tokens vectors. It is not a
 * model embedding, but it gives the same interface and stable numbers for
 * tests, CI, and offline use.
 */
export class HashedEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly dimensions: number;

  constructor(dimensions = 64) {
    this.dimensions = Math.max(8, Math.min(512, Math.trunc(dimensions)));
    this.id = "hashed-lexical-" + String(this.dimensions);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenizeForSimilarity(text)) {
      let hash = 2166136261;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      const index = (hash >>> 0) % this.dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}

/** Cache vectors by provider id + text; a plan never re-embeds the same string. */
export class EmbeddingCache {
  private readonly vectors = new Map<string, number[]>();

  get(providerId: string, text: string): number[] | undefined {
    return this.vectors.get(providerId + "\u0000" + text);
  }

  set(providerId: string, text: string, vector: number[]): void {
    this.vectors.set(providerId + "\u0000" + text, vector);
  }

  get size(): number {
    return this.vectors.size;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clamp(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)), -1, 1);
}

export interface EmbeddingRankOptions extends RankOptions {
  provider?: EmbeddingProvider;
  cache?: EmbeddingCache;
  timeoutMs?: number;
  maxBoost?: number;
}

function queryText(intent: Intent): string {
  return [...intent.tasks, ...intent.signals, ...intent.domains].join(" ");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("embedding provider timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Rank with an embedding boost. Any provider error or timeout falls back to
 * the deterministic lexical ranker; a plan never blocks on a network call.
 */
export async function rankCandidatesWithEmbeddings(
  intent: Intent,
  candidates: Candidate[],
  options: EmbeddingRankOptions = {}
): Promise<RankedCandidate[]> {
  if (candidates.length === 0) return [];
  const provider = options.provider ?? new HashedEmbeddingProvider();
  const cache = options.cache ?? new EmbeddingCache();
  const timeoutMs = Math.max(50, options.timeoutMs ?? 1500);
  const maxBoost = Math.max(0, Math.min(30, options.maxBoost ?? 12));
  const texts = [queryText(intent), ...candidates.map((candidate) => candidateText(candidate))];
  const missing = [...new Set(texts.filter((text) => cache.get(provider.id, text) === undefined))];

  try {
    if (missing.length > 0) {
      const vectors = await withTimeout(provider.embed(missing), timeoutMs);
      if (!Array.isArray(vectors) || vectors.length !== missing.length) {
        throw new Error("embedding provider returned " + String(vectors?.length) + " vectors for " + String(missing.length) + " texts");
      }
      for (let index = 0; index < vectors.length; index += 1) {
        const vector = vectors[index];
        if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error("embedding provider returned an invalid vector at index " + String(index));
        }
        cache.set(provider.id, missing[index] as string, vector);
      }
    }
    const queryVector = cache.get(provider.id, texts[0] as string);
    if (queryVector === undefined) throw new Error("query embedding missing");
    const boosts = new Map<string, ScoreBoost>();
    for (const candidate of candidates) {
      const vector = cache.get(provider.id, candidateText(candidate));
      if (vector === undefined) continue;
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity < 0.05) continue;
      boosts.set(candidate.id, {
        score: Math.round(clamp(similarity, 0, 1) * maxBoost),
        reason: "embedding 相似度 " + (similarity * 100).toFixed(0) + "%"
      });
    }
    return rankCandidatesWithBoosts(intent, candidates, options, boosts);
  } catch {
    return rankCandidatesWithBoosts(intent, candidates, options);
  }
}
