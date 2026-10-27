import type { EmbeddingProvider } from "./embeddings.js";

export interface HttpEmbeddingOptions {
  url: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function isValidVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function extractVectors(payload: unknown): number[][] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.embeddings) && record.embeddings.every(isValidVector)) {
    return record.embeddings;
  }
  if (Array.isArray(record.data)) {
    const vectors = record.data.map((item) => {
      if (typeof item !== "object" || item === null) return undefined;
      const embedding = (item as Record<string, unknown>).embedding;
      return isValidVector(embedding) ? embedding : undefined;
    });
    if (vectors.every((vector): vector is number[] => vector !== undefined)) return vectors;
  }
  return undefined;
}

/**
 * OpenAI-compatible /api/embed HTTP provider. It is deliberately small and
 * provider-agnostic: the caller owns the endpoint, model, and credentials.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly options: HttpEmbeddingOptions;

  constructor(options: HttpEmbeddingOptions) {
    if (!/^https?:\/\//i.test(options.url)) {
      throw new Error("embedding URL must be http(s)");
    }
    this.options = options;
    const model = options.model ?? "default";
    let hash = 2166136261;
    for (const char of options.url) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    this.id = "http-" + model + "-" + (hash >>> 0).toString(16);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timeoutMs = Math.max(100, this.options.timeoutMs ?? 8000);
    const timer = setTimeout(() => controller.abort(new Error("embedding request timed out")), timeoutMs);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.options.headers ?? {})
    };
    if (this.options.apiKey !== undefined && this.options.apiKey !== "") {
      headers.authorization = "Bearer " + this.options.apiKey;
    }
    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: texts, model: this.options.model ?? "default" }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("embedding HTTP " + String(response.status) + " " + response.statusText);
      }
      const payload = await response.json();
      const vectors = extractVectors(payload);
      if (vectors === undefined || vectors.length !== texts.length) {
        throw new Error("embedding response did not contain one vector per input");
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function httpEmbeddingFromEnv(env: NodeJS.ProcessEnv = process.env): HttpEmbeddingOptions | undefined {
  const url = env.DSH_FORAGE_EMBEDDING_URL?.trim();
  if (url === undefined || url === "") return undefined;
  const model = env.DSH_FORAGE_EMBEDDING_MODEL?.trim();
  const apiKey = env.DSH_FORAGE_EMBEDDING_API_KEY;
  return {
    url,
    ...(model === undefined || model === "" ? {} : { model }),
    ...(apiKey === undefined || apiKey === "" ? {} : { apiKey })
  };
}
