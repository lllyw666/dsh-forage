import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Scope } from "../types.js";
import { skillsRoot } from "./paths.js";
import { ScopeError, type ScopeContext, type SkillInfo, type SkillManifest, type SkillManifestRecord } from "./types.js";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillMeta(file: string): { name: string; description: string } {
  const text = readFileSync(file, "utf8");
  const base = path.basename(path.dirname(file));
  const fallbackName = path.basename(file).replace(/\.md$/i, "");
  let name = file.endsWith("SKILL.md") ? base : fallbackName;
  let description = "";
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const end = text.indexOf("\n---", 4);
    if (end >= 0) {
      const frontmatter = text.slice(4, end);
      for (const line of frontmatter.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (match === null) continue;
        const key = match[1];
        const value = stripQuotes(match[2] ?? "");
        if (key === "name" && value !== "") name = value;
        if (key === "description" && value !== "") description = value;
      }
    }
  }
  if (description === "") {
    const body = text.replace(/^---[\s\S]*?\n---\r?\n/, "");
    const first = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("#"));
    description = first ?? "";
  }
  return { name, description };
}

function skillAt(root: string, scope: Scope, entryName: string, bundle: boolean): SkillInfo | undefined {
  const sourcePath = path.join(root, entryName);
  const skillFile = bundle ? path.join(sourcePath, "SKILL.md") : sourcePath;
  if (!existsSync(skillFile)) return undefined;
  try {
    const meta = parseSkillMeta(skillFile);
    if (!SKILL_NAME.test(meta.name)) return undefined;
    return {
      kind: "skill",
      name: meta.name,
      description: meta.description,
      scope,
      root,
      path: skillFile,
      sourcePath,
      bundle
    };
  } catch {
    return undefined;
  }
}

export function listSkills(ctx: ScopeContext, scope?: Scope): SkillInfo[] {
  const scopes: Scope[] = scope === undefined ? ["project", "user"] : [scope];
  const out: SkillInfo[] = [];
  for (const current of scopes) {
    if (current === "project" && ctx.projectSkillsRoot === undefined) continue;
    const root = skillsRoot(ctx, current);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const info = entry.isDirectory()
        ? skillAt(root, current, entry.name, true)
        : entry.isFile() && entry.name.endsWith(".md")
          ? skillAt(root, current, entry.name, false)
          : undefined;
      if (info !== undefined) out.push(info);
    }
  }
  return out;
}

export function findSkill(ctx: ScopeContext, scope: Scope, id: string): SkillInfo | undefined {
  return listSkills(ctx, scope).find((skill) => skill.name === id || path.basename(skill.sourcePath).replace(/\.md$/i, "") === id);
}

export function skillTargetPath(root: string, name: string, bundle: boolean): string {
  return bundle ? path.join(root, name) : path.join(root, name + ".md");
}

export function copySkillToRoot(source: SkillInfo, targetRoot: string): string {
  mkdirSync(targetRoot, { recursive: true });
  const target = skillTargetPath(targetRoot, source.name, source.bundle);
  if (existsSync(target)) {
    throw new ScopeError("TARGET_EXISTS", "目标作用域已存在同名 Skill：" + source.name, "使用 --replace，或先移除目标作用域的 Skill。");
  }
  if (source.bundle) cpSync(source.sourcePath, target, { recursive: true, dereference: true });
  else cpSync(source.path, target, { dereference: true });
  return target;
}

export function removeSkillPath(skill: SkillInfo): void {
  rmSync(skill.sourcePath, { recursive: true, force: true });
}

export function removeSkillAt(root: string, name: string, bundle: boolean): void {
  rmSync(skillTargetPath(root, name, bundle), { recursive: true, force: true });
}

export function backupSkill(source: SkillInfo, tempRoot: string): string {
  mkdirSync(tempRoot, { recursive: true });
  const backup = path.join(tempRoot, source.name);
  if (source.bundle) cpSync(source.sourcePath, backup, { recursive: true, dereference: true });
  else cpSync(source.path, backup + ".md", { dereference: true });
  return backup;
}

export function restoreSkillBackup(backup: string, targetRoot: string, name: string, bundle: boolean): void {
  mkdirSync(targetRoot, { recursive: true });
  const target = skillTargetPath(targetRoot, name, bundle);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  if (bundle) cpSync(backup, target, { recursive: true, dereference: true });
  else cpSync(backup + ".md", target, { dereference: true });
}

export function readSkillManifest(file: string): SkillManifest {
  if (!existsSync(file)) return { version: 1, skills: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ScopeError("SKILL_MANIFEST_INVALID", "skills-manifest.json 不是合法 JSON：" + file, String(error));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ScopeError("SKILL_MANIFEST_INVALID", "skills-manifest.json 根必须是对象。", "修正清单后重试。");
  }
  const record = parsed as Record<string, unknown>;
  if (record.skills === undefined) return { version: 1, skills: {} };
  if (typeof record.skills !== "object" || record.skills === null || Array.isArray(record.skills)) {
    throw new ScopeError("SKILL_MANIFEST_INVALID", "skills-manifest.json 的 skills 必须是对象。", "修正清单后重试。");
  }
  return { version: 1, skills: record.skills as Record<string, SkillManifestRecord> };
}

export function writeSkillManifest(file: string, manifest: SkillManifest): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".forage-tmp-" + String(process.pid) + "-" + String(Date.now());
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try {
    renameSync(temp, file);
  } catch {
    cpSync(temp, file);
    rmSync(temp, { force: true });
  }
}

export function manifestRecord(manifest: SkillManifest, name: string): SkillManifestRecord | undefined {
  return manifest.skills[name];
}

export function recordSkillTransfer(
  ctx: ScopeContext,
  source: SkillInfo,
  targetScope: Scope,
  targetPath: string,
  previousRecord?: SkillManifestRecord
): SkillManifest {
  const manifest = readSkillManifest(ctx.skillsManifestPath);
  const previous = previousRecord ?? manifest.skills[source.name];
  manifest.skills[source.name] = {
    source: previous?.source ?? source.sourcePath,
    ref: previous?.ref,
    scope: targetScope,
    target: targetPath,
    installedAt: new Date().toISOString(),
    origin: { source: "dsh-forage", addedAt: new Date().toISOString() }
  };
  writeSkillManifest(ctx.skillsManifestPath, manifest);
  return manifest;
}

export function removeSkillRecord(ctx: ScopeContext, name: string): void {
  const manifest = readSkillManifest(ctx.skillsManifestPath);
  if (manifest.skills[name] === undefined) return;
  delete manifest.skills[name];
  writeSkillManifest(ctx.skillsManifestPath, manifest);
}

export function isDirectory(pathValue: string): boolean {
  try {
    return lstatSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}
