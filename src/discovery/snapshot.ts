import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Candidate } from "../types.js";
import type { ScopeContext } from "../scopes/types.js";

export interface DiscoverySnapshot {
  schemaVersion: 1;
  createdAt: string;
  queries: string[];
  warnings: string[];
  candidates: Candidate[];
}

export function discoverySnapshotPath(ctx: ScopeContext): string {
  return path.join(ctx.dshHome, "forage", "discovered.json");
}

export function writeDiscoverySnapshot(ctx: ScopeContext, snapshot: DiscoverySnapshot): string {
  const file = discoverySnapshotPath(ctx);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid + "-" + Date.now();
  try {
    writeFileSync(temp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return file;
}

export function readDiscoverySnapshot(ctx: ScopeContext): DiscoverySnapshot | undefined {
  const file = discoverySnapshotPath(ctx);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DiscoverySnapshot>;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) return undefined;
    const candidates = parsed.candidates.filter((candidate): candidate is Candidate => {
      return candidate !== null && typeof candidate === "object"
        && typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && candidate.install !== null && typeof candidate.install === "object";
    });
    return {
      schemaVersion: 1,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      queries: Array.isArray(parsed.queries) ? parsed.queries.filter((query): query is string => typeof query === "string") : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((warning): warning is string => typeof warning === "string") : [],
      candidates
    };
  } catch {
    return undefined;
  }
}
