import test from "node:test";
import assert from "node:assert/strict";
import { deriveDiscoveryQueries, discoverRegistry } from "../src/discovery/registry.js";
import type { Intent } from "../src/types.js";

const intent: Intent = {
  tasks: ["PDF解析"],
  domains: ["research"],
  signals: ["PDF"],
  constraints: [],
  confidence: 0.9,
  locale: "zh"
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("discovery query planner translates common Chinese research tasks", () => {
  const queries = deriveDiscoveryQueries(intent);
  assert.ok(queries.includes("pdf"));
  assert.ok(queries.includes("pdf extract"));
  assert.ok(!queries.includes("research"));
  assert.ok(!queries.includes("PDF解析"));
});

test("discoverRegistry maps npm and remote Registry entries", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("search=pdf")) return response({ servers: [] });
    return response({
      servers: [
        {
          server: {
            name: "io.example/pdf-mcp",
            title: "PDF MCP",
            description: "Read PDFs and extract text.",
            version: "1.2.3",
            repository: { url: "https://github.com/example/pdf-mcp" },
            packages: [{
              registryType: "npm",
              identifier: "@example/pdf-mcp",
              version: "1.2.3",
              runtimeHint: "npx",
              runtimeArguments: [{ type: "positional", value: "-y" }],
              transport: { type: "stdio" },
              environmentVariables: [{ name: "PDF_KEY", isRequired: true }]
            }]
          },
          _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true, status: "active" } }
        },
        {
          server: {
            name: "io.example/remote-pdf",
            title: "Remote PDF",
            description: "Remote PDF service.",
            version: "2.0.0",
            remotes: [{ type: "streamable-http", url: "https://mcp.example.com/pdf" }]
          },
          _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true, status: "active" } }
        }
      ]
    });
  }) as typeof fetch;

  const result = await discoverRegistry(intent, { queries: ["pdf"], fetchImpl, timeoutMs: 1000 });
  assert.equal(result.candidates.length, 2);
  const local = result.candidates.find((candidate) => candidate.name === "PDF MCP");
  assert.ok(local);
  assert.equal(local.install.method, "dsh-install");
  assert.equal(local.install.kind, "mcp");
  if (local.install.method !== "dsh-install" || local.install.kind !== "mcp") throw new Error("expected MCP install");
  assert.equal(local.install.transport, "stdio");
  assert.deepEqual(local.install.args, ["-y", "@example/pdf-mcp@1.2.3"]);
  assert.deepEqual(local.credentials, ["PDF_KEY"]);
  assert.equal(local.risk.level, "high");
  assert.equal(local.discovery?.source, "registry");
  assert.equal(local.discovery?.sourcePriority, 0.9);

  const remote = result.candidates.find((candidate) => candidate.name === "Remote PDF");
  assert.ok(remote);
  assert.equal(remote.install.method, "dsh-install");
  if (remote.install.method !== "dsh-install" || remote.install.kind !== "mcp") throw new Error("expected MCP install");
  assert.equal(remote.install.transport, "http");
  assert.equal(remote.install.url, "https://mcp.example.com/pdf");
});
