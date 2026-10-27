import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candidate } from "../src/types.js";
import { deployCandidates } from "../src/deploy/orchestrator.js";
import { enableMcpLocal } from "../src/deploy/local.js";
import { readMcpRegistry } from "../src/scopes/mcp.js";
import { previewTransfer, transferItem } from "../src/scopes/transfer.js";
import { findLocalMatches } from "../src/scopes/local-match.js";
import { scopeContext } from "../src/scopes/paths.js";
import { parseIntent } from "../src/intent/parser.js";
import { FAKE_DSH, FIXTURE_CATALOG, loadFixtureCatalog, runCli } from "./helpers.js";

interface Fixture {
  base: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-local-"));
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  mkdirSync(project, { recursive: true });
  return { base, home, project, env: { ...process.env, DSH_HOME: home } };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function mcpCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "demo",
    type: "mcp",
    name: "Demo",
    description: "demo",
    domains: ["research"],
    tasks: ["文献检索"],
    tools: ["search"],
    risk: { level: "low", writes: false, external_requests: true, sensitive_permissions: false },
    credentials: [],
    install: {
      method: "dsh-install",
      kind: "mcp",
      server: "demo",
      transport: "stdio",
      command: "npx",
      args: ["-y", "demo-mcp"],
      timeoutMs: 5000
    },
    ...overrides
  };
}

function skillCandidate(source: string): Candidate {
  return {
    id: "demo-skill",
    type: "skill",
    name: "Demo Skill",
    description: "demo skill",
    domains: ["research"],
    tasks: ["文献检索"],
    tools: [],
    risk: { level: "low", writes: false, external_requests: false, sensitive_permissions: false },
    credentials: [],
    install: { method: "dsh-install", kind: "skill", source }
  };
}

