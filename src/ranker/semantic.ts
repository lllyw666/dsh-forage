import type { Candidate, Intent } from "../types.js";
import { lexicalSimilarity } from "../util/text.js";

/**
 * Deterministic v0.1 semantic fallback. It is intentionally lexical rather
 * than an embedding call: no API key, no network, reproducible ranking.
 * A future embedding provider can implement the same shape.
 */
export function semanticScore(intent: Intent, candidate: Candidate): number {
  const query = [...intent.tasks, ...intent.signals, ...intent.domains].join(" ");
  const document = [
    candidate.name,
    candidate.description,
    ...candidate.tasks,
    ...candidate.tools,
    ...candidate.domains
  ].join(" ");
  return lexicalSimilarity(query, document);
}
