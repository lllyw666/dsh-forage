import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog } from "../src/catalog/schema.js";
import { loadRealCatalog } from "./helpers.js";

function validCatalog(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    domain: "research",
    capabilities: [
      {
        id: "example",
        type: "mcp",
        name: "Example",
        description: "example",
        domains: ["research"],
        tasks: ["文献检索"],
        tools: ["search"],
        risk: { level: "low", writes: false, external_requests: true, sensitive_permissions: false },
        credentials: [],
        install: {
          method: "dsh-install",
          kind: "mcp",
          server: "example",
          transport: "stdio",
          command: "npx",
          args: ["-y", "example"]
        }
      }
    ]
  };
}

test("真实 catalog 通过校验并包含 8 个候选", async () => {
  const catalog = await loadRealCatalog();
  assert.equal(catalog.capabilities.length, 8);
  assert.ok(catalog.capabilities.some((candidate) => candidate.id === "arxiv"));
  assert.ok(catalog.capabilities.some((candidate) => candidate.id === "office-builtin"));
});

test("凭证必须同时出现在 MCP install.env 中", () => {
  const catalog = validCatalog();
  const candidate = (catalog.capabilities as Array<Record<string, unknown>>)[0];
  assert.ok(candidate);
  candidate.credentials = ["EXAMPLE_KEY"];
  assert.throws(() => validateCatalog(catalog, "test.json"), /install.env/);
});

test("重复 ID 在单个文件内被拒绝", () => {
  const catalog = validCatalog();
  const candidate = (catalog.capabilities as Array<Record<string, unknown>>)[0];
  assert.ok(candidate);
  (catalog.capabilities as Array<Record<string, unknown>>).push({ ...candidate });
  assert.throws(() => validateCatalog(catalog, "test.json"), /重复的能力 ID/);
});

test("缺少风险字段会被拒绝", () => {
  const catalog = validCatalog();
  const candidate = (catalog.capabilities as Array<Record<string, unknown>>)[0];
  assert.ok(candidate);
  delete (candidate.risk as Record<string, unknown>).writes;
  assert.throws(() => validateCatalog(catalog, "test.json"), /writes/);
});
