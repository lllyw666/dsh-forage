import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Candidate, DeployReport, Intent, RankedCandidate, Scope } from "../types.js";
import { findPackageRoot, loadCatalog, packageVersion } from "../catalog/loader.js";
import { CatalogError } from "../catalog/schema.js";
import { IntentError, parseIntent, parseIntentJson } from "../intent/parser.js";
import { rankCandidates } from "../ranker/index.js";
import { HashedEmbeddingProvider, rankCandidatesWithEmbeddings } from "../ranker/embeddings.js";
import { HttpEmbeddingProvider, httpEmbeddingFromEnv } from "../ranker/http-embedding.js";
import { discoverCapabilities } from "../discovery/index.js";
import { readDiscoverySnapshot, writeDiscoverySnapshot } from "../discovery/snapshot.js";
import { selectCandidates } from "../picker/cli.js";
import { buildDeploymentCommand } from "../deploy/command.js";
import { deployCandidates, DeployPreflightError, findGitRoot } from "../deploy/orchestrator.js";
import { resolveDeployBackend } from "../deploy/backend.js";
import type { EffectiveBackend } from "../types.js";
import { DshInstallClient, DshNotFoundError } from "../deploy/dsh-install.js";
import { CliUsageError, helpText, parseArgs, type CliOptions } from "./args.js";
import { runDoctor } from "./doctor.js";
import { renderCatalog, renderDeploymentPreview, renderDoctor, renderPlan, renderReport, renderScopeStatus, renderSoftware, renderTransferPlan, renderTransferResult } from "./render.js";
import { findSoftware, SOFTWARE_DISCLAIMER } from "../software/catalog.js";
import { requireProjectRoot, scopeContext } from "../scopes/paths.js";
import { buildStatus } from "../scopes/status.js";
import { commandDisplay, findMcp, mcpRemoveArgs } from "../scopes/mcp.js";
import { findSkill } from "../scopes/skills.js";
import { findLocalMatches, type LocalMatch } from "../scopes/local-match.js";
import { enableMcpLocal, removeMcpLocal, removeSkillLocal } from "../deploy/local.js";
import { previewTransfer, transferItem, type TransferDirection } from "../scopes/transfer.js";
import { ScopeError, type ScopeContext } from "../scopes/types.js";

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
}

export function defaultCliContext(): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdout.isTTY === true
  };
}

interface Prompt {
  ask(question: string): Promise<string>;
  close(): void;
}

function createPrompt(context: CliContext): Prompt {
  const readline = createInterface({
    input: context.stdin,
    output: context.stdout,
    terminal: context.isTTY
  });
  return {
    ask: (question) => readline.question(question),
    close: () => readline.close()
  };
}

async function confirmWithOther(
  prompt: Prompt,
  question: string
): Promise<{ approved: boolean; other?: string }> {
  const answer = await prompt.ask(question + " [y/N/o 其他想法] ");
  if (/^(o|other|其他)$/i.test(answer.trim())) {
    const note = await prompt.ask("输入其他想法：");
    return { approved: false, other: note.trim() };
  }
  return { approved: /^y(es)?$/i.test(answer.trim()) };
}

function writeLine(context: CliContext, text = ""): void {
  context.stdout.write(text + "\n");
}

function writeJson(context: CliContext, value: unknown): void {
  context.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function surfaceColor(options: CliOptions, context: CliContext): boolean {
  if (options.json) return false;
  if (options.color !== undefined) return options.color;
  if (context.env.NO_COLOR !== undefined) return false;
  return context.isTTY;
}

function normalizeDomain(value: string): string | undefined {
  const aliases: Record<string, string> = {
    research: "research",
    "科研": "research",
    scholar: "research",
    office: "office",
    "办公": "office",
    document: "office",
    development: "development",
    dev: "development",
    "开发": "development",
    other: "other",
    "其他": "other"
  };
  return aliases[value.trim().toLowerCase()];
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function resolveActivate(candidates: Candidate[], options: CliOptions): boolean {
  if (options.staged) return false;
  if (options.activate === true) return true;
  return candidates.every((candidate) => candidate.discovery === undefined);
}

function requiresApproval(candidates: Candidate[], includeHighRisk: boolean, env: NodeJS.ProcessEnv): boolean {
  return candidates.some((candidate) => {
    if (candidate.install.method === "builtin") return false;
    if (candidate.risk.level === "high" && !includeHighRisk) return false;
    return candidate.credentials.every((key) => {
      const value = env[key];
      return value !== undefined && value.trim() !== "";
    });
  });
}

function mergeIntents(primary: Intent, fallback: Intent): Intent {
  const domains = primary.domains.length === 1 && primary.domains[0] === "other"
    ? fallback.domains
    : primary.domains;
  return {
    tasks: [...new Set([...primary.tasks, ...fallback.tasks])].slice(0, 8),
    domains,
    signals: [...new Set([...primary.signals, ...fallback.signals])].slice(0, 20),
    constraints: [...new Set([...primary.constraints, ...fallback.constraints])],
    confidence: Math.max(primary.confidence, fallback.confidence),
    locale: primary.locale
  };
}

async function resolveIntent(options: CliOptions, context: CliContext): Promise<Intent> {
  let override: Intent | undefined;
  if (options.intentFile !== undefined) {
    const file = path.resolve(context.cwd, options.intentFile);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new CliUsageError("无法读取 --intent-file：" + file);
    }
    if (!info.isFile()) throw new CliUsageError("--intent-file 必须是普通文件");
    if (info.size > 200 * 1024) throw new CliUsageError("--intent-file 超过 200 KiB 上限");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw new CliUsageError("--intent-file 不是合法 JSON：" + String(error));
    }
    override = parseIntentJson(parsed);
  } else if (options.intentJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.intentJson);
    } catch (error) {
      throw new CliUsageError("--intent 不是合法 JSON：" + String(error));
    }
    override = parseIntentJson(parsed);
  }

  const fromQuery = options.query.trim() === "" ? undefined : parseIntent(options.query);
  if (override !== undefined) {
    return fromQuery === undefined ? override : mergeIntents(override, fromQuery);
  }
  if (fromQuery === undefined) {
    throw new CliUsageError(
      "请提供任务描述，例如 dsh-forage \"帮我检索这几篇论文并整理引用\"。",
      "也可以传入 --intent 或 --intent-file。"
    );
  }
  return fromQuery;
}

