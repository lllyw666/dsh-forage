import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DeployBackend, DeploymentRunner, EffectiveBackend, RunResult, Scope } from "../types.js";
import { DshInstallClient, DshNotFoundError } from "../deploy/dsh-install.js";
import { resolveDeployBackend } from "../deploy/backend.js";
import { localMcpPathForPlan, removeMcpLocal, setMcpLocal } from "../deploy/local.js";
import { commandDisplay, findMcp, isMcpEnabled, mcpAddArgs, mcpLabel, mcpOffArgs, mcpRemoveArgs } from "./mcp.js";
import { scopeContext, requireProjectRoot } from "./paths.js";
import {
  backupSkill,
  copySkillToRoot,
  findSkill,
  readSkillManifest,
  recordSkillTransfer,
  removeSkillAt,
  removeSkillPath,
  restoreSkillBackup
} from "./skills.js";
import { ScopeError, type InstalledItem, type ScopeContext, type SkillInfo, type TransferPlan, type TransferResult } from "./types.js";

export type TransferDirection = "promote" | "demote";
export type TransferKind = "mcp" | "skill";

export interface TransferOptions {
  direction: TransferDirection;
  id: string;
  kind?: TransferKind;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  dryRun: boolean;
  yes: boolean;
  keepSource: boolean;
  replace: boolean;
  dshBin?: string;
  timeoutMs?: number;
  runner?: DeploymentRunner;
  backend?: DeployBackend;
}

interface ResolvedItem {
  ctx: ScopeContext;
  backend: EffectiveBackend;
  kind: TransferKind;
  sourceScope: Scope;
  targetScope: Scope;
  item: InstalledItem;
  sourceMcp?: ReturnType<typeof findMcp>;
  sourceSkill?: SkillInfo;
  targetMcp?: ReturnType<typeof findMcp>;
  targetSkill?: SkillInfo;
}

function sourceScopeFor(direction: TransferDirection): Scope {
  return direction === "promote" ? "project" : "user";
}

function targetScopeFor(direction: TransferDirection): Scope {
  return direction === "promote" ? "user" : "project";
}

function resolveItem(options: TransferOptions): ResolvedItem {
  const env = options.env ?? process.env;
  const ctx = scopeContext(options.cwd, env);
  requireProjectRoot(ctx);
  const hasExplicitDsh = options.runner !== undefined
    || options.dshBin !== undefined
    || (env.DSH_FORAGE_DSH_BIN !== undefined && env.DSH_FORAGE_DSH_BIN.trim() !== "");
  const backend = resolveDeployBackend(options.backend, hasExplicitDsh);
  const sourceScope = sourceScopeFor(options.direction);
  const targetScope = targetScopeFor(options.direction);
  const sourceMcp = findMcp(ctx, sourceScope, options.id);
  const sourceSkill = findSkill(ctx, sourceScope, options.id);
  let kind = options.kind;
  if (kind === undefined) {
    if (sourceMcp !== undefined && sourceSkill !== undefined) {
      throw new ScopeError(
        "AMBIGUOUS_ITEM",
        "项目里同时存在同名 MCP 和 Skill：" + options.id,
        "使用 --kind mcp 或 --kind skill 明确选择。"
      );
    }
    kind = sourceMcp === undefined ? "skill" : "mcp";
  }
  if (kind === "mcp") {
    if (sourceMcp === undefined) {
      throw new ScopeError("ITEM_NOT_FOUND", "在 " + sourceScope + " 作用域没有找到 MCP：" + options.id, "运行 dsh-forage status 查看已安装项。");
    }
    return {
      ctx,
      backend,
      kind,
      sourceScope,
      targetScope,
      item: { kind: "mcp", name: sourceMcp.name, description: mcpLabel(sourceMcp.entry), scope: sourceScope, path: sourceMcp.path },
      sourceMcp,
      targetMcp: findMcp(ctx, targetScope, sourceMcp.name)
    };
  }
  if (sourceSkill === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + sourceScope + " 作用域没有找到 Skill：" + options.id, "运行 dsh-forage status 查看已安装项。");
  }
  return {
    ctx,
    backend,
    kind,
    sourceScope,
    targetScope,
    item: { kind: "skill", name: sourceSkill.name, description: sourceSkill.description, scope: sourceScope, path: sourceSkill.sourcePath },
    sourceSkill,
    targetSkill: findSkill(ctx, targetScope, sourceSkill.name)
  };
}

