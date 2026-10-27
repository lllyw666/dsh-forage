import { readFileSync } from "node:fs";
import type { Candidate, Intent, Scope } from "../types.js";
import { listMcps } from "./mcp.js";
import { listSkills } from "./skills.js";
import type { ScopeContext, SkillInfo } from "./types.js";

export interface LocalMatch {
  kind: "mcp" | "skill";
  name: string;
  scope: Scope;
  description: string;
  path: string;
  score: number;
  reasons: string[];
  catalogId?: string;
}

export interface LocalMatchOptions {
  catalog?: Candidate[];
  minScore?: number;
  max?: number;
  exclude?: string[];
}

const ALIASES: Record<string, string[]> = {
  "论文撰写": ["论文", "撰写", "写作", "paper", "writing", "manuscript"],
  "论文写作": ["论文", "写作", "paper", "writing", "manuscript"],
  "科研绘图": ["科研", "绘图", "可视化", "figure", "plot", "plotting", "scientific"],
  "文献检索": ["文献", "检索", "paper", "literature", "search"],
  "引用整理": ["引用", "citation", "reference", "bibtex"],
  "PDF解析": ["pdf", "全文", "解析", "parse"],
  "本地文献库": ["文献库", "library", "zotero", "local"]
};

function termsFor(intent: Intent): string[] {
  const raw = [...intent.tasks, ...intent.signals];
  const expanded = raw.flatMap((term) => [term, ...(ALIASES[term] ?? [])]);
  return [...new Set(expanded.map((term) => term.toLowerCase().trim()).filter((term) => term.length >= 2))];
}

function scoreText(text: string, intent: Intent, terms: string[]): { score: number; reasons: string[] } {
  const haystack = text.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += Math.min(12, term.length);
  }
  for (const task of intent.tasks) {
    if (haystack.includes(task.toLowerCase())) {
      score += 18;
      reasons.push("任务匹配：" + task);
    }
  }
  for (const domain of intent.domains) {
    if (haystack.includes(domain.toLowerCase())) {
      score += 6;
      reasons.push("领域匹配：" + domain);
    }
  }
  return { score, reasons };
}

function skillDescription(skill: SkillInfo): string {
  let body = "";
  try {
    body = readFileSync(skill.path, "utf8").slice(0, 20000);
  } catch {
    // A broken/missing SKILL.md is reported by status; matching simply skips it.
  }
  return skill.name + " " + skill.description + " " + body;
}

/**
 * Find already-installed capabilities that look relevant to the task. This is
 * deliberately a local-first read: it never installs, and the caller decides
 * whether to use a match or continue searching.
 */
export function findLocalMatches(
  ctx: ScopeContext,
  intent: Intent,
  options: LocalMatchOptions = {}
): LocalMatch[] {
  const catalog = options.catalog ?? [];
  const terms = termsFor(intent);
  const minScore = Math.max(1, options.minScore ?? 8);
  const max = Math.max(1, Math.min(10, options.max ?? 5));
  const exclude = new Set(options.exclude ?? ["dsh-forage"]);
  const matches: LocalMatch[] = [];

  const catalogForMcp = (name: string) => catalog.find(
    (candidate) => candidate.install.method === "dsh-install"
      && candidate.install.kind === "mcp"
      && candidate.install.server === name
  );
  const catalogForSkill = (skill: SkillInfo) => catalog.find(
    (candidate) => candidate.type === "skill" && (candidate.id === skill.name || candidate.name === skill.name)
  );

  const effectiveSkills = new Map<string, SkillInfo>();
  for (const skill of listSkills(ctx)) {
    const existing = effectiveSkills.get(skill.name);
    if (existing === undefined || skill.scope === "project") effectiveSkills.set(skill.name, skill);
  }
  for (const skill of effectiveSkills.values()) {
    if (exclude.has(skill.name)) continue;
    const match = catalogForSkill(skill);
    const description = skill.description || match?.description || "";
    const scored = scoreText(skillDescription(skill) + " " + description + " " + (match?.tasks ?? []).join(" "), intent, terms);
    if (scored.score < minScore) continue;
    matches.push({
      kind: "skill",
      name: skill.name,
      scope: skill.scope,
      description,
      path: skill.sourcePath,
      score: scored.score,
      reasons: scored.reasons.length > 0 ? scored.reasons : ["本地 Skill 名称/描述匹配"],
      ...(match === undefined ? {} : { catalogId: match.id })
    });
  }

  for (const mcp of listMcps(ctx)) {
    if (mcp.shadowedBy !== undefined) continue;
    if (mcp.entry.enabled === false) continue;
    const match = catalogForMcp(mcp.name);
    const text = [
      mcp.name,
      match?.description ?? "",
      ...(match?.tasks ?? []),
      ...(match?.tools ?? []),
      typeof mcp.entry.command === "string" ? mcp.entry.command : "",
      ...(Array.isArray(mcp.entry.args) ? mcp.entry.args : [])
    ].join(" ");
    const scored = scoreText(text, intent, terms);
    if (match !== undefined && match.domains.some((domain) => intent.domains.includes(domain))) {
      scored.score += 8;
      scored.reasons.push("领域匹配：catalog");
    }
    if (scored.score < minScore) continue;
    matches.push({
      kind: "mcp",
      name: mcp.name,
      scope: mcp.scope,
      description: match?.description ?? (typeof mcp.entry.command === "string" ? mcp.entry.command : "local MCP"),
      path: mcp.path,
      score: scored.score,
      reasons: scored.reasons.length > 0 ? scored.reasons : ["本地 MCP 名称/元数据匹配"],
      ...(match === undefined ? {} : { catalogId: match.id })
    });
  }

  return matches.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, max);
}
