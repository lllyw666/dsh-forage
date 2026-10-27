import type { Candidate, Scope } from "../types.js";
import { listMcps } from "./mcp.js";
import { listSkills } from "./skills.js";
import type { InstalledMcp, ScopeContext, SkillInfo } from "./types.js";

export interface StatusMcp extends InstalledMcp {
  toolCount?: number;
  toolCountSource?: "catalog";
  catalogId?: string;
}

export interface StatusSkill extends SkillInfo {
  toolCount?: number;
  toolCountSource?: "catalog";
  catalogId?: string;
}

export interface StatusPayload {
  ok: true;
  dshHome: string;
  projectRoot: string | null;
  scope: Scope | "all";
  mcps: StatusMcp[];
  skills: StatusSkill[];
  warnings: string[];
  summary: { userMcps: number; projectMcps: number; sessionMcps: number; userSkills: number; projectSkills: number };
}

function mcpCatalog(catalog: Candidate[], name: string): Candidate | undefined {
  return catalog.find(
    (candidate) => candidate.install.method === "dsh-install"
      && candidate.install.kind === "mcp"
      && candidate.install.server === name
  );
}

function skillCatalog(catalog: Candidate[], skill: SkillInfo): Candidate | undefined {
  return catalog.find(
    (candidate) => candidate.type === "skill" && (candidate.id === skill.name || candidate.name === skill.name)
  );
}

export function buildStatus(ctx: ScopeContext, catalog: Candidate[], filter: Scope | "all" = "all"): StatusPayload {
  const warnings: string[] = [];
  if (ctx.projectRoot === undefined) warnings.push("当前目录没有 .git 目录；project scope 不可用，下面的 project 列表为空。");
  const allMcps = listMcps(ctx).map((item): StatusMcp => {
    const match = mcpCatalog(catalog, item.name);
    return {
      ...item,
      ...match === undefined ? {} : { toolCount: match.toolCount ?? match.tools.length, toolCountSource: "catalog" as const, catalogId: match.id }
    };
  });
  const rawSkills = filter === "session" ? [] : listSkills(ctx);
  const allSkills = rawSkills.map((item): StatusSkill => {
    const match = skillCatalog(catalog, item);
    const shadowedBy = item.scope === "user" && rawSkills.some((other) => other.scope === "project" && other.name === item.name)
      ? "project" as Scope
      : undefined;
    return {
      ...item,
      ...shadowedBy === undefined ? {} : { shadowedBy },
      ...match === undefined ? {} : { toolCount: match.toolCount ?? match.tools.length, toolCountSource: "catalog" as const, catalogId: match.id }
    };
  });
  const mcps = filter === "all" ? allMcps : allMcps.filter((item) => item.scope === filter);
  const skills = filter === "all" ? allSkills : allSkills.filter((item) => item.scope === filter);
  return {
    ok: true,
    dshHome: ctx.dshHome,
    projectRoot: ctx.projectRoot ?? null,
    scope: filter,
    mcps,
    skills,
    warnings,
    summary: {
      userMcps: allMcps.filter((item) => item.scope === "user").length,
      projectMcps: allMcps.filter((item) => item.scope === "project").length,
      sessionMcps: allMcps.filter((item) => item.scope === "session").length,
      userSkills: allSkills.filter((item) => item.scope === "user").length,
      projectSkills: allSkills.filter((item) => item.scope === "project").length
    }
  };
}
