import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type {
  Candidate,
  DeployBackend,
  DeployReport,
  DeployResult,
  DeploymentRunner,
  Scope
} from "../types.js";
import { scopeContext } from "../scopes/paths.js";
import { findMcp } from "../scopes/mcp.js";
import { findSkill } from "../scopes/skills.js";
import { ScopeError, type ScopeContext } from "../scopes/types.js";
import { formatDuration, truncate } from "../util/text.js";
import { resolveDeployBackend } from "./backend.js";
import { buildDeploymentCommand } from "./command.js";
import { DshInstallClient, DshNotFoundError } from "./dsh-install.js";
import { installMcpLocal, installSkillLocal } from "./local.js";
import { githubCacheRoot, isGithubSkillSource, materializeGithubSkill } from "../discovery/github-install.js";
import { checkMcpHealth } from "./health.js";

export class DeployPreflightError extends Error {
  readonly code: string;
  readonly fix: string;
  override name = "DeployPreflightError";

  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export interface DeployOptions {
  scope: Scope;
  dryRun: boolean;
  yes: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  dshBin?: string;
  timeoutMs?: number;
  includeHighRisk?: boolean;
  runner?: DeploymentRunner;
  backend?: DeployBackend;
  replace?: boolean;
  healthCheck?: boolean;
  healthTimeoutMs?: number;
  activate?: boolean;
}

export function findGitRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    const git = path.join(current, ".git");
    try {
      if (existsSync(git) && statSync(git).isDirectory()) return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function needsDeployment(candidates: Candidate[], includeHighRisk: boolean, env: NodeJS.ProcessEnv): boolean {
  return candidates.some((candidate) => {
    if (candidate.install.method === "builtin") return false;
    if (candidate.risk.level === "high" && !includeHighRisk) return false;
    return candidate.credentials.every((key) => {
      const value = env[key];
      return value !== undefined && value.trim() !== "";
    });
  });
}

function secretsFor(candidates: Candidate[], env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    for (const key of candidate.credentials) keys.add(key);
    if (candidate.install.method === "dsh-install" && candidate.install.kind === "mcp") {
      for (const key of candidate.install.env ?? []) keys.add(key);
    }
  }
  return [...keys]
    .map((key) => env[key])
    .filter((value): value is string => typeof value === "string" && value.length >= 3);
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join("***");
  return result;
}

function deployable(candidate: Candidate, options: DeployOptions, env: NodeJS.ProcessEnv, ctx: ScopeContext): boolean {
  if (candidate.risk.level === "high" && options.includeHighRisk !== true) return false;
  if (candidate.credentials.some((key) => env[key] === undefined || env[key]?.trim() === "")) return false;
  if (candidate.install.method === "builtin") return false;
  if (options.replace !== true && findInstalled(candidate, ctx, options.scope) !== undefined) return false;
  return buildDeploymentCommand(candidate, options.scope, resolveDeployBackend(options.backend, options.runner !== undefined || options.dshBin !== undefined || (env.DSH_FORAGE_DSH_BIN !== undefined && env.DSH_FORAGE_DSH_BIN.trim() !== ""))) !== null;
}

interface BatchBackup {
  dir: string;
  mcpFile: string;
  mcpExisted: boolean;
  manifestFile: string;
  manifestExisted: boolean;
  skillsRoot?: string;
  skillsExisted: boolean;
}

function createBatchBackup(ctx: ScopeContext, scope: Scope): BatchBackup {
  const dir = path.join(ctx.dshHome, "forage", "backups", "batch-" + new Date().toISOString().replace(/[-:.]/g, ""));
  mkdirSync(dir, { recursive: true });
  const mcpFile = scope === "user" ? ctx.userMcpPath : scope === "session" ? ctx.sessionMcpPath : ctx.projectMcpPath as string;
  const mcpExisted = existsSync(mcpFile);
  if (mcpExisted) copyFileSync(mcpFile, path.join(dir, "mcp.json"));
  const manifestFile = ctx.skillsManifestPath;
  const manifestExisted = existsSync(manifestFile);
  if (manifestExisted) copyFileSync(manifestFile, path.join(dir, "skills-manifest.json"));
  const skillsRoot = scope === "user" ? ctx.userSkillsRoot : scope === "project" ? ctx.projectSkillsRoot : undefined;
  const skillsExisted = skillsRoot !== undefined && existsSync(skillsRoot);
  if (skillsRoot !== undefined && skillsExisted) cpSync(skillsRoot, path.join(dir, "skills"), { recursive: true });
  return { dir, mcpFile, mcpExisted, manifestFile, manifestExisted, skillsRoot, skillsExisted };
}

function restoreBatchBackup(backup: BatchBackup): void {
  if (backup.mcpExisted) copyFileSync(path.join(backup.dir, "mcp.json"), backup.mcpFile);
  else if (existsSync(backup.mcpFile)) rmSync(backup.mcpFile, { force: true });
  if (backup.manifestExisted) copyFileSync(path.join(backup.dir, "skills-manifest.json"), backup.manifestFile);
  else if (existsSync(backup.manifestFile)) rmSync(backup.manifestFile, { force: true });
  if (backup.skillsRoot !== undefined) {
    if (backup.skillsExisted) {
      rmSync(backup.skillsRoot, { recursive: true, force: true });
      cpSync(path.join(backup.dir, "skills"), backup.skillsRoot, { recursive: true });
    } else {
      rmSync(backup.skillsRoot, { recursive: true, force: true });
    }
  }
}

function installTarget(candidate: Candidate): string {
  if (candidate.install.method === "dsh-install" && candidate.install.kind === "mcp") {
    return candidate.install.server;
  }
  return candidate.id;
}

function findInstalled(candidate: Candidate, ctx: ScopeContext, scope: Scope): string | undefined {
  if (candidate.install.method !== "dsh-install") return undefined;
  if (candidate.install.kind === "mcp") return findMcp(ctx, scope, candidate.install.server)?.name;
  if (scope === "session") return undefined;
  const name = candidate.install.name ?? candidate.id;
  return findSkill(ctx, scope, name)?.name;
}

function failedFix(candidate: Candidate, stderr: string, stdout: string): string {
  const output = (stderr + "\n" + stdout).toLowerCase();
  if (output.includes("duplicate_server") || output.includes("already exists")) {
    return "同名 MCP 已存在。先运行 dsh --profile install mcp remove " + installTarget(candidate) + "，或换一个名称。";
  }
  if (output.includes("project scope") || output.includes("no .git")) {
    return "项目作用域需要 .git 目录。先 git init，或改用 --scope user。";
  }
  if (output.includes("runtime_missing") || output.includes("not found") || output.includes("enoent")) {
    return "确认 dsh、npx（或候选要求的运行时）在 PATH 中；并确认已安装 @dsh-tools/dsh-install 插件。";
  }
  return "先手动运行上方命令复现错误；必要时检查 npm registry、网络和候选的前置条件。";
}

export async function deployCandidates(candidates: Candidate[], options: DeployOptions): Promise<DeployReport> {
  const env = options.env ?? process.env;
  const secrets = secretsFor(candidates, env);
  const includeHighRisk = options.includeHighRisk === true;
  const hasExplicitDsh = options.runner !== undefined
    || options.dshBin !== undefined
    || (env.DSH_FORAGE_DSH_BIN !== undefined && env.DSH_FORAGE_DSH_BIN.trim() !== "");
  const backend = resolveDeployBackend(options.backend, hasExplicitDsh);
  const scoped = scopeContext(options.cwd, env);
  if (options.scope === "session" && needsDeployment(candidates, includeHighRisk, env)) {
    if (backend === "dsh-install") {
      throw new DeployPreflightError(
        "SESSION_BACKEND_UNSUPPORTED",
        "session scope 只支持本地后端。",
        "去掉 --dsh-bin / DSH_FORAGE_DSH_BIN，改用 --backend local。"
      );
    }
    const skill = candidates.find((candidate) => candidate.install.method === "dsh-install" && candidate.install.kind === "skill");
    if (skill !== undefined) {
      throw new DeployPreflightError(
        "SESSION_SKILL_UNSUPPORTED",
        "session scope 目前只支持 MCP；DSH 没有按会话扫描 Skill 的入口。",
        "Skill 请用 --scope project 或 --scope user。"
      );
    }
  }
  if (options.activate === false && backend === "dsh-install" && needsDeployment(candidates, includeHighRisk, env)) {
    throw new DeployPreflightError(
      "STAGED_BACKEND_UNSUPPORTED",
      "--staged / 禁用默认启用目前只支持本地后端。",
      "改用 --backend local，或去掉 --staged 并显式使用 dsh-install。"
    );
  }
  if (options.replace === true && backend === "dsh-install" && needsDeployment(candidates, includeHighRisk, env)) {
    throw new DeployPreflightError(
      "REPLACE_UNSUPPORTED",
      "--backend dsh-install 暂不支持 update/replace。",
      "改用 --backend local，或手动运行 dsh --profile install mcp remove / skills remove 后再 deploy。"
    );
  }

  if (!options.dryRun && !options.yes && needsDeployment(candidates, includeHighRisk, env)) {
    throw new DeployPreflightError(
      "CONFIRMATION_REQUIRED",
      "部署需要显式审批。",
      "在交互终端中确认，或传入 --yes；预览请加 --dry-run。"
    );
  }

  if (!options.dryRun && options.scope === "project" && needsDeployment(candidates, includeHighRisk, env)) {
    if (findGitRoot(options.cwd) === undefined) {
      throw new DeployPreflightError(
        "PROJECT_SCOPE_WITHOUT_GIT",
        "项目作用域要求当前目录位于一个含 .git 目录的仓库中。",
        "运行 git init，或改用 --scope user。"
      );
    }
  }

  let runner = options.runner;
  if (backend === "dsh-install" && !options.dryRun && runner === undefined && needsDeployment(candidates, includeHighRisk, env)) {
    try {
      const client = new DshInstallClient({
        dshBin: options.dshBin,
        cwd: options.cwd,
        env,
        timeoutMs: options.timeoutMs
      });
      client.resolve();
      runner = client;
    } catch (error) {
      if (error instanceof DshNotFoundError) {
        throw new DeployPreflightError("DSH_NOT_FOUND", error.message, error.fix);
      }
      throw error;
    }
  }

  const warnings: string[] = [];
  if (options.dryRun && options.scope === "project" && findGitRoot(options.cwd) === undefined) {
    warnings.push("当前目录没有 .git；真正部署前需要 git init，或改用 --scope user。");
  }
  if (backend === "local" && candidates.some((candidate) => candidate.install.method !== "builtin")) {
    warnings.push("本地后端：直接写 mcp.json / skills，写入前会备份，不经过 dsh-install；MCP 挂载仍需要兼容的 mcp-registry 插件，Skill 需要 DSH 重新扫描或重启。");
  }

  const deployCtx = scopeContext(options.cwd, env);
  const healthFailures = new Map<string, string>();
  if (!options.dryRun && options.healthCheck === true) {
    for (const candidate of candidates) {
      if (!deployable(candidate, options, env, deployCtx)) continue;
      if (candidate.install.method !== "dsh-install" || candidate.install.kind !== "mcp") continue;
      const health = await checkMcpHealth(candidate.install, env, options.healthTimeoutMs ?? 30_000);
      if (!health.ok) healthFailures.set(candidate.id, health.message);
    }
  }
  if (healthFailures.size > 0) {
    const results: DeployResult[] = candidates.map((candidate) => healthFailures.has(candidate.id)
      ? {
        id: candidate.id,
        name: candidate.name,
        status: "failed",
        message: "安装前 MCP health check 失败，批量 staging 已中止：" + (healthFailures.get(candidate.id) ?? ""),
        fix: "修正 MCP 命令/网络/环境变量后重试；或明确加 --no-health-check 跳过（不推荐）。"
      }
      : {
        id: candidate.id,
        name: candidate.name,
        status: "skipped",
        message: "同批次有 MCP health check 失败，未写入任何条目。"
      });
    const summary = {
      total: results.length,
      installed: 0,
      failed: results.filter((result) => result.status === "failed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      available: results.filter((result) => result.status === "available").length,
      planned: 0
    };
    return { scope: options.scope, backend, dryRun: options.dryRun, results, summary, exitCode: 1, warnings };
  }
  let batchBackup: BatchBackup | undefined;
  if (!options.dryRun && backend === "local" && candidates.some((candidate) => deployable(candidate, options, env, deployCtx))) {
    try {
      batchBackup = createBatchBackup(deployCtx, options.scope);
      warnings.push("批量备份：" + batchBackup.dir);
    } catch (error) {
      warnings.push("批量备份创建失败，未执行部署：" + String(error));
      const results: DeployResult[] = candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        status: "failed",
        message: "无法创建批量回滚备份，已中止。",
        fix: "检查 DSH_HOME 的备份目录权限。"
      }));
      const summary = { total: results.length, installed: 0, failed: results.length, skipped: 0, available: 0, planned: 0 };
      return { scope: options.scope, backend, dryRun: options.dryRun, results, summary, exitCode: 1, warnings };
    }
  }

  const results: DeployResult[] = [];
  for (const candidate of candidates) {
    if (candidate.risk.level === "high" && !includeHighRisk) {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "skipped",
        message: "高风险候选未获显式放行，未安装。",
        fix: "确认了解风险后加 --include-high-risk。"
      });
      continue;
    }
    const missingCredentials = candidate.credentials.filter((key) => {
      const value = env[key];
      return value === undefined || value.trim() === "";
    });
    if (missingCredentials.length > 0) {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "skipped",
        message: "缺少环境变量：" + missingCredentials.join(", "),
        fix: "设置 " + missingCredentials.join(", ") + " 后重新运行；不会把明文密钥写入安装参数。"
      });
      continue;
    }
    if (candidate.install.method === "builtin") {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "available",
        message: "已由 DSH 内置提供：" + candidate.install.provides.join(", ") + "。无需安装。"
      });
      continue;
    }
    if (options.replace !== true) {
      const installed = findInstalled(candidate, scoped, options.scope);
      if (installed !== undefined) {
        results.push({
          id: candidate.id,
          name: candidate.name,
          status: "skipped",
          message: "已在 " + options.scope + " 作用域安装：" + installed + "；未重复安装。",
          fix: "需要更新时运行 dsh-forage update --id " + candidate.id + " --scope " + options.scope + "；或先 remove。",
          backend
        });
        continue;
      }
    }
    const command = buildDeploymentCommand(candidate, options.scope, backend);
    if (command === null) {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "skipped",
        message: "没有可执行的安装命令。"
      });
      continue;
    }
    if (options.dryRun) {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "planned",
        message: "预览模式，未执行。",
        command: command.display,
        backend
      });
      continue;
    }

    if (backend === "local") {
      const started = Date.now();
      try {
        const ctx = scopeContext(options.cwd, env);
        if (candidate.install.kind === "mcp") {
          const write = installMcpLocal(ctx, options.scope, candidate.install, options.replace === true, options.activate !== false);
          results.push({
            id: candidate.id,
            name: candidate.name,
            status: "installed",
            message: "已写入本地 MCP 注册表：" + write.path + (write.backup === undefined ? "" : "（备份：" + write.backup + "）") + (write.entry.enabled === false ? "；当前 enabled=false，审查后运行 dsh-forage enable --id " + candidate.install.server + " --scope " + options.scope : "") + "；需要兼容的 mcp-registry 插件并重启 DSH 才会挂载。",
            command: command.display,
            backend: "local",
            durationMs: Date.now() - started
          });
        } else {
          let install = candidate.install;
          let downloaded: { path: string; cached: boolean } | undefined;
          if (isGithubSkillSource(install.source)) {
            try {
              const materialized = await materializeGithubSkill(install.source, {
                cacheRoot: githubCacheRoot(ctx.dshHome),
                token: env.GITHUB_TOKEN ?? env.GH_TOKEN
              });
              install = { ...install, source: materialized.path };
              downloaded = { path: materialized.path, cached: materialized.cached };
            } catch (error) {
              throw new ScopeError(
                "GITHUB_SKILL_DOWNLOAD_FAILED",
                "GitHub Skill 下载失败：" + (error instanceof Error ? error.message : String(error)),
                "检查 GitHub 网络/仓库是否公开，或设置 GITHUB_TOKEN；也可以手动 clone 后用本地 catalog source 安装。"
              );
            }
          }
          const write = installSkillLocal(ctx, options.scope, install, options.cwd, { replace: options.replace === true });
          results.push({
            id: candidate.id,
            name: candidate.name,
            status: "installed",
            message: "已安装本地 Skill：" + write.path + (downloaded === undefined ? "" : (downloaded.cached ? "（GitHub 源缓存）" : "（已下载 GitHub 源）")) + "；如 Skill 列表未刷新，重启 DSH。",
            command: command.display,
            backend: "local",
            durationMs: Date.now() - started
          });
        }
      } catch (error) {
        const scopeError = error instanceof ScopeError ? error : undefined;
        results.push({
          id: candidate.id,
          name: candidate.name,
          status: "failed",
          message: "本地安装失败：" + (error instanceof Error ? error.message : String(error)),
          fix: scopeError?.fix ?? "检查 DSH_HOME 或项目 .dsh 目录的权限、磁盘空间和 catalog 配置。",
          command: command.display,
          backend: "local",
          durationMs: Date.now() - started
        });
      }
      continue;
    }

    if (runner === undefined) {
      results.push({
        id: candidate.id,
        name: candidate.name,
        status: "failed",
        message: "没有可用的 dsh 运行器。",
        fix: "确认 dsh 在 PATH 中，或使用 --dsh-bin。",
        command: command.display,
        backend: "dsh-install"
      });
      continue;
    }
    const timeoutMs = candidate.install.method === "dsh-install" && candidate.install.kind === "mcp"
      ? candidate.install.timeoutMs ?? options.timeoutMs ?? 180_000
      : options.timeoutMs ?? 180_000;
    const run = await runner.run(command.args, timeoutMs);
    const success = run.code === 0 && run.error === undefined;
    const stderr = redact(truncate(run.stderr, 4000), secrets);
    const stdout = redact(truncate(run.stdout, 4000), secrets);
    results.push({
      id: candidate.id,
      name: candidate.name,
      status: success ? "installed" : "failed",
      message: success
        ? "安装完成（" + formatDuration(run.durationMs) + "）；dsh-install 会触发热挂载。"
        : "安装失败：" + (run.error ?? (run.timedOut ? "命令超时" : "退出码 " + String(run.code))),
      fix: success ? undefined : failedFix(candidate, stderr, stdout),
      command: command.display,
      backend: "dsh-install",
      stdout,
      stderr,
      durationMs: run.durationMs
    });
  }

  let rollback: DeployReport["rollback"];
  if (batchBackup !== undefined && results.some((result) => result.status === "failed")) {
    try {
      restoreBatchBackup(batchBackup);
      rollback = { attempted: true, restored: true, backup: batchBackup.dir, message: "批次失败，已恢复 mcp.json、skills-manifest.json 和 skills 根目录。" };
      warnings.push(rollback.message);
    } catch (error) {
      rollback = { attempted: true, restored: false, backup: batchBackup.dir, message: "批次回滚失败：" + String(error) };
      warnings.push(rollback.message);
    }
  }

  const summary = {
    total: results.length,
    installed: results.filter((result) => result.status === "installed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    available: results.filter((result) => result.status === "available").length,
    planned: results.filter((result) => result.status === "planned").length
  };
  return {
    scope: options.scope,
    backend,
    dryRun: options.dryRun,
    results,
    summary,
    exitCode: summary.failed > 0 ? 1 : 0,
    warnings,
    ...(rollback === undefined ? {} : { rollback })
  };
}
