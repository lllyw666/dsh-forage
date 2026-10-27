import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpEmbeddingProvider, httpEmbeddingFromEnv } from "../src/ranker/http-embedding.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run("http://127.0.0.1:" + String(address.port) + "/embed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("HttpEmbeddingProvider reads OpenAI-compatible data", async () => {
  let authorization = "";
  let model = "";
  await withServer((request, response, body) => {
    authorization = String(request.headers.authorization ?? "");
    model = String((body as { model?: string }).model ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }));
  }, async (url) => {
    const provider = new HttpEmbeddingProvider({ url, apiKey: "secret", model: "demo", timeoutMs: 2000 });
    assert.deepEqual(await provider.embed(["a", "b"]), [[1, 0], [0, 1]]);
    assert.equal(authorization, "Bearer secret");
    assert.equal(model, "demo");
  });
});

test("HttpEmbeddingProvider reads Ollama-style embeddings", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ embeddings: [[0.5, 0.5]] }));
  }, async (url) => {
    const provider = new HttpEmbeddingProvider({ url });
    assert.deepEqual(await provider.embed(["one"]), [[0.5, 0.5]]);
  });
});

test("HttpEmbeddingProvider rejects a vector-count mismatch", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  }, async (url) => {
    const provider = new HttpEmbeddingProvider({ url });
    await assert.rejects(() => provider.embed(["a", "b"]), /one vector per input/);
  });
});

test("httpEmbeddingFromEnv requires a URL and carries optional fields", () => {
  assert.equal(httpEmbeddingFromEnv({}), undefined);
  assert.deepEqual(httpEmbeddingFromEnv({
    DSH_FORAGE_EMBEDDING_URL: "http://127.0.0.1:1234/v1/embeddings",
    DSH_FORAGE_EMBEDDING_API_KEY: "k",
    DSH_FORAGE_EMBEDDING_MODEL: "m"
  }), {
    url: "http://127.0.0.1:1234/v1/embeddings",
    apiKey: "k",
    model: "m"
  });
});