function mcpPlan(resolved: ResolvedItem, options: TransferOptions): TransferPlan {
  const entry = resolved.sourceMcp?.entry;
  if (entry === undefined) throw new ScopeError("ITEM_NOT_FOUND", "MCP 条目不存在。", "重新运行 status。");
  const notes = resolved.targetMcp !== undefined && !options.replace ? ["目标作用域已有同名项，需要 --replace。"] : [];
  if (resolved.backend === "local") {
    const commands = ["local: write " + resolved.item.name + " -> " + localMcpPathForPlan(resolved.ctx, resolved.targetScope)];
    if (!options.keepSource) {
      commands.push("local: remove " + resolved.item.name + " from " + localMcpPathForPlan(resolved.ctx, resolved.sourceScope));
    }
    return { item: resolved.item, sourceScope: resolved.sourceScope, targetScope: resolved.targetScope, commands, notes };
  }
  const commands: string[] = [];
  if (resolved.targetMcp !== undefined && options.replace) commands.push(commandDisplay(mcpRemoveArgs(resolved.item.name, resolved.targetScope)));
  commands.push(commandDisplay(mcpAddArgs(resolved.item.name, entry, resolved.targetScope)));
  if (!isMcpEnabled(entry)) commands.push(commandDisplay(mcpOffArgs(resolved.item.name, resolved.targetScope)));
  if (!options.keepSource) commands.push(commandDisplay(mcpRemoveArgs(resolved.item.name, resolved.sourceScope)));
  return {
    item: resolved.item,
    sourceScope: resolved.sourceScope,
    targetScope: resolved.targetScope,
    commands,
    notes
  };
}

function skillPlan(resolved: ResolvedItem, options: TransferOptions): TransferPlan {
  const source = resolved.sourceSkill;
  if (source === undefined) throw new ScopeError("ITEM_NOT_FOUND", "Skill 条目不存在。", "重新运行 status。");
  const targetRoot = resolved.ctx.projectSkillsRoot;
  if (targetRoot === undefined && resolved.targetScope === "project") {
    throw new ScopeError("PROJECT_SCOPE_WITHOUT_GIT", "当前目录不是 Git 项目。", "运行 git init 后重试。");
  }
  const targetBase = resolved.targetScope === "user" ? resolved.ctx.userSkillsRoot : (resolved.ctx.projectSkillsRoot as string);
  const targetPath = source.bundle ? path.join(targetBase, source.name) : path.join(targetBase, source.name + ".md");
  const commands = ["copy " + source.sourcePath + " -> " + targetPath, "update skills-manifest.json"];
  if (!options.keepSource) commands.push("delete " + source.sourcePath);
  return {
    item: resolved.item,
    sourceScope: resolved.sourceScope,
    targetScope: resolved.targetScope,
    commands,
    notes: resolved.targetSkill !== undefined && !options.replace ? ["目标作用域已有同名 Skill，需要 --replace。"] : []
  };
}

function resultMessage(resolved: ResolvedItem): string {
  return resolved.targetScope === "user" ? "已提升为用户级。所有项目都会看到它。" : "已降级为项目级。只在当前项目生效。";
}

async function runCommand(
  runner: DeploymentRunner,
  args: string[],
  timeoutMs: number
): Promise<RunResult> {
  return runner.run(args, timeoutMs);
}

function failedResult(
  resolved: ResolvedItem,
  commands: string[],
  message: string,
  fix: string,
  warnings: string[]
): TransferResult {
  return {
    ok: false,
    item: resolved.item,
    sourceScope: resolved.sourceScope,
    targetScope: resolved.targetScope,
    status: "failed",
    message,
    commands,
    warnings,
    fix
  };
}

function transferMcpLocal(resolved: ResolvedItem, options: TransferOptions, plan: TransferPlan): TransferResult {
  const source = resolved.sourceMcp;
  if (source === undefined) throw new ScopeError("ITEM_NOT_FOUND", "MCP 条目不存在。", "重新运行 status。");
  const commands = [...plan.commands];
  const warnings: string[] = [];
  if (options.keepSource) warnings.push("保留了源作用域副本；同名项目级条目会继续遮蔽用户级条目。");
  try {
    const written = setMcpLocal(resolved.ctx, resolved.targetScope, source.name, source.entry, options.replace);
    commands.push("local: wrote " + written.path + (written.backup === undefined ? "" : "（备份：" + written.backup + "）"));
  } catch (error) {
    const fix = error instanceof ScopeError ? error.fix : "检查 mcp.json 的权限和 JSON 格式。";
    return failedResult(
      resolved,
      plan.commands,
      "迁移到 " + resolved.targetScope + " 作用域失败：" + (error instanceof Error ? error.message : String(error)),
      fix,
      warnings
    );
  }
  if (!options.keepSource) {
    try {
      const removed = removeMcpLocal(resolved.ctx, resolved.sourceScope, source.name);
      commands.push("local: removed from " + removed.path + (removed.backup === undefined ? "" : "（备份：" + removed.backup + "）"));
    } catch (error) {
      warnings.push("目标作用域已安装，但源作用域移除失败：" + (error instanceof Error ? error.message : String(error)) + "；项目级配置仍会遮蔽用户级。");
    }
  }
  return {
    ok: true,
    item: resolved.item,
    sourceScope: resolved.sourceScope,
    targetScope: resolved.targetScope,
    status: resolved.targetScope === "user" ? "promoted" : "demoted",
    message: resultMessage(resolved),
    commands,
    warnings
  };
}

