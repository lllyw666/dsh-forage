import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../src/cli/doctor.js";
import { PACKAGE_ROOT, runCli } from "./helpers.js";

interface Fixture {
  base: string;
  home: string;
  project: string;
  app: string;
  node: string;
  entry: string;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function writeShim(home: string, name: string, body: string[]): void {
  write(path.join(home, "bin", name + ".cmd"), ["@echo off", "setlocal", ...body, "exit /b %ERRORLEVEL%", ""].join("\r\n"));
}

function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-doctor-"));
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  const app = path.join(base, "app");
  const node = path.join(base, "runtime", "node.exe");
  const entry = path.join(base, "repo", "dist", "src", "index.js");
  mkdirSync(project, { recursive: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(path.dirname(node), { recursive: true });
  mkdirSync(path.dirname(entry), { recursive: true });
  write(node, "");
  write(entry, "");
  write(path.join(app, "DeepSeek Harness.exe"), "");
  write(path.join(app, "resources", "app.asar"), "");
  write(path.join(home, "mcp.json"), JSON.stringify({
    version: 1,
    servers: { demo: { transport: "stdio", command: node, args: [entry], enabled: true } }
  }, null, 2) + "\n");
  write(path.join(home, "skills", "dsh-forage.md"), readFileSync(path.join(PACKAGE_ROOT, "SKILL.md"), "utf8"));
  writeShim(home, "node", ['"' + node + '" %*']);
  writeShim(home, "npm", ['"' + node + '" "' + entry + '" %*']);
  writeShim(home, "npx", ['"' + node + '" "' + entry + '" %*']);
  writeShim(home, "pnpm", ['"' + node + '" "' + entry + '" %*']);
  writeShim(home, "dsh", [
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"' + path.join(app, "DeepSeek Harness.exe") + '" "' + path.join(app, "resources", "app.asar", "cli.js") + '" %*'
  ]);
  writeShim(home, "dsh-forage", ['"' + node + '" "' + entry + '" %*']);
  return { base, home, project, app, node, entry };
}

test("doctor 对修复后的环境返回 ok", () => {
  const s = makeFixture();
  try {
    const report = runDoctor({ cwd: s.project, packageRoot: PACKAGE_ROOT, dshHome: s.home });
    assert.equal(report.summary.error, 0, JSON.stringify(report.checks));
    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.id === "shim:node" && check.level === "ok"));
    assert.ok(report.checks.some((check) => check.id === "mcp:demo" && check.level === "ok"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("doctor 报告指向已删除路径的 shim", () => {
  const s = makeFixture();
  try {
    writeShim(s.home, "node", ['"' + path.join(s.base, "missing", "node.exe") + '" %*']);
    const report = runDoctor({ cwd: s.project, packageRoot: PACKAGE_ROOT, dshHome: s.home });
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.id === "shim:node" && check.level === "error"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("doctor 阻止把 DSH 安装目录当工作区", () => {
  const s = makeFixture();
  try {
    const inside = path.join(s.app, "project");
    mkdirSync(inside, { recursive: true });
    const report = runDoctor({ cwd: inside, packageRoot: PACKAGE_ROOT, dshHome: s.home });
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.id === "workspace:inside-app" && check.level === "error"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("doctor 识别 @dsh-forage/mcp-registry 已安装", () => {
  const s = makeFixture();
  try {
    write(path.join(s.home, "profiles", "desktop", "package.json"), JSON.stringify({
      name: "test-profile",
      private: true,
      dependencies: { "@dsh-forage/mcp-registry": "file:E:/plugin" }
    }, null, 2) + "\n");
    const report = runDoctor({ cwd: s.project, packageRoot: PACKAGE_ROOT, dshHome: s.home });
    assert.ok(report.checks.some((check) => check.id === "mcp:mount" && check.level === "ok"));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("doctor 报告过期的已安装 Skill，JSON CLI 契约可用", () => {
  const s = makeFixture();
  try {
    write(path.join(s.home, "skills", "dsh-forage.md"), "---\nname: dsh-forage\ndescription: stale\n---\n");
    const report = runDoctor({ cwd: s.project, packageRoot: PACKAGE_ROOT, dshHome: s.home });
    assert.ok(report.checks.some((check) => check.id === "skill" && check.level === "warn"));
    const cli = runCli(["doctor", "--json"], { cwd: s.project, env: { ...process.env, DSH_HOME: s.home } });
    assert.equal(cli.status, 0, cli.stderr);
    const payload = JSON.parse(cli.stdout) as { mode: string; ok: boolean; checks: unknown[] };
    assert.equal(payload.mode, "doctor");
    assert.equal(payload.ok, true);
    assert.ok(payload.checks.length > 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
