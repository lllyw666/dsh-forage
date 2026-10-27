import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CLI_ENTRY, FAKE_DSH, FIXTURE_CATALOG, cliEnv, runCli } from "./helpers.js";

test("plan --json 输出结构化候选且默认项不超过 2 个", () => {
  const result = runCli(["plan", "帮我检索 RAG 论文并整理引用，只读", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    mode: string;
    defaultSelection: string[];
    candidates: Array<{ id: string; defaultSelected: boolean }>;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "plan");
  assert.ok(payload.candidates.length >= 3);
  assert.ok(payload.defaultSelection.length <= 2);
  assert.ok(payload.candidates.every((candidate) => candidate.defaultSelected === payload.defaultSelection.includes(candidate.id)));
});

test("catalog --json 返回真实候选池", () => {
  const result = runCli(["catalog", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { count: number; candidates: Array<{ id: string }> };
  assert.equal(payload.count, 8);
  assert.ok(payload.candidates.some((candidate) => candidate.id === "semantic-scholar"));
});

test("deploy --json 逐项执行且失败隔离", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-cli-"));
  const log = path.join(dir, "calls.jsonl");
  try {
    const result = runCli([
      "deploy", "fake-ok,fake-fail,fake-builtin",
      "--catalog", FIXTURE_CATALOG,
      "--scope", "user",
      "--yes",
      "--json",
      "--dsh-bin", FAKE_DSH
    ], { env: { FAKE_DSH_LOG: log } });
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      report: { results: Array<{ id: string; status: string }>; summary: { installed: number; failed: number; available: number } };
    };
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.report.results.map((item) => item.status), ["installed", "failed", "available"]);
    assert.equal(payload.report.summary.installed, 1);
    assert.equal(payload.report.summary.failed, 1);
    assert.equal(payload.report.summary.available, 1);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy 在 project 作用域无 .git 时返回结构化错误", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-cli-nogit-"));
  try {
    const result = runCli([
      "deploy", "fake-ok",
      "--catalog", FIXTURE_CATALOG,
      "--scope", "project",
      "--yes",
      "--json",
      "--dsh-bin", FAKE_DSH
    ], { cwd: dir });
    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; fix?: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "PROJECT_SCOPE_WITHOUT_GIT");
    assert.match(payload.error.fix ?? "", /scope user/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy 未知 ID 返回结构化错误", () => {
  const result = runCli(["deploy", "not-a-real-id", "--catalog", FIXTURE_CATALOG, "--json"]);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "USAGE");
  assert.match(payload.error.message, /not-a-real-id/);
});

test("帮助信息无需 catalog 即可输出", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dsh-forage/);
  assert.match(result.stdout, /--dry-run/);
});

test("forge --json --yes 走完意图到部署的闭环", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-forge-"));
  const log = path.join(dir, "calls.jsonl");
  try {
    const result = runCli([
      "forge", "文献检索",
      "--catalog", FIXTURE_CATALOG,
      "--scope", "user",
      "--yes",
      "--json",
      "--top", "10",
      "--dsh-bin", FAKE_DSH
    ], { env: { FAKE_DSH_LOG: log } });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      mode: string;
      report: { summary: { installed: number; available: number; total: number } };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "deploy");
    assert.ok(payload.report.summary.total >= 2);
    assert.ok(payload.report.summary.installed + payload.report.summary.available >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy 仅内置能力时无需 --yes 也返回 JSON", () => {
  const result = runCli([
    "deploy", "fake-builtin",
    "--catalog", FIXTURE_CATALOG,
    "--scope", "user",
    "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { ok: boolean; report: { results: Array<{ status: string }> } };
  assert.equal(payload.ok, true);
  assert.equal(payload.report.results[0]?.status, "available");
});

test("forge --json --yes 在没有默认项时仍输出纯 JSON", () => {
  const result = runCli([
    "forge", "用 Excel 处理表格并生成图表",
    "--scope", "user",
    "--yes",
    "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { ok: boolean; mode: string; reason: string; defaultSelection: string[] };
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "plan");
  assert.equal(payload.reason, "no-default-selection");
  assert.deepEqual(payload.defaultSelection, []);
});

test("POSIX 下通过符号链接启动仍能执行 CLI", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-link-"));
  const link = path.join(dir, "dsh-forage");
  try {
    symlinkSync(CLI_ENTRY, link);
    const result = spawnSync(process.execPath, [link, "--version"], {
      encoding: "utf8",
      env: cliEnv(),
      timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dsh-forage 0\.1\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
