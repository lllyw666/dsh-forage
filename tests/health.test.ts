import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkMcpHealth } from "../src/deploy/health.js";
import { PACKAGE_ROOT } from "./helpers.js";

test("MCP health check completes initialize and tools/list", async () => {
  const server = path.join(PACKAGE_ROOT, "tests", "fixtures", "fake-mcp-server.mjs");
  const result = await checkMcpHealth({
    method: "dsh-install",
    kind: "mcp",
    server: "fake-health",
    transport: "stdio",
    command: process.execPath,
    args: [server],
    timeoutMs: 10000
  }, process.env, 10000);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.tools, ["ping", "echo"]);
});

test("MCP health check reports a missing command", async () => {
  const result = await checkMcpHealth({
    method: "dsh-install",
    kind: "mcp",
    server: "missing",
    transport: "stdio",
    command: "dsh-forage-command-that-does-not-exist",
    args: [],
    timeoutMs: 1000
  }, process.env, 2000);
  assert.equal(result.ok, false);
  assert.match(result.message, /无法启动|退出/);
});
