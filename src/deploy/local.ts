import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpInstallSpec, Scope } from "../types.js";
import { readMcpRegistry } from "../scopes/mcp.js";
import { backupSkill, copySkillToRoot, findSkill, parseSkillMeta, recordSkillTransfer, removeSkillPath, removeSkillRecord, restoreSkillBackup } from "../scopes/skills.js";
import { ScopeError, type McpEntry, type ScopeContext, type SkillInfo } from "../scopes/types.js";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LocalMcpWrite {
  path: string;
  backup?: string;
  entry: McpEntry;
}

export interface LocalSkillWrite {
  path: string;
  name: string;
  backup?: string;
}

export interface LocalSkillRemove {
  path: string;
  backup?: string;
}

function localMcpPath(ctx: ScopeContext, scope: Scope): string {
  const file = scope === "user" ? ctx.userMcpPath : scope === "session" ? ctx.sessionMcpPath : ctx.projectMcpPath;
  if (file === undefined) {
    throw new ScopeError("PROJECT_SCOPE_WITHOUT_GIT", "当前目录不是 Git 项目，无法写入项目级 mcp.json。", "运行 git init，或改用 --scope user。");
  }
  return file;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function backupFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let candidate = file + ".bak-" + stamp();
  let index = 1;
  while (existsSync(candidate)) {
    candidate = file + ".bak-" + stamp() + "-" + String(index);
    index += 1;
  }
  copyFileSync(file, candidate);
  return candidate;
}

function writeRegistryAtomic(
  file: string,
  registry: { version?: number; servers: Record<string, McpEntry> },
  backup: string | undefined,
  existed: boolean
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".forage-tmp-" + String(process.pid) + "-" + String(Date.now());
  writeFileSync(temp, JSON.stringify({ version: registry.version ?? 1, servers: registry.servers }, null, 2) + "\n", "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      copyFileSync(temp, file);
      rmSync(temp, { force: true });
    } catch (copyError) {
      rmSync(temp, { force: true });
      try {
        if (backup !== undefined) copyFileSync(backup, file);
        else if (!existed) rmSync(file, { force: true });
      } catch {
        // Best effort: the caller reports the write failure either way.
      }
      throw copyError;
    }
  }
}

function headersObject(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) {
      throw new ScopeError("MCP_HEADER_INVALID", "HTTP header 必须是 Key: Value 形式：" + line, "修正 catalog 的 headers 后重试。");
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "") throw new ScopeError("MCP_HEADER_INVALID", "HTTP header 名称不能为空。", "修正 catalog 的 headers 后重试。");
    headers[key] = value;
  }
  return headers;
}

export function buildLocalMcpEntry(install: McpInstallSpec, enabled = true): McpEntry {
  const origin = { source: "dsh-forage", addedAt: new Date().toISOString() };
  const toolCallTimeoutMs = install.timeoutMs ?? 60000;
  if (install.transport === "http") {
    if (typeof install.url !== "string" || install.url === "") {
      throw new ScopeError("MCP_URL_MISSING", "HTTP MCP 缺少 url。", "修正 catalog 后重试。");
    }
    const entry: McpEntry = {
      transport: "streamable-http",
      url: install.url,
      toolCallTimeoutMs,
      enabled,
      origin
    };
    if (install.headers !== undefined && install.headers.length > 0) entry.headers = headersObject(install.headers);
    return entry;
  }
  if (typeof install.command !== "string" || install.command === "") {
    throw new ScopeError("MCP_COMMAND_MISSING", "stdio MCP 缺少 command。", "修正 catalog 后重试。");
  }
  const env: Record<string, string> = {};
  for (const key of install.env ?? []) env[key] = "${" + key + "}";
  return {
    transport: "stdio",
    command: install.command,
    args: install.args ?? [],
    env,
    cwd: install.cwd ?? "",
    toolCallTimeoutMs,
    enabled,
    origin
  };
}

export function installMcpLocal(ctx: ScopeContext, scope: Scope, install: McpInstallSpec, replace = false, enabled = true): LocalMcpWrite {
  const file = localMcpPath(ctx, scope);
  const registry = readMcpRegistry(file);
  if (registry.servers[install.server] !== undefined && !replace) {
    throw new ScopeError(
      "MCP_EXISTS",
      "同名 MCP 已存在：" + install.server,
      "需要更新时运行 dsh-forage update --id " + install.server + " --scope " + scope + "；本地部署不会静默覆盖。"
    );
  }
  const entry = buildLocalMcpEntry(install, enabled);
  const existed = existsSync(file);
  const backup = backupFile(file);
  registry.servers[install.server] = entry;
  try {
    writeRegistryAtomic(file, registry, backup, existed);
  } catch (error) {
    throw new ScopeError("MCP_WRITE_FAILED", "写入 mcp.json 失败：" + String(error), "检查 " + file + " 的权限和磁盘空间。");
  }
  return { path: file, backup, entry };
}

