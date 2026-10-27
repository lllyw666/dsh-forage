import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scope } from "../types.js";
import { ScopeError, type ScopeContext } from "./types.js";

export function findProjectRoot(start: string): string | undefined {
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

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim();
  if (configured !== undefined && configured !== "") {
    let value = configured;
    if (value === "~") value = os.homedir();
    else if (value.startsWith("~/") || value.startsWith("~\\")) {
      value = path.join(os.homedir(), value.slice(2));
    }
    return path.resolve(value);
  }
  return path.join(os.homedir(), ".dsh");
}

export function scopeContext(cwd: string, env: NodeJS.ProcessEnv = process.env): ScopeContext {
  const dshHome = resolveDshHome(env);
  const projectRoot = findProjectRoot(cwd);
  const sessionId = env.DSH_SESSION_ID?.trim() || "default";
  return {
    cwd: path.resolve(cwd),
    dshHome,
    projectRoot,
    sessionId,
    userMcpPath: path.join(dshHome, "mcp.json"),
    projectMcpPath: projectRoot === undefined ? undefined : path.join(projectRoot, ".dsh", "mcp.json"),
    sessionMcpPath: path.join(dshHome, "forage", "session-mcp.json"),
    userSkillsRoot: path.join(dshHome, "skills"),
    projectSkillsRoot: projectRoot === undefined ? undefined : path.join(projectRoot, ".dsh", "skills"),
    skillsManifestPath: path.join(dshHome, "skills-manifest.json")
  };
}

export function requireProjectRoot(ctx: ScopeContext): string {
  if (ctx.projectRoot === undefined) {
    throw new ScopeError(
      "PROJECT_SCOPE_WITHOUT_GIT",
      "当前目录不在一个含 .git 目录的项目中，project scope 无法使用。",
      "在项目根目录运行 git init，或改用 --scope user。"
    );
  }
  return ctx.projectRoot;
}

export function mcpPath(ctx: ScopeContext, scope: Scope): string {
  if (scope === "user") return ctx.userMcpPath;
  if (scope === "session") return ctx.sessionMcpPath;
  if (ctx.projectMcpPath === undefined) {
    throw new ScopeError(
      "PROJECT_SCOPE_WITHOUT_GIT",
      "当前目录不在一个含 .git 目录的项目中。",
      "运行 git init，或改用 user scope。"
    );
  }
  return ctx.projectMcpPath;
}

export function skillsRoot(ctx: ScopeContext, scope: Scope): string {
  if (scope === "user") return ctx.userSkillsRoot;
  if (scope === "session") {
    throw new ScopeError(
      "SESSION_SKILL_UNSUPPORTED",
      "session scope 目前只支持 MCP；DSH 没有按会话动态扫描 Skill 的入口。",
      "Skill 请用 --scope project 或 --scope user；MCP 可以用 --scope session。"
    );
  }
  if (ctx.projectSkillsRoot === undefined) {
    throw new ScopeError(
      "PROJECT_SCOPE_WITHOUT_GIT",
      "当前目录不在一个含 .git 目录的项目中。",
      "运行 git init，或改用 user scope。"
    );
  }
  return ctx.projectSkillsRoot;
}