function candidateSummary(
  entry: RankedCandidate,
  scope: CliOptions["scope"],
  rank: number,
  backend: EffectiveBackend,
  installedInScope?: Scope
): Record<string, unknown> {
  const candidate = entry.candidate;
  const command = candidate.install.method === "builtin"
    ? null
    : buildDeploymentCommand(candidate, scope, backend)?.display ?? null;
  return {
    rank,
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    description: candidate.description,
    domains: candidate.domains,
    tasks: candidate.tasks,
    tools: candidate.tools,
    toolCount: candidate.toolCount ?? candidate.tools.length,
    risk: candidate.risk,
    credentials: candidate.credentials,
    missingCredentials: entry.missingCredentials,
    requires: candidate.requires ?? [],
    builtin: candidate.install.method === "builtin",
    command,
    score: entry.score,
    confidence: entry.confidence,
    reasons: entry.reasons,
    defaultSelected: entry.defaultSelected,
    defaultBlockedBy: entry.defaultBlockedBy,
    installedInScope: installedInScope ?? null,
    homepage: candidate.homepage,
    sourceRepo: candidate.sourceRepo,
    license: candidate.license,
    packageVersion: candidate.packageVersion,
    verifiedAt: candidate.verifiedAt,
    sourcePriority: candidate.discovery?.sourcePriority ?? null,
    stars: candidate.discovery?.stars ?? null,
    discovery: candidate.discovery ?? null
  };
}

function planPayload(
  version: string,
  intent: Intent,
  ranked: RankedCandidate[],
  scope: CliOptions["scope"],
  catalogFiles: string[],
  warnings: string[],
  backend: EffectiveBackend,
  embedding: CliOptions["embedding"],
  installed: ReadonlyMap<string, Scope> = new Map(),
  discovery?: { queries: string[]; candidates: number; warnings: string[]; cache: string | null },
  localMatches: LocalMatch[] = [],
  userNotes: string[] = []
): Record<string, unknown> {
  return {
    ok: true,
    mode: "plan",
    version,
    scope,
    backend,
    embedding,
    intent,
    defaultSelection: ranked.filter((entry) => entry.defaultSelected).map((entry) => entry.candidate.id),
    selection: {
      type: "multi_select",
      question: "选择要安装的能力（可多选；也可以选择 Other 并输入自己的想法）",
      allowOther: true,
      options: ranked.slice(0, 10).map((entry) => ({
        id: entry.candidate.id,
        label: entry.candidate.name + "  (" + entry.candidate.id + ")",
        description: entry.candidate.description,
        risk: entry.candidate.risk.level,
        defaultSelected: entry.defaultSelected
      }))
    },
    candidates: ranked.map((entry, index) => candidateSummary(entry, scope, index + 1, backend, installed.get(entry.candidate.id))),
    catalogFiles,
    github: null,
    discovery: discovery ?? null,
    localMatches,
    userNotes,
    warnings
  };
}

function deployPayload(version: string, intent: Intent | undefined, report: DeployReport): Record<string, unknown> {
  return {
    ok: report.exitCode === 0,
    mode: report.dryRun ? "preview" : "deploy",
    version,
    scope: report.scope,
    intent,
    report
  };
}

function printDeployInstruction(context: CliContext, candidates: Candidate[], scope: CliOptions["scope"]): void {
  const ids = candidates.map((candidate) => candidate.id).join(",");
  writeLine(context);
  writeLine(context, "未执行部署。确认后运行：");
  writeLine(context, "  dsh-forage deploy --id " + ids + " --scope " + scope + " --yes");
  writeLine(context, "或先预览：dsh-forage deploy --id " + ids + " --scope " + scope + " --dry-run");
}

async function reportError(
  error: unknown,
  json: boolean,
  context: CliContext,
  debug: boolean
): Promise<number> {
  let code = "INTERNAL";
  let message = error instanceof Error ? error.message : String(error);
  let fix: string | undefined;
  if (error instanceof CliUsageError) code = error.code;
  else if (error instanceof CatalogError) code = "CATALOG_INVALID";
  else if (error instanceof IntentError) code = "INTENT_INVALID";
  else if (error instanceof DeployPreflightError) {
    code = error.code;
    fix = error.fix;
  } else if (error instanceof ScopeError) {
    code = error.code;
    fix = error.fix;
  } else if (error instanceof DshNotFoundError) {
    code = "DSH_NOT_FOUND";
    fix = error.fix;
  }
  if (json) {
    writeJson(context, { ok: false, error: { code, message, fix } });
  } else {
    context.stderr.write("dsh-forage: " + message + "\n");
    if (fix !== undefined) context.stderr.write("修复：" + fix + "\n");
    if (debug && error instanceof Error && error.stack !== undefined) {
      context.stderr.write(error.stack + "\n");
    }
  }
  return 2;
}