async function transferMcp(resolved: ResolvedItem, options: TransferOptions): Promise<TransferResult> {
  const source = resolved.sourceMcp;
  if (source === undefined) throw new ScopeError("ITEM_NOT_FOUND", "MCP 条目不存在。", "重新运行 status。");
  const plan = mcpPlan(resolved, options);
  if (options.dryRun) {
    return {
      ok: true,
      item: resolved.item,
      sourceScope: resolved.sourceScope,
      targetScope: resolved.targetScope,
      status: "planned",
      message: "预览模式，未执行。",
      commands: plan.commands,
      warnings: []
    };
  }
  if (resolved.backend === "local") return transferMcpLocal(resolved, options, plan);
  let runner = options.runner;
  if (runner === undefined) {
    try {
      const client = new DshInstallClient({ dshBin: options.dshBin, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
      client.resolve();
      runner = client;
    } catch (error) {
      if (error instanceof DshNotFoundError) {
        throw new ScopeError("DSH_NOT_FOUND", error.message, error.fix);
      }
      throw error;
    }
  }
  const timeoutMs = options.timeoutMs ?? 180_000;
  const commands: string[] = [];
  const warnings: string[] = [];
  if (options.keepSource) warnings.push("保留了源作用域副本；同名项目级条目会继续遮蔽用户级条目。");
  if (resolved.targetMcp !== undefined && options.replace) {
    const removeArgs = mcpRemoveArgs(resolved.item.name, resolved.targetScope);
    commands.push(commandDisplay(removeArgs));
    const removed = await runCommand(runner, removeArgs, timeoutMs);
    if (removed.code !== 0 || removed.error !== undefined) {
      return failedResult(resolved, commands, "移除目标作用域同名 MCP 失败。", "先运行 dsh --profile install mcp remove " + resolved.item.name + " --scope " + resolved.targetScope + "，再重试。", warnings);
    }
  }
  const addArgs = mcpAddArgs(resolved.item.name, source.entry, resolved.targetScope);
  commands.push(commandDisplay(addArgs));
  const added = await runCommand(runner, addArgs, timeoutMs);
  if (added.code !== 0 || added.error !== undefined) {
    if (resolved.targetMcp !== undefined && options.replace) {
      const restoreArgs = mcpAddArgs(resolved.item.name, resolved.targetMcp.entry, resolved.targetScope);
      const restored = await runCommand(runner, restoreArgs, timeoutMs);
      if (restored.code !== 0) warnings.push("目标作用域原 MCP 的恢复也失败了，请手动检查 mcp.json。");
    }
    const detail = added.error ?? added.stderr.trim() ?? ("退出码 " + String(added.code));
    return failedResult(resolved, commands, "迁移到 " + resolved.targetScope + " 作用域失败：" + detail, "检查 dsh、网络和 MCP 配置后重试。", warnings);
  }
  if (!isMcpEnabled(source.entry)) {
    const offArgs = mcpOffArgs(resolved.item.name, resolved.targetScope);
    commands.push(commandDisplay(offArgs));
    const off = await runCommand(runner, offArgs, timeoutMs);
    if (off.code !== 0) warnings.push("已复制配置，但启用状态未能同步为 disabled。");
  }
  if (!options.keepSource) {
    const removeSourceArgs = mcpRemoveArgs(resolved.item.name, resolved.sourceScope);
    commands.push(commandDisplay(removeSourceArgs));
    const removedSource = await runCommand(runner, removeSourceArgs, timeoutMs);
    if (removedSource.code !== 0) warnings.push("目标作用域已安装，但源作用域移除失败；项目级配置仍会遮蔽用户级。");
  }
  return {
    ok: true,
    item: resolved.item,
    sourceScope: resolved.sourceScope,
    targetScope: resolved.targetScope,
    status: resolved.targetScope === "user" ? "promoted" : "demoted",
    message: resultMessage(resolved),
    commands,
    warnings
  };
}

async function transferSkill(resolved: ResolvedItem, options: TransferOptions): Promise<TransferResult> {
  const source = resolved.sourceSkill;
  if (source === undefined) throw new ScopeError("ITEM_NOT_FOUND", "Skill 条目不存在。", "重新运行 status。");
  const plan = skillPlan(resolved, options);
  if (options.dryRun) {
    return {
      ok: true,
      item: resolved.item,
      sourceScope: resolved.sourceScope,
      targetScope: resolved.targetScope,
      status: "planned",
      message: "预览模式，未执行。",
      commands: plan.commands,
      warnings: []
    };
  }
  const targetRoot = resolved.targetScope === "user" ? resolved.ctx.userSkillsRoot : (resolved.ctx.projectSkillsRoot as string);
  const manifestBefore = existsSync(resolved.ctx.skillsManifestPath)
    ? readFileSync(resolved.ctx.skillsManifestPath, "utf8")
    : undefined;
  const manifest = readSkillManifest(resolved.ctx.skillsManifestPath);
  const possibleSourceRecord = manifest.skills[source.name];
  const sourceRecord = possibleSourceRecord?.scope === resolved.sourceScope ? possibleSourceRecord : undefined;
  const tempRoot = path.join(resolved.ctx.dshHome, ".forage-tmp", "transfer-" + String(Date.now()) + "-" + String(process.pid));
  let targetBackup: string | undefined;
  const warnings: string[] = [];
  if (options.keepSource) warnings.push("保留了源作用域副本；同名项目级 Skill 会继续遮蔽用户级 Skill。");
  try {
    if (resolved.targetSkill !== undefined && options.replace) {
      targetBackup = backupSkill(resolved.targetSkill, tempRoot);
      removeSkillPath(resolved.targetSkill);
    }
    const targetPath = copySkillToRoot(source, targetRoot);
    try {
      recordSkillTransfer(resolved.ctx, source, resolved.targetScope, targetPath, sourceRecord);
    } catch (error) {
      rmSync(targetPath, { recursive: true, force: true });
      throw error;
    }
    if (!options.keepSource) {
      try {
        removeSkillPath(source);
      } catch (error) {
        warnings.push("目标作用域已复制，但源 Skill 删除失败：" + String(error));
      }
    } else {
      warnings.push("保留了源 Skill；同名清单记录已指向目标作用域。");
    }
    return {
      ok: true,
      item: resolved.item,
      sourceScope: resolved.sourceScope,
      targetScope: resolved.targetScope,
      status: resolved.targetScope === "user" ? "promoted" : "demoted",
      message: resultMessage(resolved),
      commands: plan.commands,
      warnings
    };
  } catch (error) {
    if (targetBackup !== undefined && resolved.targetSkill !== undefined) {
      try {
        restoreSkillBackup(targetBackup, targetRoot, resolved.targetSkill.name, resolved.targetSkill.bundle);
      } catch {
        warnings.push("目标作用域原 Skill 的恢复失败，请手动检查。");
      }
    } else {
      try { removeSkillAt(targetRoot, source.name, source.bundle); } catch { /* best effort */ }
    }
    if (manifestBefore !== undefined) {
      try { writeFileSync(resolved.ctx.skillsManifestPath, manifestBefore, "utf8"); } catch { /* best effort */ }
    } else {
      try { rmSync(resolved.ctx.skillsManifestPath, { force: true }); } catch { /* best effort */ }
    }
    const detail = error instanceof Error ? error.message : String(error);
    return failedResult(resolved, plan.commands, "迁移 Skill 失败：" + detail, "检查 skills 目录权限和清单后重试；源 Skill 未被删除。", warnings);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function transferItem(options: TransferOptions): Promise<TransferResult> {
  const resolved = resolveItem(options);
  if (resolved.targetMcp !== undefined && !options.replace) {
    throw new ScopeError("TARGET_EXISTS", "目标作用域已有同名 MCP：" + resolved.item.name, "使用 --replace 覆盖，或先移除目标项。");
  }
  if (resolved.targetSkill !== undefined && !options.replace) {
    throw new ScopeError("TARGET_EXISTS", "目标作用域已有同名 Skill：" + resolved.item.name, "使用 --replace 覆盖，或先移除目标项。");
  }
  if (!options.dryRun && !options.yes) {
    throw new ScopeError("CONFIRMATION_REQUIRED", "作用域迁移需要显式审批。", "在交互终端中确认，或传入 --yes；预览请加 --dry-run。");
  }
  return resolved.kind === "mcp" ? transferMcp(resolved, options) : transferSkill(resolved, options);
}

export function previewTransfer(options: TransferOptions): TransferPlan {
  const resolved = resolveItem(options);
  return resolved.kind === "mcp" ? mcpPlan(resolved, options) : skillPlan(resolved, options);
}
