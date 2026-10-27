import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeploymentCommand } from "../src/deploy/command.js";
import { deployCandidates, DeployPreflightError } from "../src/deploy/orchestrator.js";
import type { Candidate, DeploymentRunner, RunResult } from "../src/types.js";
import { PACKAGE_ROOT, fixtureCandidates } from "./helpers.js";

function okRun(): RunResult {
  return { code: 0, stdout: "installed", stderr: "", durationMs: 3 };
}

async function candidatesById(): Promise<Map<string, Candidate>> {
  const candidates = await fixtureCandidates();
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

test("MCP 安装命令按 dsh-install 语法构造", async () => {
  const byId = await candidatesById();
  const candidate = byId.get("fake-ok");
  assert.ok(candidate);
  const command = buildDeploymentCommand(candidate, "user");
  assert.ok(command);
  assert.deepEqual(command.args, [
    "--profile", "install",
    "mcp", "add", "fake-ok",
    "--scope", "user",
    "--transport", "stdio",
    "--timeout", "5000",
    "--", "npx", "-y", "fake-ok"
  ]);
  const update = buildDeploymentCommand(candidate, "user", "dsh-install", "update");
  assert.ok(update);
  assert.deepEqual(update.args, [
    "--profile", "install",
    "mcp", "update", "fake-ok",
    "--scope", "user",
    "--transport", "stdio",
    "--timeout", "5000",
    "--", "npx", "-y", "fake-ok"
  ]);
  const skill: Candidate = {
    id: "demo-skill",
    type: "skill",
    name: "Demo Skill",
    description: "test",
    domains: ["research"],
    tasks: [],
    tools: [],
    risk: { level: "low", writes: false, external_requests: false, sensitive_permissions: false },
    credentials: [],
    install: { method: "dsh-install", kind: "skill", source: "./demo-skill", name: "demo-skill" }
  };
  const skillUpdate = buildDeploymentCommand(skill, "project", "dsh-install", "update");
  assert.ok(skillUpdate);
  assert.deepEqual(skillUpdate.args, ["--profile", "install", "skills", "update", "demo-skill", "./demo-skill"]);
});

test("一项失败不阻塞其余项", async () => {
  const byId = await candidatesById();
  const calls: string[][] = [];
  const runner: DeploymentRunner = {
    async run(args) {
      calls.push(args);
      if (args.includes("fail-me")) {
        return { code: 1, stdout: "", stderr: "DUPLICATE_SERVER fake-fail", durationMs: 1 };
      }
      return okRun();
    }
  };
  const report = await deployCandidates(
    [byId.get("fake-ok")!, byId.get("fake-fail")!, byId.get("fake-builtin")!],
    { scope: "user", dryRun: false, yes: true, cwd: PACKAGE_ROOT, env: {}, runner }
  );
  assert.deepEqual(report.results.map((result) => result.status), ["installed", "failed", "available"]);
  assert.equal(calls.length, 2);
  assert.equal(report.summary.installed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.exitCode, 1);
  const failed = report.results.find((result) => result.id === "fake-fail");
  assert.ok(failed?.fix?.includes("已存在"));
});

test("缺少凭证时跳过并给出修复提示", async () => {
  const byId = await candidatesById();
  const calls: string[][] = [];
  const runner: DeploymentRunner = {
    async run(args) {
      calls.push(args);
      return okRun();
    }
  };
  const report = await deployCandidates([byId.get("fake-cred")!], {
    scope: "user", dryRun: false, yes: true, cwd: PACKAGE_ROOT, env: {}, runner
  });
  assert.equal(report.results[0]?.status, "skipped");
  assert.match(report.results[0]?.fix ?? "", /TEST_SECRET/);
  assert.equal(calls.length, 0);
});

test("高风险候选默认跳过，显式放行后才执行", async () => {
  const byId = await candidatesById();
  let calls = 0;
  const runner: DeploymentRunner = {
    async run() {
      calls += 1;
      return okRun();
    }
  };
  const skipped = await deployCandidates([byId.get("fake-high")!], {
    scope: "user", dryRun: false, yes: true, cwd: PACKAGE_ROOT, env: {}, runner
  });
  assert.equal(skipped.results[0]?.status, "skipped");
  assert.equal(calls, 0);

  const allowed = await deployCandidates([byId.get("fake-high")!], {
    scope: "user", dryRun: false, yes: true, cwd: PACKAGE_ROOT, env: {}, runner, includeHighRisk: true
  });
  assert.equal(allowed.results[0]?.status, "installed");
  assert.equal(calls, 1);
});

test("预览模式不执行命令", async () => {
  const byId = await candidatesById();
  let calls = 0;
  const runner: DeploymentRunner = {
    async run() {
      calls += 1;
      return okRun();
    }
  };
  const report = await deployCandidates([byId.get("fake-ok")!], {
    scope: "user", dryRun: true, yes: false, cwd: PACKAGE_ROOT, env: {}, runner
  });
  assert.equal(report.results[0]?.status, "planned");
  assert.equal(calls, 0);
});

test("没有 --yes 时拒绝执行部署", async () => {
  const byId = await candidatesById();
  await assert.rejects(
    deployCandidates([byId.get("fake-ok")!], {
      scope: "user", dryRun: false, yes: false, cwd: PACKAGE_ROOT, env: {},
      runner: { async run() { return okRun(); } }
    }),
    (error: unknown) => error instanceof DeployPreflightError && error.code === "CONFIRMATION_REQUIRED"
  );
});

test("project 作用域缺少 .git 时提前失败", async () => {
  const byId = await candidatesById();
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-no-git-"));
  try {
    await assert.rejects(
      deployCandidates([byId.get("fake-ok")!], {
        scope: "project", dryRun: false, yes: true, cwd: dir, env: {},
        runner: { async run() { return okRun(); } }
      }),
      (error: unknown) => error instanceof DeployPreflightError && error.code === "PROJECT_SCOPE_WITHOUT_GIT"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("部署输出中的密钥会被脱敏", async () => {
  const byId = await candidatesById();
  const runner: DeploymentRunner = {
    async run() {
      return { code: 1, stdout: "", stderr: "token=supersecret", durationMs: 1 };
    }
  };
  const report = await deployCandidates([byId.get("fake-cred")!], {
    scope: "user", dryRun: false, yes: true, cwd: PACKAGE_ROOT,
    env: { TEST_SECRET: "supersecret" }, runner
  });
  assert.equal(report.results[0]?.status, "failed");
  assert.match(report.results[0]?.stderr ?? "", /\*\*\*/);
  assert.ok(!(report.results[0]?.stderr ?? "").includes("supersecret"));
});

test("只含内置能力时无需 --yes 也不需要 dsh", async () => {
  const byId = await candidatesById();
  const report = await deployCandidates([byId.get("fake-builtin")!], {
    scope: "user", dryRun: false, yes: false, cwd: PACKAGE_ROOT, env: {}
  });
  assert.equal(report.results[0]?.status, "available");
  assert.equal(report.exitCode, 0);
});

test("缺少凭证时无需先找到 dsh", async () => {
  const byId = await candidatesById();
  const report = await deployCandidates([byId.get("fake-cred")!], {
    scope: "user", dryRun: false, yes: false, cwd: PACKAGE_ROOT, env: {}
  });
  assert.equal(report.results[0]?.status, "skipped");
  assert.equal(report.exitCode, 0);
});
