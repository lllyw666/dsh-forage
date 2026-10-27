import type { Candidate, Intent } from "../types.js";

const KNOWN_DOMAINS = new Set(["research", "office", "development", "other"]);
const TERM_ALIASES: Record<string, string[]> = {
  "论文撰写": ["paper writing", "academic writing"],
  "科研绘图": ["scientific plotting", "scientific figure", "visualization"],
  "论文写作": ["paper writing", "academic writing"],
  "论文": ["paper", "research paper"],
  "科研": ["research", "scientific"],
  "撰写": ["writing"],
  "写作": ["writing"],
  "绘图": ["plotting", "figure"],
  "可视化": ["visualization"],
  "文献": ["literature"],
  "引用": ["citation"],
  "检索": ["search"],
  "学术": ["academic"],
  "文档": ["document"],
  "表格": ["spreadsheet"],
  "开发": ["development"],
  "代码": ["code"]
};

const DOMAIN_TERMS: Record<string, string[]> = {
  research: ["research", "academic", "paper", "literature"],
  office: ["office", "document", "spreadsheet", "presentation"],
  development: ["development", "code", "repository"],
  other: ["agent", "tool"]
};

interface GithubRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  default_branch?: string;
  stargazers_count?: number;
  archived?: boolean;
  fork?: boolean;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  homepage?: string | null;
  name?: string;
}

interface GithubContent {
  type?: string;
  name?: string;
  path?: string;
}

