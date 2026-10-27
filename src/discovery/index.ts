import type { Candidate, Intent } from "../types.js";
import { discoverGithub } from "./github.js";
import { discoverRegistry, type RegistryDiscoveryOptions } from "./registry.js";

export interface DiscoveryOptions extends RegistryDiscoveryOptions {
  githubToken?: string;
  githubRepos?: number;
  githubCandidates?: number;
  githubTimeoutMs?: number;
  includeGithub?: boolean;
}

export interface DiscoveryResult {
  candidates: Candidate[];
  queries: string[];
  warnings: string[];
}

function repoKey(candidate: Candidate): string | undefined {
  const value = candidate.discovery?.repo ?? candidate.sourceRepo;
  if (value === undefined) return undefined;
  return value.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const perRepo = new Map<string, number>();
  const taskRepos = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.type === "skill" && candidate.tasks.length > 0) {
      const value = repoKey(candidate);
      if (value !== undefined) taskRepos.add(value);
    }
  }
  const output: Candidate[] = [];
  for (const candidate of candidates) {
    const repo = repoKey(candidate);
    if (candidate.type === "skill" && repo !== undefined && candidate.tasks.length === 0 && taskRepos.has(repo)) continue;
    const installKey = candidate.install.method === "builtin" ? "builtin" : candidate.install.kind;
    const key = candidate.type === "skill"
      ? "skill:" + candidate.id
      : repo === undefined
        ? installKey + ":" + candidate.name.toLowerCase()
        : "repo:" + repo;
    if (seen.has(key)) continue;
    if (candidate.type === "skill" && repo !== undefined) {
      const count = perRepo.get(repo) ?? 0;
      if (count >= 2) continue;
      perRepo.set(repo, count + 1);
    }
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

export async function discoverCapabilities(intent: Intent, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const registryPromise = discoverRegistry(intent, options).catch((error) => ({
    candidates: [],
    queries: [],
    warnings: ["MCP Registry 发现失败：" + String(error)]
  }));
  const githubPromise = options.includeGithub === false
    ? Promise.resolve({ candidates: [], queries: [], warnings: [] })
    : discoverGithub(intent, {
      token: options.githubToken,
      maxRepos: options.githubRepos ?? 3,
      maxCandidates: options.githubCandidates ?? 6,
      timeoutMs: options.githubTimeoutMs ?? 3500
    }).catch((error) => ({
      candidates: [],
      queries: [],
      warnings: ["GitHub 发现失败：" + String(error)]
    }));

  const [registry, github] = await Promise.all([registryPromise, githubPromise]);
  const candidates = dedupe([...registry.candidates, ...github.candidates]).slice(0, 18);
  return {
    candidates,
    queries: [...new Set([...registry.queries, ...github.queries])],
    warnings: [...new Set([...registry.warnings, ...github.warnings])]
  };
}