test("本地后端写入 mcp.json，env 只保存引用", async () => {
  const s = makeFixture();
  try {
    const candidate = mcpCandidate({
      credentials: ["DEMO_KEY"],
      install: {
        method: "dsh-install", kind: "mcp", server: "demo", transport: "stdio",
        command: "npx", args: ["-y", "demo-mcp"], env: ["DEMO_KEY"], timeoutMs: 5000
      }
    });
    const report = await deployCandidates([candidate], {
      scope: "user", dryRun: false, yes: true, cwd: s.project,
      env: { ...s.env, DEMO_KEY: "super-secret-value" }, backend: "local"
    });
    assert.equal(report.backend, "local");
    assert.equal(report.results[0]?.backend, "local");
    assert.equal(report.results[0]?.status, "installed");
    const file = path.join(s.home, "mcp.json");
    const registry = readJson(file);
    assert.equal(registry.servers.demo.command, "npx");
    assert.deepEqual(registry.servers.demo.args, ["-y", "demo-mcp"]);
    assert.equal(registry.servers.demo.env.DEMO_KEY, "$" + "{DEMO_KEY}");
    assert.equal(registry.servers.demo.toolCallTimeoutMs, 5000);
    assert.equal(registry.servers.demo.origin.source, "dsh-forage");
    assert.equal(readFileSync(file, "utf8").includes("super-secret-value"), false);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端把 HTTP MCP 写成 streamable-http", async () => {
  const s = makeFixture();
  try {
    const candidate = mcpCandidate({
      install: {
        method: "dsh-install", kind: "mcp", server: "demo-http", transport: "http",
        url: "https://example.com/mcp", headers: ["X-Test: 1"]
      }
    });
    const report = await deployCandidates([candidate], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.results[0]?.status, "installed");
    const entry = readJson(path.join(s.home, "mcp.json")).servers["demo-http"];
    assert.equal(entry.transport, "streamable-http");
    assert.equal(entry.url, "https://example.com/mcp");
    assert.deepEqual(entry.headers, { "X-Test": "1" });
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端保留已有 MCP 并备份旧文件", async () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { other: { transport: "stdio", command: "npx", args: ["other"] } } });
    const report = await deployCandidates([mcpCandidate()], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.results[0]?.status, "installed");
    const registry = readJson(file);
    assert.equal(registry.servers.other.command, "npx");
    assert.equal(registry.servers.demo.command, "npx");
    const backups = readdirSync(s.home).filter((name) => name.startsWith("mcp.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readJson(path.join(s.home, backups[0]!)).servers.other.command, "npx");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端发现已安装时跳过，不覆盖", async () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { demo: { transport: "stdio", command: "existing" } } });
    const before = readFileSync(file, "utf8");
    const report = await deployCandidates([mcpCandidate()], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.exitCode, 0);
    assert.equal(report.results[0]?.status, "skipped");
    assert.match(report.results[0]?.message ?? "", /已.*安装/);
    assert.match(report.results[0]?.fix ?? "", /update/);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端 dry-run 不写文件", async () => {
  const s = makeFixture();
  try {
    const report = await deployCandidates([mcpCandidate()], {
      scope: "user", dryRun: true, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.backend, "local");
    assert.equal(report.results[0]?.status, "planned");
    assert.equal(existsSync(path.join(s.home, "mcp.json")), false);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端按 project scope 写入 .dsh/mcp.json", async () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    const report = await deployCandidates([mcpCandidate()], {
      scope: "project", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.results[0]?.status, "installed");
    assert.equal(existsSync(path.join(s.project, ".dsh", "mcp.json")), true);
    assert.equal(existsSync(path.join(s.home, "mcp.json")), false);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端安装本地 Skill 并更新 manifest", async () => {
  const s = makeFixture();
  try {
    const source = path.join(s.base, "skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\ndescription: demo\n---\n\n# Demo\n", "utf8");
    const report = await deployCandidates([skillCandidate(source)], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.results[0]?.status, "installed");
    assert.equal(existsSync(path.join(s.home, "skills", "demo-skill", "SKILL.md")), true);
    const manifest = readJson(path.join(s.home, "skills-manifest.json"));
    assert.equal(manifest.skills["demo-skill"].scope, "user");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端对无效 GitHub Skill 源给出下载修复提示", async () => {
  const s = makeFixture();
  try {
    const report = await deployCandidates([skillCandidate("github:bad")], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(report.results[0]?.status, "failed");
    assert.match(report.results[0]?.fix ?? "", /GitHub|GITHUB_TOKEN/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端 promote MCP 预览与执行", async () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    writeJson(path.join(s.project, ".dsh", "mcp.json"), {
      version: 1,
      servers: { alpha: { transport: "stdio", command: "npx", args: ["-y", "alpha-mcp"] } }
    });
    const plan = previewTransfer({
      direction: "promote", id: "alpha", cwd: s.project, env: s.env,
      dryRun: true, yes: false, keepSource: false, replace: false, backend: "local"
    });
    assert.ok(plan.commands.some((command) => command.includes("local: write alpha")));
    assert.ok(plan.commands.some((command) => command.includes("local: remove alpha")));
    const result = await transferItem({
      direction: "promote", id: "alpha", cwd: s.project, env: s.env,
      dryRun: false, yes: true, keepSource: false, replace: false, backend: "local"
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "promoted");
    assert.equal(readJson(path.join(s.home, "mcp.json")).servers.alpha.command, "npx");
    assert.equal(readJson(path.join(s.project, ".dsh", "mcp.json")).servers.alpha, undefined);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("CLI --backend local 走本地写入", () => {
  const s = makeFixture();
  try {
    const result = runCli([
      "deploy", "fake-ok",
      "--catalog", FIXTURE_CATALOG,
      "--scope", "user",
      "--yes",
      "--json",
      "--backend", "local"
    ], { cwd: s.project, env: s.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { report: { backend: string; results: Array<{ status: string }> } };
    assert.equal(payload.report.backend, "local");
    assert.equal(payload.report.results[0]?.status, "installed");
    assert.equal(readJson(path.join(s.home, "mcp.json")).servers["fake-ok"].command, "npx");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
test("本地后端 update 覆盖 MCP 并保留旧备份", async () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { demo: { transport: "stdio", command: "old", args: [] } } });
    const report = await deployCandidates([mcpCandidate()], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local", replace: true
    });
    assert.equal(report.results[0]?.status, "installed");
    assert.equal(readJson(file).servers.demo.command, "npx");
    const backups = readdirSync(s.home).filter((name) => name.startsWith("mcp.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readJson(path.join(s.home, backups[0]!)).servers.demo.command, "old");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("session scope 写入临时 MCP 注册表并可删除", () => {
  const s = makeFixture();
  try {
    const sessionFile = path.join(s.home, "forage", "session-mcp.json");
    const deployed = runCli(["deploy", "--id", "fake-ok", "--catalog", FIXTURE_CATALOG, "--scope", "session", "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.equal(deployed.status, 0, deployed.stderr);
    assert.equal(readJson(sessionFile).servers["fake-ok"].command, "npx");
    assert.equal(existsSync(path.join(s.home, "mcp.json")), false);

    const status = runCli(["status", "--scope", "session", "--json"], { cwd: s.project, env: s.env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout) as { summary: { sessionMcps: number }; mcps: Array<{ scope: string }> };
    assert.equal(payload.summary.sessionMcps, 1);
    assert.equal(payload.mcps[0]?.scope, "session");

    const removed = runCli(["remove", "--id", "fake-ok", "--scope", "session", "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(readJson(sessionFile).servers, {});
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("session scope 拒绝 Skill 和 dsh-install 后端", async () => {
  const s = makeFixture();
  try {
    const source = path.join(s.base, "session-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: session-skill\ndescription: test\n---\n", "utf8");
    await assert.rejects(
      () => deployCandidates([skillCandidate(source)], { scope: "session", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local" }),
      (error: unknown) => (error as { code?: string }).code === "SESSION_SKILL_UNSUPPORTED"
    );
    const cli = runCli(["deploy", "--id", "fake-ok", "--catalog", FIXTURE_CATALOG, "--scope", "session", "--dsh-bin", FAKE_DSH, "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.notEqual(cli.status, 0);
    const error = JSON.parse(cli.stdout) as { error: { code: string } };
    assert.equal(error.error.code, "SESSION_BACKEND_UNSUPPORTED");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("plan 标记已安装作用域", () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { "fake-ok": { transport: "stdio", command: "npx", args: ["-y", "fake-ok"] } } });
    const result = runCli(["plan", "文献检索", "--catalog", FIXTURE_CATALOG, "--scope", "user", "--json"], { cwd: s.project, env: s.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { candidates: Array<{ id: string; installedInScope: string | null }> };
    const fake = payload.candidates.find((entry) => entry.id === "fake-ok");
    assert.equal(fake?.installedInScope, "user");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("CLI remove 删除本地 MCP 并备份", () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { demo: { transport: "stdio", command: "npx", args: ["-y", "demo-mcp"] } } });
    const result = runCli(["remove", "--id", "demo", "--scope", "user", "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { mode: string; result: { backup?: string } };
    assert.equal(payload.mode, "remove");
    assert.equal(readJson(file).servers.demo, undefined);
    assert.ok(payload.result.backup !== undefined);
    assert.equal(existsSync(payload.result.backup!), true);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("CLI update 使用 catalog 候选覆盖现有 MCP", () => {
  const s = makeFixture();
  try {
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { "fake-ok": { transport: "stdio", command: "old", args: [] } } });
    const result = runCli(["update", "fake-ok", "--catalog", FIXTURE_CATALOG, "--scope", "user", "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { mode: string; report: { backend: string } };
    assert.equal(payload.mode, "update");
    assert.equal(payload.report.backend, "local");
    assert.equal(readJson(file).servers["fake-ok"].command, "npx");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("本地后端 update/remove Skill", async () => {
  const s = makeFixture();
  try {
    const source = path.join(s.base, "skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\ndescription: v1\n---\n\n# v1\n", "utf8");
    const installed = await deployCandidates([skillCandidate(source)], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local"
    });
    assert.equal(installed.results[0]?.status, "installed");
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\ndescription: v2\n---\n\n# v2\n", "utf8");
    const updated = await deployCandidates([skillCandidate(source)], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, backend: "local", replace: true
    });
    assert.equal(updated.results[0]?.status, "installed");
    const target = path.join(s.home, "skills", "demo-skill", "SKILL.md");
    assert.match(readFileSync(target, "utf8"), /# v2/);
    const backups = readdirSync(path.join(s.home, "backups")).filter((name) => name.startsWith("skill-update-"));
    assert.ok(backups.length >= 1);

    const removed = runCli(["remove", "--id", "demo-skill", "--scope", "user", "--yes", "--json"], { cwd: s.project, env: s.env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path.join(s.home, "skills", "demo-skill")), false);
    assert.equal(readJson(path.join(s.home, "skills-manifest.json")).skills["demo-skill"], undefined);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
test("dsh-install 后端 remove 通过 dsh 执行", () => {
  const s = makeFixture();
  try {
    const log = path.join(s.base, "dsh-calls.jsonl");
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { "fake-ok": { transport: "stdio", command: "npx", args: ["-y", "fake-ok"] } } });
    const result = runCli(["remove", "--id", "fake-ok", "--scope", "user", "--yes", "--json", "--dsh-bin", FAKE_DSH], {
      cwd: s.project, env: { ...s.env, FAKE_DSH_LOG: log }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { mode: string; backend: string; result: { status: string } };
    assert.equal(payload.mode, "remove");
    assert.equal(payload.backend, "dsh-install");
    assert.equal(payload.result.status, "removed");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { args: string[] }).args.join(" "));
    assert.ok(calls[0]?.includes("mcp remove fake-ok"));
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("dsh-install 后端 update 通过 dsh 执行", () => {
  const s = makeFixture();
  try {
    const log = path.join(s.base, "dsh-calls.jsonl");
    const file = path.join(s.home, "mcp.json");
    writeJson(file, { version: 1, servers: { "fake-ok": { transport: "stdio", command: "old", args: [] } } });
    const result = runCli(["update", "--id", "fake-ok", "--catalog", FIXTURE_CATALOG, "--scope", "user", "--yes", "--json", "--dsh-bin", FAKE_DSH], {
      cwd: s.project, env: { ...s.env, FAKE_DSH_LOG: log }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { mode: string; backend: string; status: string };
    assert.equal(payload.mode, "update");
    assert.equal(payload.backend, "dsh-install");
    assert.equal(payload.status, "updated");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { args: string[] }).args.join(" "));
    assert.ok(calls[0]?.includes("mcp update fake-ok"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
test("本地已安装的 nature Skill 会先于 catalog 被发现", () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    const figure = path.join(s.project, ".dsh", "skills", "nature-figure");
    const writing = path.join(s.project, ".dsh", "skills", "nature-writing");
    mkdirSync(figure, { recursive: true });
    mkdirSync(writing, { recursive: true });
    writeFileSync(path.join(figure, "SKILL.md"), "---\nname: nature-figure\ndescription: 科研绘图与论文配图\n---\n\n# Figure\n科研绘图、论文配图。\n", "utf8");
    writeFileSync(path.join(writing, "SKILL.md"), "---\nname: nature-writing\ndescription: 论文撰写与写作\n---\n\n# Writing\n论文撰写、写作。\n", "utf8");
    const matches = findLocalMatches(scopeContext(s.project, s.env), parseIntent("我要进行论文撰写和科研绘图"));
    assert.ok(matches.some((match) => match.kind === "skill" && match.name === "nature-figure" && match.scope === "project"));
    assert.ok(matches.some((match) => match.kind === "skill" && match.name === "nature-writing" && match.scope === "project"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
test("staging writes enabled:false and enable can flip it", async () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    const catalog = await loadFixtureCatalog();
    const base = catalog.capabilities.find((candidate) => candidate.id === "fake-ok");
    assert.ok(base);
    if (base.install.method !== "dsh-install" || base.install.kind !== "mcp") throw new Error("fixture is not an MCP");
    const candidate: Candidate = { ...base, id: "stage-me", name: "Stage Me", install: { ...base.install, server: "stage-me" } };
    const report = await deployCandidates([candidate], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env, activate: false
    });
    assert.equal(report.exitCode, 0, JSON.stringify(report));
    const file = path.join(s.home, "mcp.json");
    const registry = readMcpRegistry(file);
    assert.equal(registry.servers["stage-me"]?.enabled, false);
    enableMcpLocal(scopeContext(s.project, s.env), "user", "stage-me");
    assert.equal(readMcpRegistry(file).servers["stage-me"]?.enabled, true);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("batch failure restores mcp.json and skills", async () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    const catalog = await loadFixtureCatalog();
    const base = catalog.capabilities.find((candidate) => candidate.id === "fake-ok");
    assert.ok(base);
    if (base.install.method !== "dsh-install" || base.install.kind !== "mcp") throw new Error("fixture is not an MCP");
    const ok: Candidate = { ...base, id: "batch-ok", name: "Batch OK", install: { ...base.install, server: "batch-ok" } };
    const bad: Candidate = {
      ...base,
      id: "batch-bad",
      name: "Batch Bad",
      type: "skill",
      install: { method: "dsh-install", kind: "skill", source: path.join(s.project, "missing-skill"), name: "batch-bad" }
    };
    const report = await deployCandidates([ok, bad], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.rollback?.restored, true);
    assert.equal(readMcpRegistry(path.join(s.home, "mcp.json")).servers["batch-ok"], undefined);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("health preflight aborts before any write", async () => {
  const s = makeFixture();
  try {
    mkdirSync(path.join(s.project, ".git"), { recursive: true });
    const catalog = await loadFixtureCatalog();
    const base = catalog.capabilities.find((candidate) => candidate.id === "fake-ok");
    assert.ok(base);
    if (base.install.method !== "dsh-install" || base.install.kind !== "mcp") throw new Error("fixture is not an MCP");
    const candidate: Candidate = {
      ...base,
      id: "health-bad",
      name: "Health Bad",
      install: { ...base.install, server: "health-bad", command: "dsh-forage-health-command-not-found" }
    };
    const report = await deployCandidates([candidate], {
      scope: "user", dryRun: false, yes: true, cwd: s.project, env: s.env,
      healthCheck: true, healthTimeoutMs: 2000
    });
    assert.equal(report.exitCode, 1);
    assert.equal(existsSync(path.join(s.home, "mcp.json")), false);
    assert.match(report.results[0]?.message ?? "", /health check/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