export interface GithubDiscoveryOptions {
  token?: string;
  perPage?: number;
  maxRepos?: number;
  maxCandidates?: number;
  maxSkillsPerRepo?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GithubDiscoveryResult {
  candidates: Candidate[];
  queries: string[];
  repos: number;
  warnings: string[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function expandTerm(term: string): string[] {
  const normalized = term.trim();
  if (normalized === "") return [];
  return [normalized, ...(TERM_ALIASES[normalized] ?? [])];
}

/** Turn the structured intent into three focused GitHub repository queries. */
export function deriveGithubQueries(intent: Intent): string[] {
  const raw = unique([...intent.tasks, ...intent.signals].map((term) => term.trim()).filter((term) => term !== ""));
  const expanded = unique(raw.flatMap(expandTerm)).filter((term) => term.length >= 2);
  const domains = intent.domains.filter((domain) => KNOWN_DOMAINS.has(domain));
  const domainTerms = unique(domains.flatMap((domain) => DOMAIN_TERMS[domain] ?? []));
  const focus = (raw.length > 0 ? raw : domainTerms).slice(0, 2);
  const queries: string[] = [];
  for (const term of focus) queries.push(term + " skill");
  if (queries.length < 2) queries.push((expanded[0] ?? "agent") + " skill");
  queries.push((expanded.slice(0, 3).join(" ") || domainTerms[0] || "agent") + " mcp server");
  if (queries.length < 3) queries.push((expanded.slice(2, 5).join(" ") || domainTerms[0] || "agent") + " skill");
  return unique(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter((query) => query !== "")).slice(0, 3);
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result === "" ? "item" : result;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

function candidateId(prefix: string, name: string): string {
  const base = "gh-" + slug(prefix) + "-" + slug(name);
  if (base.length <= 64) return base;
  return "gh-" + hash(prefix + ":" + name) + "-" + slug(name).slice(0, 24);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function starWeight(stars: number): number {
  return Math.max(0.2, Math.min(0.85, 0.2 + Math.log10(stars + 1) / 12));
}

const OFFICIAL_OWNERS = new Set([
  "deepseek-ai", "anthropics", "modelcontextprotocol", "openai", "microsoft",
  "google", "google-deepmind", "vercel", "vercel-labs", "github", "aws",
  "cloudflare", "langchain-ai", "huggingface", "meta-llama", "facebook", "pytorch"
]);

/**
 * Static source trust for a GitHub repo. Official orgs rank above community
 * repos; within community repos, stars act as adoption evidence. The ranker
 * multiplies this by a normalized log-star score, so 100k stars cannot
 * overwhelm task relevance.
 */
function sourcePriorityFor(fullName: string, stars: number): number {
  const owner = fullName.split("/")[0]?.toLowerCase() ?? "";
  if (OFFICIAL_OWNERS.has(owner)) return 0.95;
  if (stars >= 50_000) return 0.9;
  if (stars >= 10_000) return 0.8;
  if (stars >= 1_000) return 0.65;
  if (stars >= 100) return 0.5;
  if (stars >= 10) return 0.4;
  return 0.3;
}

function skillFrontmatter(text: string, fallback: string): { name: string; description: string } {
  let name = fallback;
  let description = "";
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      for (const line of text.slice(3, end).split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (match === null) continue;
        const key = match[1];
        const raw = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
        if (key === "name" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(raw)) name = raw;
        if (key === "description" && raw !== "") description = raw;
      }
    }
  }
  return { name, description };
}

function relevance(text: string, intent: Intent): number {
  const haystack = text.toLowerCase();
  const terms = unique([...intent.tasks, ...intent.signals].flatMap(expandTerm)).map((term) => term.toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (term.length >= 2 && haystack.includes(term)) score += term.length;
  }
  return score;
}

function taskTerms(task: string): string[] {
  if (/科研绘图|绘图|可视化/.test(task)) return [task, "科研绘图", "绘图", "figure", "plot", "visual", "schematic"];
  if (/论文撰写|论文写作|撰写|写作/.test(task)) return [task, "论文撰写", "论文写作", "撰写", "写作", "writing", "draft"];
  if (/文献检索|文献/.test(task)) return [task, "文献检索", "literature", "paper search", "search"];
  if (/PDF解析|pdf/i.test(task)) return [task, "pdf", "extract", "reader"];
  return [task];
}

function matchedTaskTerms(text: string, intent: Intent): string[] {
  const haystack = text.toLowerCase();
  return intent.tasks.filter((task) => taskTerms(task).some((term) => term.length >= 2 && haystack.includes(term.toLowerCase())));
}

/**
 * A GitHub skill's task is determined by its name, not by incidental words in
 * the README/body. This prevents a manuscript skill that mentions "figures"
 * from being presented as a scientific-plotting skill.
 */
function matchedTaskFromName(name: string, intent: Intent): string[] {
  return matchedTaskTerms(name, intent);
}

function taskAffinity(text: string, intent: Intent): number {
  const haystack = text.toLowerCase();
  let score = 0;
  const wantsPlot = intent.tasks.some((task) => /绘图|绘图|可视化|plot|figure/i.test(task));
  const wantsWriting = intent.tasks.some((task) => /撰写|写作|writing|manuscript/i.test(task));
  if (wantsPlot && /figure|plot|visual|chart|diagram/.test(haystack)) score += 50;
  if (wantsWriting && /writ|manuscript|polish|editing/.test(haystack)) score += 50;
  return score;
}

export class GithubDiscoveryError extends Error {
  override name = "GithubDiscoveryError";
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GitHub request timed out")), timeoutMs);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "dsh-forage-github-discovery",
    "x-github-api-version": "2022-11-28"
  };
  if (token !== undefined && token !== "") headers.authorization = "Bearer " + token;
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  timeoutMs: number
): Promise<T> {
  const response = await request(fetchImpl, url, token, timeoutMs);
  if (!response.ok) {
    throw new GithubDiscoveryError("GitHub " + String(response.status) + " " + response.statusText);
  }
  return await response.json() as T;
}

async function requestText(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  timeoutMs: number
): Promise<string | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(fetchImpl, url, token, timeoutMs);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new GithubDiscoveryError("GitHub raw " + String(response.status) + " " + response.statusText);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new GithubDiscoveryError(String(lastError));
}

async function inspectRepo(
  repo: GithubRepo,
  query: string,
  intent: Intent,
  options: GithubDiscoveryOptions,
  fetchImpl: typeof fetch,
  warnings: string[]
): Promise<Candidate[]> {
  const fullName = repo.full_name;
  const htmlUrl = repo.html_url;
  if (typeof fullName !== "string" || typeof htmlUrl !== "string") return [];
  const branch = typeof repo.default_branch === "string" && repo.default_branch !== "" ? repo.default_branch : "main";
  const description = cleanText(repo.description, 600);
  const stars = Number.isInteger(repo.stargazers_count) ? Number(repo.stargazers_count) : 0;
  const sourcePriority = sourcePriorityFor(fullName, stars);
  const timeoutMs = options.timeoutMs ?? 6000;
  const token = options.token;
  const domains = unique(intent.domains.filter((domain) => KNOWN_DOMAINS.has(domain)));
  if (domains.length === 0) domains.push("other");
  const tasks = intent.tasks.length > 0 ? intent.tasks : ["通用能力"];
  const rawBase = "https://raw.githubusercontent.com/" + fullName + "/" + branch;
  const text = (repo.name ?? "") + " " + description + " " + (repo.topics ?? []).join(" ");
  const skillLike = /skill|agent|claude|codex|workflow/i.test(text);
  const mcpLike = /mcp|model context protocol|server/i.test(text);
  const candidates: Candidate[] = [];

  if (skillLike) {
    let contents: GithubContent[] | undefined;
    try {
      contents = await requestJson<GithubContent[] | undefined>(
        fetchImpl,
        "https://api.github.com/repos/" + fullName + "/contents/skills?ref=" + encodeURIComponent(branch),
        token,
        timeoutMs
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!/404/.test(message)) {
        warnings.push("GitHub contents 检查失败（" + fullName + "）：" + message + "；设置 GITHUB_TOKEN 可提高限额。");
      }
    }
    let entries: GithubContent[] = Array.isArray(contents)
      ? contents.filter((entry) => entry.type === "dir" && typeof entry.name === "string")
      : [];
    if (entries.length === 0) {
      // The GitHub contents API is core-rate-limited. The README usually lists
      // skills/<name> paths, which lets raw.githubusercontent.com do the work.
      const readme = await requestText(fetchImpl, rawBase + "/README.md", token, timeoutMs).catch(() => undefined);
      if (readme !== undefined) {
        const names = new Set<string>();
        for (const match of readme.matchAll(/skills\/([a-z0-9][a-z0-9-]{1,63})/g)) {
          if (match[1] !== undefined) names.add(match[1]);
        }
        for (const name of names) entries.push({ type: "dir", name, path: "skills/" + name });
        if (names.size > 0) warnings.push("GitHub contents API 未返回目录，已用 README 的 skills/* 路径回退（" + fullName + "）。");
      }
    }
    const skillEntries = entries
      .sort((left, right) => (relevance(String(right.name), intent) + taskAffinity(String(right.name), intent)) - (relevance(String(left.name), intent) + taskAffinity(String(left.name), intent)))
      .slice(0, 8);
    const rootSkill = await requestText(fetchImpl, rawBase + "/SKILL.md", token, timeoutMs).catch(() => undefined);
    if (rootSkill !== undefined) {
      skillEntries.unshift({ type: "file", name: "SKILL.md", path: "SKILL.md" });
    }
    const found: Array<{ dir: string; name: string; description: string; text: string; score: number }> = [];
    for (const entry of skillEntries) {
      const dir = entry.type === "file" ? "root" : entry.name as string;
      const path = entry.type === "file" ? "SKILL.md" : "skills/" + dir + "/SKILL.md";
      const body = entry.type === "file" ? rootSkill : await requestText(fetchImpl, rawBase + "/" + path, token, timeoutMs).catch(() => undefined);
      if (body === undefined) continue;
      const meta = skillFrontmatter(body, dir === "root" ? (repo.name ?? "skill") : dir);
      const textForScore = dir + " " + meta.name + " " + meta.description + " " + body.slice(0, 3000);
      const score = relevance(textForScore, intent) + taskAffinity(textForScore, intent) * 2;
      found.push({ dir, name: meta.name, description: meta.description, text: body, score });
    }
    found.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    const relevant = found.filter((item) => item.score > 0);
    const limit = Math.max(1, Math.min(10, options.maxSkillsPerRepo ?? 8));
    for (const item of (relevant.length > 0 ? relevant : found).slice(0, limit)) {
      const id = candidateId(fullName, item.name);
      const sourcePath = item.dir === "root" ? "" : "#skills/" + item.dir;
      const rawInstallName = /^[a-z0-9][a-z0-9-]{1,63}$/.test(item.name) ? item.name : slug(item.name).slice(0, 64);
      const installName = rawInstallName.length >= 2 ? rawInstallName : "github-skill";
      const candidateTasks = matchedTaskFromName(item.name, intent);
      const sourceWithRef = sourcePath === "" ? "github:" + fullName + "@" + branch : "github:" + fullName + sourcePath + "@" + branch;
      candidates.push({
        id,
        type: "skill",
        name: item.name,
        description: cleanText(item.description, 600) || cleanText(description, 600) || "GitHub Skill",
        domains,
        tasks: candidateTasks,
        tools: [],
        risk: { level: "high", writes: true, external_requests: true, sensitive_permissions: true },
        credentials: [],
        requires: [{ kind: "manual-setup", label: "GitHub 未验证 Skill", hint: "先阅读仓库的 SKILL.md、许可证和脚本，再决定是否安装。" }],
        install: { method: "dsh-install", kind: "skill", source: sourceWithRef, name: installName },
        group: "github-" + slug(fullName),
        weight: starWeight(stars),
        homepage: htmlUrl,
        sourceRepo: htmlUrl,
        ...(repo.license?.spdx_id !== undefined && repo.license.spdx_id !== null && repo.license.spdx_id !== "NOASSERTION" ? { license: repo.license.spdx_id } : {}),
        verifiedAt: today(),
        notes: ["GitHub discovery; unverified", "query: " + query, "stars: " + String(stars)],
        discovery: { source: "github", repo: fullName, url: htmlUrl, stars, sourcePriority, query, verified: false }
      });
    }
  }

  if (candidates.length === 0 && mcpLike) {
    const raw = await requestText(fetchImpl, rawBase + "/package.json", token, timeoutMs).catch(() => undefined);
    if (raw !== undefined) {
      let pkg: Record<string, unknown> | undefined;
      try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        pkg = undefined;
      }
      const packageName = typeof pkg?.name === "string" ? pkg.name : "";
      if (packageName !== "") {
        const id = candidateId(fullName, "mcp");
        candidates.push({
          id,
          type: "mcp",
          name: cleanText(typeof pkg?.description === "string" ? pkg.description : repo.name, 100) || "GitHub MCP",
          description: cleanText(typeof pkg?.description === "string" ? pkg.description : description, 600) || "GitHub MCP server",
          domains,
          tasks,
          tools: [],
          toolCount: 0,
          risk: { level: "high", writes: true, external_requests: true, sensitive_permissions: true },
          credentials: [],
          requires: [{ kind: "runtime", label: "Node.js 20+", hint: "inferred npx command; verify the package bin and required args." }],
          install: { method: "dsh-install", kind: "mcp", server: id, transport: "stdio", command: "npx", args: ["-y", packageName], env: [], timeoutMs: 120000 },
          group: "github-" + slug(fullName),
          weight: starWeight(stars),
          homepage: htmlUrl,
          sourceRepo: htmlUrl,
          packageVersion: typeof pkg?.version === "string" ? pkg.version : undefined,
          ...(repo.license?.spdx_id !== undefined && repo.license.spdx_id !== null && repo.license.spdx_id !== "NOASSERTION" ? { license: repo.license.spdx_id } : {}),
          verifiedAt: today(),
          notes: ["GitHub discovery; install command inferred from package.json", "query: " + query, "stars: " + String(stars)],
          discovery: { source: "github", repo: fullName, url: htmlUrl, stars, sourcePriority, query, verified: false }
        });
      }
    }
  }
  return candidates;
}

