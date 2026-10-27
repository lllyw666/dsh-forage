import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStatus } from "../src/scopes/status.js";
import { mcpAddArgs } from "../src/scopes/mcp.js";
import { scopeContext } from "../src/scopes/paths.js";
import { previewTransfer, transferItem } from "../src/scopes/transfer.js";
import { ScopeError } from "../src/scopes/types.js";
import type { DeploymentRunner, RunResult } from "../src/types.js";
import { runCli } from "./helpers.js";

function makeScope(): { base: string; project: string; home: string; env: NodeJS.ProcessEnv } {
  const base = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-scope-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(path.join(project, ".dsh"), { recursive: true });
  mkdirSync(path.join(home, "skills"), { recursive: true });
  return { base, project, home, env: { ...process.env, DSH_HOME: home } };
}

function writeMcp(file: string, servers: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, servers }, null, 2) + "\n", "utf8");
}

function writeSkill(file: string, name: string, body = "body"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: " + name + "\ndescription: test skill\n---\n\n# " + name + "\n" + body + "\n", "utf8");
}

function fakeRunner(calls: string[][]): DeploymentRunner {
  return {
    async run(args): Promise<RunResult> {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", durationMs: 1 };
    }
  };
}

test("status 合并 user/project 并标记同名遮蔽", () => {
  const s = makeScope();
  try {
    writeMcp(path.join(s.home, "mcp.json"), { shared: { transport: "stdio", command: "user-cmd", args: [] } });
    writeMcp(path.join(s.project, ".dsh", "mcp.json"), { shared: { transport: "stdio", command: "project-cmd", args: [] } });
    writeSkill(path.join(s.home, "skills", "shared.md"), "shared");
    writeSkill(path.join(s.project, ".dsh", "skills", "shared", "SKILL.md"), "shared");
    const payload = buildStatus(scopeContext(s.project, s.env), []);
    assert.equal(payload.mcps.length, 2);
    assert.equal(payload.skills.length, 2);
    assert.equal(payload.mcps.find((item) => item.scope === "user")?.shadowedBy, "project");
    assert.equal(payload.skills.find((item) => item.scope === "user")?.shadowedBy, "project");
    assert.equal(payload.summary.userMcps, 1);
    assert.equal(payload.summary.projectMcps, 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("MCP 迁移参数保留命令、参数和环境变量引用", () => {
  const args = mcpAddArgs("demo", {
    transport: "stdio",
    command: "npx",
    args: ["-y", "demo-mcp"],
    env: { DEMO_KEY: "$" + "{DEMO_KEY}" },
    toolCallTimeoutMs: 5000
  }, "user");
  assert.deepEqual(args, [
    "--profile", "install", "mcp", "add", "demo",
    "--scope", "user", "--transport", "stdio",
    "-e", "DEMO_KEY", "--timeout", "5000", "--", "npx", "-y", "demo-mcp"
  ]);
  assert.throws(
    () => mcpAddArgs("bad", { transport: "stdio", command: "npx", env: { DEMO_KEY: "literal" } }, "user"),
    (error: unknown) => error instanceof ScopeError && error.code === "MCP_ENV_LITERAL"
  );
});

test("MCP 迁移把 streamable-http 映射回 dsh-install 的 http", () => {
  const args = mcpAddArgs("demo", {
    transport: "streamable-http",
    url: "https://example.com/mcp",
    headers: { "X-Test": "1" }
  }, "user");
  assert.equal(args[args.indexOf("--transport") + 1], "http");
  assert.equal(args[args.indexOf("--url") + 1], "https://example.com/mcp");
  assert.ok(args.includes("--header"));
});

test("promote MCP 预览包含目标安装和源移除", () => {
  const s = makeScope();
  try {
    writeMcp(path.join(s.project, ".dsh", "mcp.json"), { alpha: { transport: "stdio", command: "npx", args: ["-y", "alpha-mcp"] } });
    const plan = previewTransfer({
      direction: "promote", id: "alpha", cwd: s.project, env: s.env,
      dryRun: true, yes: false, keepSource: false, replace: false, backend: "dsh-install"
    });
    assert.equal(plan.sourceScope, "project");
    assert.equal(plan.targetScope, "user");
    assert.ok(plan.commands.some((command) => command.includes("mcp add alpha --scope user")));
    assert.ok(plan.commands.some((command) => command.includes("mcp remove alpha --scope project")));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("promote MCP 逐项执行并使用 fake runner", async () => {
  const s = makeScope();
  try {
    writeMcp(path.join(s.project, ".dsh", "mcp.json"), { alpha: { transport: "stdio", command: "npx", args: ["-y", "alpha-mcp"] } });
    const calls: string[][] = [];
    const result = await transferItem({
      direction: "promote", id: "alpha", cwd: s.project, env: s.env,
      dryRun: false, yes: true, keepSource: false, replace: false,
      runner: fakeRunner(calls)
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "promoted");
    assert.deepEqual(calls[0], [
      "--profile", "install", "mcp", "add", "alpha",
      "--scope", "user", "--transport", "stdio", "--", "npx", "-y", "alpha-mcp"
    ]);
    assert.deepEqual(calls[1], ["--profile", "install", "mcp", "remove", "alpha", "--scope", "project"]);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("目标作用域同名项需要 --replace", async () => {
  const s = makeScope();
  try {
    writeMcp(path.join(s.project, ".dsh", "mcp.json"), { alpha: { transport: "stdio", command: "project" } });
    writeMcp(path.join(s.home, "mcp.json"), { alpha: { transport: "stdio", command: "user" } });
    await assert.rejects(
      transferItem({
        direction: "promote", id: "alpha", cwd: s.project, env: s.env,
        dryRun: false, yes: true, keepSource: false, replace: false,
        runner: fakeRunner([])
      }),
      (error: unknown) => error instanceof ScopeError && error.code === "TARGET_EXISTS"
    );
    const calls: string[][] = [];
    const result = await transferItem({
      direction: "promote", id: "alpha", cwd: s.project, env: s.env,
      dryRun: false, yes: true, keepSource: false, replace: true,
      runner: fakeRunner(calls)
    });
    assert.equal(result.ok, true);
    assert.ok(calls[0]?.includes("remove"));
    assert.ok(calls[1]?.includes("add"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("promote Skill 复制到用户级、更新清单并删除项目副本", async () => {
  const s = makeScope();
  try {
    writeSkill(path.join(s.project, ".dsh", "skills", "paper.md"), "paper");
    const result = await transferItem({
      direction: "promote", id: "paper", cwd: s.project, env: s.env,
      dryRun: false, yes: true, keepSource: false, replace: false
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "promoted");
    assert.equal(existsSync(path.join(s.home, "skills", "paper.md")), true);
    assert.equal(existsSync(path.join(s.project, ".dsh", "skills", "paper.md")), false);
    const manifest = JSON.parse(readFileSync(path.join(s.home, "skills-manifest.json"), "utf8")) as {
      skills: Record<string, { scope: string; target: string }>;
    };
    assert.equal(manifest.skills.paper?.scope, "user");
    assert.equal(manifest.skills.paper?.target, path.join(s.home, "skills", "paper.md"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("demote Skill 复制到项目级并移除用户副本", async () => {
  const s = makeScope();
  try {
    writeSkill(path.join(s.home, "skills", "tool.md"), "tool");
    const result = await transferItem({
      direction: "demote", id: "tool", cwd: s.project, env: s.env,
      dryRun: false, yes: true, keepSource: false, replace: false
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(s.project, ".dsh", "skills", "tool.md")), true);
    assert.equal(existsSync(path.join(s.home, "skills", "tool.md")), false);
    const manifest = JSON.parse(readFileSync(path.join(s.home, "skills-manifest.json"), "utf8")) as {
      skills: Record<string, { scope: string }>;
    };
    assert.equal(manifest.skills.tool?.scope, "project");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("没有 .git 时拒绝 project 迁移", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-no-git-"));
  try {
    const project = path.join(base, "plain");
    mkdirSync(project, { recursive: true });
    assert.throws(
      () => previewTransfer({
        direction: "promote", id: "x", cwd: project, env: { ...process.env, DSH_HOME: path.join(base, "home") },
        dryRun: true, yes: false, keepSource: false, replace: false
      }),
      (error: unknown) => error instanceof ScopeError && error.code === "PROJECT_SCOPE_WITHOUT_GIT"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI status 和 promote --dry-run 输出纯 JSON", () => {
  const s = makeScope();
  try {
    writeMcp(path.join(s.project, ".dsh", "mcp.json"), { alpha: { transport: "stdio", command: "npx", args: ["-y", "alpha-mcp"] } });
    const status = runCli(["status", "--json"], { cwd: s.project, env: s.env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout) as { mode: string; projectRoot: string; mcps: Array<{ name: string; scope: string }> };
    assert.equal(statusPayload.mode, "status");
    assert.equal(statusPayload.projectRoot, s.project);
    assert.equal(statusPayload.mcps[0]?.name, "alpha");
    assert.equal(statusPayload.mcps[0]?.scope, "project");
    const promote = runCli(["promote", "--id", "alpha", "--dry-run", "--json"], { cwd: s.project, env: s.env });
    assert.equal(promote.status, 0, promote.stderr);
    const promotePayload = JSON.parse(promote.stdout) as { mode: string; result: { status: string } };
    assert.equal(promotePayload.mode, "plan");
    assert.equal(promotePayload.result.status, "planned");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