export function setMcpLocal(
  ctx: ScopeContext,
  scope: Scope,
  name: string,
  entry: McpEntry,
  replace: boolean
): LocalMcpWrite {
  const file = localMcpPath(ctx, scope);
  const registry = readMcpRegistry(file);
  if (registry.servers[name] !== undefined && !replace) {
    throw new ScopeError("TARGET_EXISTS", "目标作用域已有同名 MCP：" + name, "使用 --replace 覆盖，或先移除目标项。");
  }
  const existed = existsSync(file);
  const backup = backupFile(file);
  registry.servers[name] = entry;
  try {
    writeRegistryAtomic(file, registry, backup, existed);
  } catch (error) {
    throw new ScopeError("MCP_WRITE_FAILED", "写入 mcp.json 失败：" + String(error), "检查 " + file + " 的权限和磁盘空间。");
  }
  return { path: file, backup, entry };
}

export function enableMcpLocal(ctx: ScopeContext, scope: Scope, name: string): LocalMcpWrite {
  const file = localMcpPath(ctx, scope);
  const registry = readMcpRegistry(file);
  const entry = registry.servers[name];
  if (entry === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 MCP：" + name, "先运行 dsh-forage status 查看已安装项。");
  }
  const existed = existsSync(file);
  const backup = backupFile(file);
  registry.servers[name] = { ...entry, enabled: true };
  try {
    writeRegistryAtomic(file, registry, backup, existed);
  } catch (error) {
    throw new ScopeError("MCP_WRITE_FAILED", "写入 mcp.json 失败：" + String(error), "检查 " + file + " 的权限和磁盘空间。");
  }
  return { path: file, backup, entry: registry.servers[name] as McpEntry };
}

export function updateMcpLocal(ctx: ScopeContext, scope: Scope, install: McpInstallSpec): LocalMcpWrite {
  const file = localMcpPath(ctx, scope);
  const registry = readMcpRegistry(file);
  if (registry.servers[install.server] === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 MCP：" + install.server, "先运行 dsh-forage deploy 安装，或改用 deploy。");
  }
  return setMcpLocal(ctx, scope, install.server, buildLocalMcpEntry(install), true);
}

export function removeMcpLocal(ctx: ScopeContext, scope: Scope, name: string): LocalMcpWrite {
  const file = localMcpPath(ctx, scope);
  const registry = readMcpRegistry(file);
  const entry = registry.servers[name];
  if (entry === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 MCP：" + name, "运行 dsh-forage status 查看已安装项。");
  }
  const existed = existsSync(file);
  const backup = backupFile(file);
  delete registry.servers[name];
  try {
    writeRegistryAtomic(file, registry, backup, existed);
  } catch (error) {
    throw new ScopeError("MCP_WRITE_FAILED", "写入 mcp.json 失败：" + String(error), "检查 " + file + " 的权限和磁盘空间。");
  }
  return { path: file, backup, entry };
}

function resolveSkillSource(source: string, cwd: string): string {
  const raw = source.trim();
  if (raw === "") throw new ScopeError("SKILL_SOURCE_MISSING", "Skill 缺少 source。", "修正 catalog 后重试。");
  if (/^(?:github|git\+|https?|npm):/i.test(raw)) {
    throw new ScopeError(
      "SKILL_SOURCE_UNSUPPORTED",
      "本地后端只支持本地路径形式的 Skill 源：" + raw,
      "改用 --backend dsh-install 安装 Git/npm 源，或先把 Skill 下载到本地。"
    );
  }
  let value: string;
  if (raw.startsWith("file://")) value = fileURLToPath(raw);
  else if (raw.startsWith("file:")) value = raw.slice("file:".length);
  else value = path.resolve(cwd, raw);
  if (!existsSync(value)) {
    throw new ScopeError("SKILL_SOURCE_NOT_FOUND", "Skill 源不存在：" + value, "检查 catalog 的 source，或传入本地路径。");
  }
  return path.resolve(value);
}

export interface InstallSkillOptions {
  replace?: boolean;
}

