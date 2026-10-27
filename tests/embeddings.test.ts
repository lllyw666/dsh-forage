import test from "node:test";
import assert from "node:assert/strict";
import type { Candidate, Intent } from "../src/types.js";
import { rankCandidates } from "../src/ranker/index.js";
import {
  EmbeddingCache,
  HashedEmbeddingProvider,
  cosineSimilarity,
  rankCandidatesWithEmbeddings,
  type EmbeddingProvider
} from "../src/ranker/embeddings.js";
import { runCli } from "./helpers.js";

const intent: Intent = {
  tasks: ["target"],
  domains: ["research"],
  signals: [],
  constraints: [],
  confidence: 0.5,
  locale: "en"
};

function candidate(id: string, domain: string, description: string): Candidate {
  return {
    id,
    type: "builtin",
    name: id,
    description,
    domains: [domain],
    tasks: [],
    tools: [],
    risk: { level: "low", writes: false, external_requests: false, sensitive_permissions: false },
    credentials: [],
    install: { method: "builtin", provides: ["test"] }
  };
}

const target = candidate("target", "other", "target");
target.tasks = ["target"];
const other = candidate("other", "research", "other");

const fakeProvider: EmbeddingProvider = {
  id: "fake",
  async embed(texts) {
    return texts.map((text) => text.includes("target") ? [1, 0] : [0, 1]);
  }
};

test("embedding provider can change the ranking", async () => {
  const base = rankCandidates(intent, [target, other], { topN: 5 });
  assert.equal(base[0]?.candidate.id, "other");
  const ranked = await rankCandidatesWithEmbeddings(intent, [target, other], {
    topN: 5,
    provider: fakeProvider,
    maxBoost: 40
  });
  assert.equal(ranked[0]?.candidate.id, "target");
  assert.ok((ranked[0]?.reasons ?? []).some((reason) => reason.includes("embedding")));
  assert.ok((ranked[0]?.score ?? 0) > (base.find((entry) => entry.candidate.id === "target")?.score ?? 0));
});

test("embedding cache avoids duplicate provider calls", async () => {
  let calls = 0;
  const provider: EmbeddingProvider = {
    id: "counting",
    async embed(texts) {
      calls += 1;
      return texts.map(() => [1, 0]);
    }
  };
  const cache = new EmbeddingCache();
  await rankCandidatesWithEmbeddings(intent, [target, other], { provider, cache });
  const first = calls;
  await rankCandidatesWithEmbeddings(intent, [target, other], { provider, cache });
  assert.equal(first, 1);
  assert.equal(calls, 1);
  assert.ok(cache.size >= 3);
});

test("embedding failure falls back to the lexical ranker", async () => {
  const provider: EmbeddingProvider = {
    id: "broken",
    async embed() {
      throw new Error("offline");
    }
  };
  const base = rankCandidates(intent, [target, other], { topN: 5 });
  const ranked = await rankCandidatesWithEmbeddings(intent, [target, other], { provider, topN: 5 });
  assert.deepEqual(
    ranked.map((entry) => [entry.candidate.id, entry.score]),
    base.map((entry) => [entry.candidate.id, entry.score])
  );
});

test("hashed embedding provider is deterministic", async () => {
  const provider = new HashedEmbeddingProvider(32);
  const [left, right] = await provider.embed(["hello world", "hello world"]);
  assert.deepEqual(left, right);
  assert.ok(Math.abs(cosineSimilarity(left as number[], right as number[]) - 1) < 1e-9);
});

test("CLI plan exposes the hashed embedding mode", () => {
  const result = runCli(["plan", "检索 RAG 论文", "--json", "--embedding", "hashed"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { embedding: string; candidates: unknown[] };
  assert.equal(payload.embedding, "hashed");
  assert.ok(payload.candidates.length > 0);
});