function requireMaintenanceScope(options: CliOptions, command: string): Scope {
  if (!options.scopeExplicit) {
    throw new CliUsageError(command + " 需要显式 --scope。", "例如 --scope user 或 --scope project；不会猜测要删除/更新哪一份。");
  }
  return options.scope;
}

function requireMaintenanceId(options: CliOptions, command: string): string {
  if (options.ids.length === 0) {
    const positional = options.query.trim();
    if (positional !== "" && !/\s/.test(positional)) return positional;
    throw new CliUsageError(command + " 需要指定一个条目。", "用 --id <id> 或位置参数指定一个 MCP/Skill；先运行 dsh-forage status。");
  }
  if (options.ids.length !== 1) {
    throw new CliUsageError(command + " 一次只能处理一个条目。", "用 --id <id> 指定一个 MCP 或 Skill；先运行 dsh-forage status。");
  }
  if (options.query !== "") {
    throw new CliUsageError(command + " 不需要位置参数。", "用 --id <id> 指定条目。");
  }
  return options.ids[0] as string;
}

function resolveInstalledItem(
  ctx: ScopeContext,
  scope: Scope,
  id: string,
  kind?: "mcp" | "skill"
): { kind: "mcp" | "skill"; name: string; path: string } {
  const mcp = findMcp(ctx, scope, id);
  const skill = scope === "session" ? undefined : findSkill(ctx, scope, id);
  if (kind === "skill" && scope === "session") {
    throw new ScopeError("SESSION_SKILL_UNSUPPORTED", "session scope 目前只支持 MCP。", "Skill 请用 --scope project 或 --scope user。");
  }
  if (kind === undefined && mcp !== undefined && skill !== undefined) {
    throw new ScopeError("AMBIGUOUS_ITEM", "同名 MCP 和 Skill 同时存在：" + id, "使用 --kind mcp 或 --kind skill 明确选择。");
  }
  const resolved = kind ?? (mcp !== undefined ? "mcp" : skill !== undefined ? "skill" : undefined);
  if (resolved === "mcp") {
    if (mcp === undefined) throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 MCP：" + id, "运行 dsh-forage status 查看已安装项。");
    return { kind: "mcp", name: mcp.name, path: mcp.path };
  }
  if (resolved === "skill") {
    if (skill === undefined) throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 Skill：" + id, "运行 dsh-forage status 查看已安装项。");
    return { kind: "skill", name: skill.name, path: skill.sourcePath };
  }
  throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到条目：" + id, "运行 dsh-forage status 查看已安装项。");
}

function candidateTargetName(candidate: Candidate): string {
  if (candidate.install.method === "dsh-install" && candidate.install.kind === "mcp") return candidate.install.server;
  if (candidate.install.method === "dsh-install" && candidate.install.kind === "skill") return candidate.install.name ?? candidate.id;
  return candidate.id;
}