/**
 * Search GitHub repositories derived from the intent and inspect only the most
 * relevant skill/MCP candidates. Results are intentionally high-risk and
 * unverified; the caller must not default-select them.
 */
export async function discoverGithub(
  intent: Intent,
  options: GithubDiscoveryOptions = {}
): Promise<GithubDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const queries = deriveGithubQueries(intent);
  const perPage = Math.max(1, Math.min(10, options.perPage ?? 5));
  const maxRepos = Math.max(1, Math.min(6, options.maxRepos ?? 3));
  const maxCandidates = Math.max(1, Math.min(12, options.maxCandidates ?? 6));
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 3500);
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  const seenRepos = new Set<string>();
  let repos = 0;

  for (const query of queries) {
    if (candidates.length >= maxCandidates || repos >= maxRepos) break;
    let items: GithubRepo[] = [];
    try {
      const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(query + " archived:false fork:false") + "&sort=stars&order=desc&per_page=" + String(perPage);
      const payload = await requestJson<{ items?: GithubRepo[] }>(fetchImpl, url, options.token, timeoutMs);
      items = Array.isArray(payload.items) ? payload.items : [];
    } catch (error) {
      warnings.push("GitHub 搜索失败（" + query + "）：" + String(error instanceof Error ? error.message : error));
      continue;
    }
    for (const repo of items.slice(0, 2)) {
      if (candidates.length >= maxCandidates || repos >= maxRepos) break;
      if (repo.archived === true || repo.fork === true || typeof repo.full_name !== "string") continue;
      if (seenRepos.has(repo.full_name)) continue;
      seenRepos.add(repo.full_name);
      repos += 1;
      try {
        const found = await inspectRepo(repo, query, intent, options, fetchImpl, warnings);
        for (const candidate of found) {
          if (seenIds.has(candidate.id)) continue;
          seenIds.add(candidate.id);
          candidates.push(candidate);
          if (candidates.length >= maxCandidates) break;
        }
      } catch (error) {
        warnings.push("GitHub 仓库检查失败（" + repo.full_name + "）：" + String(error instanceof Error ? error.message : error));
      }
    }
    if (candidates.length > 0) break;
  }

  return { candidates, queries, repos, warnings };
}
