const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "with", "you", "your",
  "请", "帮我", "帮忙", "一下", "我们", "我的", "需要", "可以", "进行", "以及",
  "并", "和", "的", "了", "在", "把", "将", "给", "我", "这", "那", "些"
]);

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match an ASCII term on word boundaries while keeping CJK substring
 * matching. This avoids "word" matching "password" without requiring a
 * Chinese tokenizer for the common task words.
 */
export function containsTerm(haystack: string, term: string): boolean {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedTerm = normalizeText(term).trim();
  if (normalizedTerm === "") return false;
  if (/[a-z]/.test(normalizedTerm) && /^[a-z0-9][a-z0-9 .+#_-]*$/i.test(normalizedTerm)) {
    const escaped = escapeRegExp(normalizedTerm).replace(/\\ /g, "\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedHaystack);
  }
  return normalizedHaystack.includes(normalizedTerm);
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

export function tokenizeForSimilarity(value: string): Set<string> {
  const normalized = normalizeText(value);
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    if (token.length >= 2 && !STOP_WORDS.has(token)) tokens.add(token);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length <= 6 && !STOP_WORDS.has(run)) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOP_WORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

export function lexicalSimilarity(left: string, right: string): number {
  const a = tokenizeForSimilarity(left);
  const b = tokenizeForSimilarity(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