export async function runCli(argv: string[], context: CliContext = defaultCliContext()): Promise<number> {
  let options: CliOptions | undefined;
  const jsonRequested = argv.includes("--json");
  try {
    options = parseArgs(argv);
    const packageRoot = findPackageRoot();
    const version = packageVersion(packageRoot);
    if (options.version) {
      writeLine(context, "dsh-forage " + version);
      return 0;
    }
    if (options.help) {
      writeLine(context, helpText(version));
      return 0;
    }
    const color = surfaceColor(options, context);
    const hasExplicitDsh = options.dshBin !== undefined
      || (context.env.DSH_FORAGE_DSH_BIN !== undefined && context.env.DSH_FORAGE_DSH_BIN.trim() !== "");
    const effectiveBackend = resolveDeployBackend(options.backend, hasExplicitDsh);
    if (options.command === "doctor") {
      const report = runDoctor({ cwd: context.cwd, env: context.env, packageRoot });
      if (options.json) writeJson(context, { mode: "doctor", version, ...report });
      else writeLine(context, renderDoctor(report, color));
      return report.ok ? 0 : 1;
    }
    if (options.command === "software") {
      const query = (options.query !== "" ? options.query : options.ids[0] ?? "").trim();
      const results = findSoftware(query);
      if (options.json) {
        writeJson(context, { ok: results.length > 0, mode: "software", query, results, disclaimer: SOFTWARE_DISCLAIMER });
      } else {
        writeLine(context, renderSoftware(results, query, color));
      }
      return results.length > 0 ? 0 : 1;
    }
    if (options.command === "enable") {
      const scope = requireMaintenanceScope(options, "enable");
      const id = requireMaintenanceId(options, "enable");
      const ctx = scopeContext(context.cwd, context.env);
      if (scope === "project") requireProjectRoot(ctx);
      const write = enableMcpLocal(ctx, scope, id);
      if (options.json) {
        writeJson(context, { ok: true, mode: "enable", scope, name: id, path: write.path, backup: write.backup ?? null, enabled: write.entry.enabled });
      } else {
        writeLine(context, "已启用 MCP " + id + "（" + scope + "）");
        writeLine(context, "  路径 " + write.path);
        if (write.backup !== undefined) writeLine(context, "  备份 " + write.backup);
      }
      return 0;
    }
    if (options.command === "remove") {
      const scope = requireMaintenanceScope(options, "remove");
      const id = requireMaintenanceId(options, "remove");
      const ctx = scopeContext(context.cwd, context.env);
      if (scope === "project") requireProjectRoot(ctx);
      const item = resolveInstalledItem(ctx, scope, id, options.kind);
      if (scope === "session" && effectiveBackend === "dsh-install") {
        throw new CliUsageError("session scope 只支持本地后端。", "去掉 --dsh-bin / DSH_FORAGE_DSH_BIN，或改用 --backend local。");
      }
      const removeArgs = item.kind === "mcp"
        ? mcpRemoveArgs(item.name, scope)
        : ["--profile", "install", "skills", "remove", item.name, "--scope", scope];
      const removeCommand = commandDisplay(removeArgs);
      if (options.dryRun) {
        if (options.json) writeJson(context, { ok: true, mode: "remove", scope, backend: effectiveBackend, dryRun: true, item, command: removeCommand });
        else writeLine(context, "将移除 " + item.kind.toUpperCase() + " " + item.name + "（" + item.path + "）\n  " + removeCommand);
        return 0;
      }
      let approved = options.yes;
      if (!approved && context.isTTY && !options.noInput) {
        const prompt = createPrompt(context);
        let other: string | undefined;
        try {
          const confirmation = await confirmWithOther(prompt, "确认移除 " + item.kind.toUpperCase() + " " + item.name + "？");
          approved = confirmation.approved;
          other = confirmation.other;
        } finally {
          prompt.close();
        }
        if (other !== undefined) {
          writeLine(context, "已记录其他想法：" + other);
          writeLine(context, "已暂停移除；请根据补充要求重新 plan。");
          return 0;
        }
        if (!approved) {
          writeLine(context, "已取消移除。");
          return 0;
        }
      }
      if (!approved) {
        throw new ScopeError("CONFIRMATION_REQUIRED", "移除需要显式审批。", "在交互终端中确认，或传入 --yes。");
      }
      if (effectiveBackend === "dsh-install") {
        let client: DshInstallClient;
        try {
          client = new DshInstallClient({ dshBin: options.dshBin, cwd: context.cwd, env: context.env, timeoutMs: options.timeoutMs });
          client.resolve();
        } catch (error) {
          if (error instanceof DshNotFoundError) throw new ScopeError("DSH_NOT_FOUND", error.message, error.fix);
          throw error;
        }
        const run = await client.run(removeArgs, options.timeoutMs ?? 180_000);
        const skipped = /skipping profile bundle/i.test(run.stdout + run.stderr);
        const success = run.code === 0 && run.error === undefined && !skipped;
        if (options.json) {
          writeJson(context, {
            ok: success, mode: "remove", scope, backend: "dsh-install",
            result: { ...item, command: removeCommand, status: success ? "removed" : "failed", stdout: run.stdout, stderr: run.stderr, durationMs: run.durationMs }
          });
        } else {
          writeLine(context, (success ? "已移除 " : "移除失败 ") + item.kind.toUpperCase() + " " + item.name + "（dsh-install）");
          writeLine(context, "  " + removeCommand);
          if (!success && skipped) writeLine(context, "  dsh-install 未加载（skipping profile bundle），改用 --backend local。");
          if (!success && run.stderr.trim() !== "") writeLine(context, "  stderr：" + run.stderr.trim());
        }
        return success ? 0 : 1;
      }
      const result = item.kind === "mcp"
        ? removeMcpLocal(ctx, scope, item.name)
        : removeSkillLocal(ctx, scope, item.name);
      if (options.json) {
        writeJson(context, { ok: true, mode: "remove", scope, backend: "local", result: { ...item, path: result.path, backup: result.backup } });
      } else {
        writeLine(context, "已移除 " + item.kind.toUpperCase() + " " + item.name);
        writeLine(context, "  路径 " + result.path);
        if (result.backup !== undefined) writeLine(context, "  备份 " + result.backup);
      }
      return 0;
    }
    const extraPaths = [...options.catalogs];
    const catalog = await loadCatalog({
      packageRoot,
      cwd: context.cwd,
      extraPaths
    });

    if (options.command === "catalog") {
      const rawDomain = (options.domain ?? options.query).trim();
      let domain: string | undefined;
      if (rawDomain !== "") {
        domain = normalizeDomain(rawDomain);
        if (domain === undefined) {
          throw new CliUsageError(
            "未知领域 " + JSON.stringify(rawDomain),
            "可用领域：research（科研）、office（办公）、development（开发）、other（其他）。"
          );
        }
      }
      const candidates = domain === undefined
        ? catalog.capabilities
        : catalog.capabilities.filter((candidate) => candidate.domains.includes(domain));
      if (options.json) {
        writeJson(context, {
          ok: true,
          mode: "catalog",
          version,
          domain: domain ?? null,
          count: candidates.length,
          candidates
        });
      } else {
        writeLine(context, renderCatalog(candidates, color));
      }
      return 0;
    }

    if (options.command === "update") {
      const scope = requireMaintenanceScope(options, "update");
      const id = requireMaintenanceId(options, "update");
      const candidate = catalog.capabilities.find((entry) => entry.id === id);
      if (candidate === undefined) {
        throw new CliUsageError(
          "未知能力 ID：" + id,
          "可用 ID：" + catalog.capabilities.map((entry) => entry.id).join(", ")
        );
      }
      if (candidate.install.method === "builtin") {
        throw new CliUsageError("内置能力不需要 update。", "直接使用 DSH 提供的 Office Skills 即可。");
      }
      const kind = candidate.install.kind;
      if (scope === "session" && kind === "skill") {
        throw new CliUsageError("session scope 目前只支持 MCP。", "Skill 请用 --scope project 或 --scope user。");
      }
      if (scope === "session" && effectiveBackend === "dsh-install") {
        throw new CliUsageError("session scope 只支持本地后端。", "去掉 --dsh-bin / DSH_FORAGE_DSH_BIN，或改用 --backend local。");
      }
      if (options.kind !== undefined && options.kind !== kind) {
        throw new CliUsageError("--kind 与 catalog 中的 " + id + " 类型不一致。", "该候选是 " + kind + "。");
      }
      const ctx = scopeContext(context.cwd, context.env);
      if (scope === "project") requireProjectRoot(ctx);
      const targetName = candidateTargetName(candidate);
      const item = resolveInstalledItem(ctx, scope, targetName, kind);
      const updateCommand = effectiveBackend === "dsh-install"
        ? buildDeploymentCommand(candidate, scope, "dsh-install", "update")
        : null;
      if (effectiveBackend === "dsh-install" && updateCommand === null) {
        throw new CliUsageError("无法生成 dsh update 命令。", "检查该候选的 install 配置。");
      }
      const deployOptions = {
        scope,
        yes: true,
        cwd: context.cwd,
        env: context.env,
        backend: options.backend,
        replace: true,
        timeoutMs: options.timeoutMs,
        includeHighRisk: options.includeHighRisk,
        healthCheck: options.healthCheck && context.env.DSH_FORAGE_HEALTH_CHECK !== "off",
        activate: options.activate
      } as const;
      if (options.dryRun) {
        if (effectiveBackend === "dsh-install" && updateCommand !== null) {
          if (options.json) writeJson(context, { ok: true, mode: "update", scope, backend: "dsh-install", dryRun: true, item, command: updateCommand.display });
          else writeLine(context, "将更新 " + kind.toUpperCase() + " " + targetName + "\n  " + updateCommand.display);
          return 0;
        }
        const report = await deployCandidates([candidate], { ...deployOptions, dryRun: true });
        if (options.json) writeJson(context, { ok: report.exitCode === 0, mode: "update", scope, item, report });
        else writeLine(context, renderReport(report, color));
        return report.exitCode;
      }
      let approved = options.yes;
      if (!approved && context.isTTY && !options.noInput) {
        const prompt = createPrompt(context);
        let other: string | undefined;
        try {
          const confirmation = await confirmWithOther(prompt, "确认更新 " + kind.toUpperCase() + " " + targetName + "？");
          approved = confirmation.approved;
          other = confirmation.other;
        } finally {
          prompt.close();
        }
        if (other !== undefined) {
          writeLine(context, "已记录其他想法：" + other);
          writeLine(context, "已暂停更新；请根据补充要求重新 plan。");
          return 0;
        }
        if (!approved) {
          writeLine(context, "已取消更新。");
          return 0;
        }
      }
      if (!approved) {
        throw new ScopeError("CONFIRMATION_REQUIRED", "更新需要显式审批。", "在交互终端中确认，或传入 --yes；预览请加 --dry-run。");
      }
      if (effectiveBackend === "dsh-install" && updateCommand !== null) {
        let client: DshInstallClient;
        try {
          client = new DshInstallClient({ dshBin: options.dshBin, cwd: context.cwd, env: context.env, timeoutMs: options.timeoutMs });
          client.resolve();
        } catch (error) {
          if (error instanceof DshNotFoundError) throw new ScopeError("DSH_NOT_FOUND", error.message, error.fix);
          throw error;
        }
        const timeoutMs = candidate.install.method === "dsh-install" && candidate.install.kind === "mcp"
          ? candidate.install.timeoutMs ?? options.timeoutMs ?? 180_000
          : options.timeoutMs ?? 180_000;
        const run = await client.run(updateCommand.args, timeoutMs);
        const skipped = /skipping profile bundle/i.test(run.stdout + run.stderr);
        const success = run.code === 0 && run.error === undefined && !skipped;
        if (options.json) {
          writeJson(context, {
            ok: success, mode: "update", scope, backend: "dsh-install", item, command: updateCommand.display,
            status: success ? "updated" : "failed", stdout: run.stdout, stderr: run.stderr, durationMs: run.durationMs
          });
        } else {
          writeLine(context, (success ? "已更新 " : "更新失败 ") + kind.toUpperCase() + " " + targetName + "（dsh-install）");
          writeLine(context, "  " + updateCommand.display);
          if (!success && skipped) writeLine(context, "  dsh-install 未加载（skipping profile bundle），改用 --backend local。");
          if (!success && run.stderr.trim() !== "") writeLine(context, "  stderr：" + run.stderr.trim());
        }
        return success ? 0 : 1;
      }
      const report = await deployCandidates([candidate], { ...deployOptions, dryRun: false });
      if (options.json) writeJson(context, { ok: report.exitCode === 0, mode: "update", scope, item, report });
      else writeLine(context, renderReport(report, color));
      return report.exitCode;
    }

    if (options.command === "status") {
      const filter = options.scopeExplicit ? options.scope : "all";
      const scoped = scopeContext(context.cwd, context.env);
      const payload = buildStatus(scoped, catalog.capabilities, filter);
      if (options.json) {
        writeJson(context, { mode: "status", ...payload });
      } else {
        writeLine(context, renderScopeStatus(payload, color));
      }
      return 0;
    }

    if (options.command === "promote" || options.command === "demote") {
      if (options.scopeExplicit) {
        throw new CliUsageError("promote/demote 的目标作用域是固定的，不接受 --scope。", "promote 固定 project→user；demote 固定 user→project。");
      }
      if (options.ids.length !== 1) {
        throw new CliUsageError(
          options.command + " 一次只能迁移一个条目。",
          "用 --id <id> 指定一个 MCP 或 Skill；先运行 dsh-forage status 查看已安装项。"
        );
      }
      const id = options.ids[0] as string;
      const direction: TransferDirection = options.command === "promote" ? "promote" : "demote";
      const base = {
        direction,
        id,
        kind: options.kind,
        cwd: context.cwd,
        env: context.env,
        dryRun: options.dryRun,
        yes: options.yes,
        keepSource: options.keepSource,
        replace: options.replace,
        dshBin: options.dshBin,
        backend: options.backend,
        timeoutMs: options.timeoutMs
      };
      const plan = previewTransfer(base);
      if (!options.replace && plan.notes.some((note) => note.includes("--replace"))) {
        throw new ScopeError("TARGET_EXISTS", "目标作用域已有同名条目：" + id, "使用 --replace 覆盖，或先移除目标项。");
      }
      if (!options.json) {
        writeLine(context, renderTransferPlan(plan, color));
      }
      if (options.dryRun) {
        const result = await transferItem({ ...base, dryRun: true, yes: true });
        if (options.json) writeJson(context, { ok: true, mode: "plan", direction, result });
        else writeLine(context, renderTransferResult(result, color));
        return 0;
      }
      if (options.json && !options.yes) {
        writeJson(context, { ok: true, mode: "plan", direction, plan });
        return 0;
      }
      let approved = options.yes;
      if (!approved && context.isTTY && !options.noInput) {
        const prompt = createPrompt(context);
        let other: string | undefined;
        try {
          const confirmation = await confirmWithOther(prompt, "确认将 " + id + " 从 " + (direction === "promote" ? "project" : "user") + " 迁移到 " + (direction === "promote" ? "user" : "project") + "？");
          approved = confirmation.approved;
          other = confirmation.other;
        } finally {
          prompt.close();
        }
        if (other !== undefined) {
          writeLine(context, "已记录其他想法：" + other);
          writeLine(context, "已暂停迁移；请根据补充要求重新 plan。");
          return 0;
        }
        if (!approved) {
          writeLine(context, "已取消迁移。");
          return 0;
        }
      }
      if (!approved) {
        throw new ScopeError("CONFIRMATION_REQUIRED", "作用域迁移需要显式审批。", "在交互终端中确认，或传入 --yes；预览请加 --dry-run。");
      }
      const result = await transferItem({ ...base, dryRun: false, yes: true });
      if (options.json) writeJson(context, { ok: result.ok, mode: "transfer", direction, result });
      else writeLine(context, renderTransferResult(result, color));
      return result.ok ? 0 : 1;
    }

    if (options.command === "deploy") {
      const ids = uniqueIds(options.ids.length > 0
        ? options.ids
        : options.query.split(/[,，\s]+/).filter(Boolean));
      if (ids.length === 0) {
        throw new CliUsageError(
          "deploy 需要至少一个 --id。",
          "先运行 dsh-forage plan \"<任务>\" 查看候选 ID。"
        );
      }
      const byId = new Map(catalog.capabilities.map((candidate) => [candidate.id, candidate]));
      const snapshot = readDiscoverySnapshot(scopeContext(context.cwd, context.env));
      for (const candidate of snapshot?.candidates ?? []) {
        if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
      }
      const availableIds = [...byId.keys()];
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw new CliUsageError(
          "未知能力 ID：" + unknown.join(", "),
          "可用 ID：" + availableIds.join(", ")
        );
      }
      const selected = ids.map((id) => byId.get(id)).filter((candidate): candidate is Candidate => candidate !== undefined);
      if (!options.json) {
        writeLine(context, renderDeploymentPreview(selected, options.scope, color, effectiveBackend));
      }
      let approved = options.yes || options.dryRun || !requiresApproval(selected, options.includeHighRisk, context.env);
      let prompt: Prompt | undefined;
      if (!approved && context.isTTY && !options.noInput) {
        prompt = createPrompt(context);
        let other: string | undefined;
        try {
          const confirmation = await confirmWithOther(prompt, "执行以上 " + String(selected.length) + " 项部署？");
          approved = confirmation.approved;
          other = confirmation.other;
        } finally {
          prompt.close();
        }
        if (other !== undefined) {
          writeLine(context, "已记录其他想法：" + other);
          writeLine(context, "已暂停部署；请根据补充要求重新 plan。");
          return 0;
        }
        if (!approved) {
          writeLine(context, "已取消部署。");
          return 0;
        }
      }
      if (!approved) {
        throw new DeployPreflightError(
          "CONFIRMATION_REQUIRED",
          "部署需要显式审批。",
          "在交互终端中确认，或传入 --yes；预览请加 --dry-run。"
        );
      }
      const report = await deployCandidates(selected, {
        scope: options.scope,
        dryRun: options.dryRun,
        yes: true,
        cwd: context.cwd,
        env: context.env,
        dshBin: options.dshBin,
        backend: options.backend,
        timeoutMs: options.timeoutMs,
        includeHighRisk: options.includeHighRisk,
        healthCheck: options.healthCheck && !options.dryRun && context.env.DSH_FORAGE_HEALTH_CHECK !== "off",
        activate: resolveActivate(selected, options)
      });
      if (options.json) writeJson(context, deployPayload(version, undefined, report));
      else writeLine(context, renderReport(report, color));
      return report.exitCode;
    }

    const intent = await resolveIntent(options, context);
    let localMatches: LocalMatch[] = [];
    const localWarnings: string[] = [];
    if (!options.noLocal && (options.command === "plan" || options.command === "forge")) {
      try {
        localMatches = findLocalMatches(scopeContext(context.cwd, context.env), intent, { catalog: catalog.capabilities });
      } catch (error) {
        localWarnings.push("本地能力匹配失败：" + String(error));
      }
    }
    const userNotes: string[] = [];
    if (options.command === "forge" && localMatches.length > 0 && !options.noLocal && context.isTTY && !options.noInput && !options.json) {
      writeLine(context);
      writeLine(context, "本地已安装且与任务相关：");
      for (const match of localMatches) {
        writeLine(context, "  - " + (match.kind === "skill" ? "Skill" : "MCP") + " " + match.name + "（" + match.scope + "，" + String(match.score) + " 分）");
      }
      const prompt = createPrompt(context);
      let useLocal = false;
      try {
        const answer = await prompt.ask("先直接使用这些本地能力？[Y/n/o 其他想法] ");
        const trimmed = answer.trim();
        if (/^(o|other|其他)$/i.test(trimmed)) {
          const note = await prompt.ask("输入其他想法（例如：本地 nature-figure + 新的绘图 MCP）：");
          if (note.trim() !== "") userNotes.push(note.trim());
          writeLine(context, "保留本地匹配，同时继续搜索新能力。");
        } else if (/^(n|no)$/i.test(trimmed)) {
          useLocal = false;
        } else if (/^(y|yes|)$/i.test(trimmed)) {
          useLocal = true;
        } else if (trimmed !== "") {
          userNotes.push(trimmed);
          writeLine(context, "已记录其他想法，保留本地匹配并继续搜索。");
        } else {
          useLocal = true;
        }
      } finally {
        prompt.close();
      }
      if (useLocal) {
        writeLine(context);
        writeLine(context, "使用本地能力，不执行安装。");
        for (const match of localMatches) {
          writeLine(context, "  - " + (match.kind === "skill" ? "Skill" : "MCP") + " " + match.name);
        }
        writeLine(context, "需要搜索新能力时，加 --no-local 重新运行。");
        return 0;
      }
      writeLine(context, "继续搜索 catalog / GitHub 新能力。");
    }
    let candidates = catalog.capabilities;
    let discoveryInfo: { queries: string[]; candidates: number; warnings: string[]; cache: string | null } | undefined;
    const discoveryWarnings: string[] = [];
    const discoveryEnabled = (options.command === "plan" || options.command === "forge")
      && !options.offline
      && (context.env.DSH_FORAGE_DISCOVERY !== "off" || options.github);
    if (discoveryEnabled) {
      const domain = intent.domains.find((value) => value === "research" || value === "office" || value === "development" || value === "other") ?? "other";
      const discovery = await discoverCapabilities(intent, {
        githubToken: context.env.GITHUB_TOKEN ?? context.env.GH_TOKEN,
        githubRepos: Math.min(3, options.githubLimit),
        githubCandidates: 10,
        githubTimeoutMs: 3500,
        includeGithub: true
      });
      discoveryWarnings.push(...discovery.warnings);
      const discovered = discovery.candidates.map((candidate) => ({
        ...candidate,
        domains: candidate.domains.includes(domain) ? candidate.domains : [...candidate.domains, domain]
      }));
      let cache: string | null = null;
      if (discovered.length === 0) {
        discoveryWarnings.push("在线发现没有返回可安装的候选，已回退到 catalog 兜底。");
        try {
          writeDiscoverySnapshot(scopeContext(context.cwd, context.env), {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            queries: discovery.queries,
            warnings: discoveryWarnings,
            candidates: []
          });
        } catch (error) {
          discoveryWarnings.push("发现快照清理失败：" + String(error));
        }
      } else {
        const builtins = catalog.capabilities.filter((candidate) => candidate.install.method === "builtin");
        candidates = [...builtins, ...discovered];
        try {
          const snapshot = writeDiscoverySnapshot(scopeContext(context.cwd, context.env), {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            queries: discovery.queries,
            warnings: discoveryWarnings,
            candidates: discovered
          });
          cache = snapshot;
        } catch (error) {
          discoveryWarnings.push("发现快照写入失败：" + String(error));
        }
      }
      discoveryInfo = { queries: discovery.queries, candidates: discovered.length, warnings: discovery.warnings, cache };
    }
    const httpConfig = httpEmbeddingFromEnv(context.env);
    if (options.embedding === "http" && httpConfig === undefined) {
      throw new CliUsageError(
        "--embedding http 需要 DSH_FORAGE_EMBEDDING_URL。",
        "设置 DSH_FORAGE_EMBEDDING_URL（OpenAI-compatible /api/embed），或改用 --embedding hashed/off。"
      );
    }
    let provider;
    if (options.embedding === "hashed") provider = new HashedEmbeddingProvider();
    else if (options.embedding === "http") provider = new HttpEmbeddingProvider(httpConfig as NonNullable<typeof httpConfig>);
    else if (options.embedding === "auto") provider = httpConfig === undefined ? new HashedEmbeddingProvider() : new HttpEmbeddingProvider(httpConfig);
    const ranked = provider === undefined
      ? rankCandidates(intent, candidates, {
          env: context.env,
          topN: options.top,
          maxDefaults: 2
        })
      : await rankCandidatesWithEmbeddings(intent, candidates, {
          env: context.env,
          topN: options.top,
          maxDefaults: 2,
          provider
        });
    const warnings: string[] = [...localWarnings, ...discoveryWarnings, ...userNotes.map((note) => "用户其他想法：" + note)];
    if (options.scope === "project" && findGitRoot(context.cwd) === undefined) {
      warnings.push("当前目录没有 .git；project 作用域真正部署前需要 git init，或改用 --scope user。");
    }
    const scopedForPlan = scopeContext(context.cwd, context.env);
    const installedInScope = new Map<string, Scope>();
    for (const entry of ranked) {
      const candidate = entry.candidate;
      if (candidate.install.method !== "dsh-install") continue;
      if (options.scope === "session" && candidate.install.kind === "skill") continue;
      if (candidate.install.kind === "mcp") {
        const found = findMcp(scopedForPlan, options.scope, candidate.install.server);
        if (found !== undefined) installedInScope.set(candidate.id, found.scope);
      } else {
        const found = findSkill(scopedForPlan, options.scope, candidate.install.name ?? candidate.id);
        if (found !== undefined) installedInScope.set(candidate.id, found.scope);
      }
    }

    if (options.command === "plan" || (options.json && !options.yes)) {
      if (options.json) {
        writeJson(context, planPayload(version, intent, ranked, options.scope, catalog.files, warnings, effectiveBackend, options.embedding, installedInScope, discoveryInfo, localMatches, userNotes));
      } else {
        writeLine(context, renderPlan(intent, ranked, { version, scope: options.scope, color, localMatches, discovery: discoveryInfo ?? null }));
        if (warnings.length > 0) {
          writeLine(context);
          for (const warning of warnings) writeLine(context, "注意  " + warning);
        }
        const defaults = ranked.filter((entry) => entry.defaultSelected);
        if (defaults.length > 0) {
          writeLine(context);
          writeLine(context, "下一步：dsh-forage deploy --id " + defaults.map((entry) => entry.candidate.id).join(",") + " --scope " + options.scope + " --dry-run");
        }
      }
      return 0;
    }

    if (ranked.length === 0) {
      if (options.json) {
        writeJson(context, planPayload(version, intent, ranked, options.scope, catalog.files, warnings, effectiveBackend, options.embedding, installedInScope, discoveryInfo, localMatches, userNotes));
      } else {
        writeLine(context, renderPlan(intent, ranked, { version, scope: options.scope, color, localMatches, discovery: discoveryInfo ?? null }));
      }
      return 0;
    }

    const defaults = ranked
      .map((entry, index) => entry.defaultSelected ? index : -1)
      .filter((index) => index >= 0);
    const interactive = context.isTTY && !options.noInput;
    let prompt: Prompt | undefined;
    let selectedIndexes: number[] | null = defaults;
    try {
      if (!options.json) {
        writeLine(context, renderPlan(intent, ranked, { version, scope: options.scope, color, localMatches, discovery: discoveryInfo ?? null }));
        if (warnings.length > 0) {
          for (const warning of warnings) writeLine(context, "注意  " + warning);
        }
      }
      if (interactive) {
        prompt = createPrompt(context);
        selectedIndexes = await selectCandidates(ranked, {
          ask: (question) => prompt?.ask(question) ?? Promise.resolve(""),
          write: (text) => context.stdout.write(text + "\n"),
          defaults,
          count: ranked.length,
          interactive: true,
          onOther: (text) => {
            userNotes.push(text);
            warnings.push("用户其他想法：" + text);
            writeLine(context, "已记录其他想法：" + text);
          }
        });
        if (selectedIndexes === null) {
          writeLine(context, "已取消。");
          return 0;
        }
      }
    } finally {
      prompt?.close();
    }

    if (selectedIndexes === null) return 0;
    if (selectedIndexes.length === 0) {
      if (options.json) {
        writeJson(context, {
          ...planPayload(version, intent, ranked, options.scope, catalog.files, warnings, effectiveBackend, options.embedding, installedInScope, discoveryInfo, localMatches, userNotes),
          reason: "no-default-selection"
        });
        return 0;
      }
      writeLine(context, "没有选择任何能力，未部署。");
      return 0;
    }
    const selected = selectedIndexes.map((index) => ranked[index]).filter((entry): entry is RankedCandidate => entry !== undefined).map((entry) => entry.candidate);
    if (!options.json) {
      writeLine(context);
      writeLine(context, renderDeploymentPreview(selected, options.scope, color, effectiveBackend));
    }

    if (options.dryRun) {
      const report = await deployCandidates(selected, {
        scope: options.scope,
        dryRun: true,
        yes: true,
        cwd: context.cwd,
        env: context.env,
        dshBin: options.dshBin,
        backend: options.backend,
        timeoutMs: options.timeoutMs,
        includeHighRisk: options.includeHighRisk,
        healthCheck: options.healthCheck && !options.dryRun && context.env.DSH_FORAGE_HEALTH_CHECK !== "off",
        activate: resolveActivate(selected, options)
      });
      if (options.json) writeJson(context, deployPayload(version, intent, report));
      else writeLine(context, renderReport(report, color));
      return report.exitCode;
    }

    let approved = options.yes || !requiresApproval(selected, options.includeHighRisk, context.env);
    if (!approved && interactive) {
      const answerPrompt = createPrompt(context);
      let other: string | undefined;
      try {
        const confirmation = await confirmWithOther(answerPrompt, "执行以上 " + String(selected.length) + " 项部署？");
        approved = confirmation.approved;
        other = confirmation.other;
      } finally {
        answerPrompt.close();
      }
      if (other !== undefined) {
        writeLine(context, "已记录其他想法：" + other);
        writeLine(context, "已暂停部署；请根据补充要求重新 plan。");
        return 0;
      }
      if (!approved) {
        writeLine(context, "已取消部署。");
        return 0;
      }
    }
    if (!approved) {
      printDeployInstruction(context, selected, options.scope);
      return 0;
    }

    const report = await deployCandidates(selected, {
      scope: options.scope,
      dryRun: false,
      yes: true,
      cwd: context.cwd,
      env: context.env,
      dshBin: options.dshBin,
      backend: options.backend,
      timeoutMs: options.timeoutMs,
      includeHighRisk: options.includeHighRisk
    });
    if (options.json) writeJson(context, deployPayload(version, intent, report));
    else writeLine(context, renderReport(report, color));
    return report.exitCode;
  } catch (error) {
    return reportError(error, options?.json ?? jsonRequested, context, context.env.DSH_FORAGE_DEBUG === "1");
  }
}