export function installSkillLocal(
  ctx: ScopeContext,
  scope: Scope,
  install: { source: string; name?: string; link?: boolean },
  cwd: string,
  options: InstallSkillOptions = {}
): LocalSkillWrite {
  if (install.link === true) {
    throw new ScopeError("SKILL_LINK_UNSUPPORTED", "本地后端不支持 --link。", "改用 --backend dsh-install，或去掉 link。");
  }
  const sourcePath = resolveSkillSource(install.source, cwd);
  const info = statSync(sourcePath);
  let skillFile: string;
  let bundle: boolean;
  if (info.isDirectory()) {
    skillFile = path.join(sourcePath, "SKILL.md");
    bundle = true;
  } else if (info.isFile() && /\.md$/i.test(sourcePath)) {
    skillFile = sourcePath;
    bundle = false;
  } else {
    throw new ScopeError("SKILL_SOURCE_INVALID", "Skill 源必须是 .md 文件或含 SKILL.md 的目录：" + sourcePath, "修正 catalog 的 source。");
  }
  if (!existsSync(skillFile)) {
    throw new ScopeError("SKILL_SOURCE_INVALID", "目录中没有 SKILL.md：" + sourcePath, "修正 catalog 的 source。");
  }
  const meta = parseSkillMeta(skillFile);
  const name = install.name ?? meta.name;
  if (!SKILL_NAME.test(name)) {
    throw new ScopeError("SKILL_NAME_INVALID", "Skill 名称不合法：" + name, "名称必须是 2-64 位 kebab-case。");
  }
  if (scope === "session") {
    throw new ScopeError("SESSION_SKILL_UNSUPPORTED", "session scope 目前只支持 MCP。", "Skill 请用 --scope project 或 --scope user。");
  }
  const targetRoot = scope === "user" ? ctx.userSkillsRoot : ctx.projectSkillsRoot;
  if (targetRoot === undefined) {
    throw new ScopeError("PROJECT_SCOPE_WITHOUT_GIT", "当前目录不是 Git 项目，无法写入项目级 Skill。", "运行 git init，或改用 --scope user。");
  }
  const sourceInfo: SkillInfo = {
    kind: "skill",
    name,
    description: meta.description,
    scope,
    root: targetRoot,
    path: skillFile,
    sourcePath,
    bundle
  };
  const existing = options.replace === true ? findSkill(ctx, scope, name) : undefined;
  if (options.replace === true && existing === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 Skill：" + name, "先运行 dsh-forage deploy 安装，或改用 deploy。");
  }
  let backup: string | undefined;
  if (existing !== undefined) {
    const backupRoot = path.join(ctx.dshHome, "backups", "skill-update-" + stamp() + "-" + String(process.pid));
    backup = backupSkill(existing, backupRoot);
    removeSkillPath(existing);
  }
  try {
    const targetPath = copySkillToRoot(sourceInfo, targetRoot);
    try {
      recordSkillTransfer(ctx, sourceInfo, scope, targetPath);
    } catch (error) {
      rmSync(targetPath, { recursive: true, force: true });
      throw new ScopeError("SKILL_MANIFEST_FAILED", "写入 skills-manifest.json 失败：" + String(error), "检查 " + ctx.skillsManifestPath + " 的权限。");
    }
    return { path: targetPath, name, backup };
  } catch (error) {
    if (existing !== undefined && backup !== undefined) {
      try {
        restoreSkillBackup(backup, existing.root, existing.name, existing.bundle);
      } catch {
        // The caller still gets the original failure; the backup path is reported by the throw site.
      }
    }
    throw error;
  }
}

export function removeSkillLocal(ctx: ScopeContext, scope: Scope, name: string): LocalSkillRemove {
  const existing = findSkill(ctx, scope, name);
  if (existing === undefined) {
    throw new ScopeError("ITEM_NOT_FOUND", "在 " + scope + " 作用域没有找到 Skill：" + name, "运行 dsh-forage status 查看已安装项。");
  }
  const backupRoot = path.join(ctx.dshHome, "backups", "skill-remove-" + stamp() + "-" + String(process.pid));
  const backup = backupSkill(existing, backupRoot);
  try {
    removeSkillPath(existing);
  } catch (error) {
    throw new ScopeError("SKILL_REMOVE_FAILED", "移除 Skill 失败：" + String(error), "检查 " + existing.sourcePath + " 的权限；备份在 " + backup);
  }
  try {
    removeSkillRecord(ctx, name);
  } catch (error) {
    try {
      restoreSkillBackup(backup, existing.root, existing.name, existing.bundle);
    } catch {
      // The manifest failure is the primary error; the backup path is included below.
    }
    throw new ScopeError("SKILL_MANIFEST_FAILED", "更新 skills-manifest.json 失败：" + String(error), "检查 " + ctx.skillsManifestPath + " 的权限；备份在 " + backup);
  }
  return { path: existing.sourcePath, backup };
}

export function localMcpPathForPlan(ctx: ScopeContext, scope: Scope): string {
  return localMcpPath(ctx, scope);
}
