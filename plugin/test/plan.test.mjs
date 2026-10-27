import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planMounts } from "../lib/plan.mjs";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const ref = (key) => "$" + "{" + key + "}";

test("planMounts merges project over user and expands env", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "forage-plugin-"));
  try {
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    writeJson(path.join(home, "mcp.json"), {
      version: 1,
      servers: {
        demo: { transport: "stdio", command: "npx", args: ["user"], env: { KEY: ref("KEY"), MISSING: ref("NOPE") }, toolCallTimeoutMs: 1111 },
        "user-only": { transport: "stdio", command: "x", env: { MISSING: ref("NOPE") } },
        disabled: { transport: "stdio", command: "x", enabled: false },
        bad: { transport: "stdio" },
        "bad name": { transport: "stdio", command: "x" }
      }
    });
    writeJson(path.join(project, ".dsh", "mcp.json"), {
      version: 1,
      servers: { demo: { transport: "stdio", command: "node", args: ["project"], env: { KEY: ref("KEY") }, toolCallTimeoutMs: 2222 } }
    });
    const plan = planMounts({ home, cwd: project, env: { ...process.env, KEY: "value" } });
    const demo = plan.mounts.find((item) => item.name === "demo");
    assert.ok(demo);
    assert.equal(demo.scope, "project");
    assert.equal(demo.config.command, "node");
    assert.deepEqual(demo.config.args, ["project"]);
    assert.equal(demo.config.env.KEY, "value");
    assert.equal(demo.config.env.MISSING, undefined);
    assert.equal(demo.config.toolCallTimeoutMs, 2222);
    assert.ok(!plan.mounts.some((item) => item.name === "disabled"));
    assert.ok(plan.warnings.some((warning) => warning.includes("NOPE")));
    assert.ok(plan.warnings.some((warning) => warning.includes("bad")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("planMounts maps HTTP to streamable-http and expands headers", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "forage-http-"));
  try {
    const home = path.join(base, "home");
    writeJson(path.join(home, "mcp.json"), {
      version: 1,
      servers: {
        remote: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer " + ref("TOKEN") } }
      }
    });
    const plan = planMounts({ home, cwd: base, projectRoot: undefined, env: { ...process.env, TOKEN: "tok" } });
    const remote = plan.mounts.find((item) => item.name === "remote");
    assert.ok(remote);
    assert.equal(remote.config.transport, "streamable-http");
    assert.equal(remote.config.headers.Authorization, "Bearer tok");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("planMounts returns an empty plan without mcp.json", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "forage-empty-"));
  try {
    const plan = planMounts({ home: path.join(base, "home"), cwd: base, projectRoot: undefined });
    assert.deepEqual(plan.mounts, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("planMounts gives the session overlay highest precedence", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "forage-session-"));
  try {
    const home = path.join(base, "home");
    writeJson(path.join(home, "mcp.json"), {
      version: 1,
      servers: { demo: { transport: "stdio", command: "user" } }
    });
    writeJson(path.join(home, "forage", "session-mcp.json"), {
      version: 1,
      servers: { demo: { transport: "stdio", command: "session" } }
    });
    const plan = planMounts({ home, cwd: base, projectRoot: undefined, env: {} });
    const demo = plan.mounts.find((item) => item.name === "demo");
    assert.ok(demo);
    assert.equal(demo.scope, "session");
    assert.equal(demo.config.command, "session");
    assert.ok(plan.sessionFile.endsWith("session-mcp.json"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
