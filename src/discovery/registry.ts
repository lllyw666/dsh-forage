import type { Candidate, Intent, McpInstallSpec, Requirement } from "../types.js";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";

const TASK_QUERIES: Record<string, string[]> = {
  "文献检索": ["literature search", "paper search"],
  "论文撰写": ["paper writing", "academic writing"],
  "论文写作": ["paper writing", "academic writing"],
  "科研绘图": ["scientific figure", "scientific plotting"],
  "引用整理": ["citation manager", "reference manager"],
  "PDF解析": ["pdf", "pdf extract"],
  "本地文献库": ["zotero", "reference library"],
  "文档读写": ["document editor", "docx"],
  "表格处理": ["spreadsheet", "excel"],
  "演示制作": ["presentation", "pptx"],
  "格式转换": ["file conversion", "document conversion"],
  "学术元数据": ["academic metadata", "scholarly metadata"]
};

const DOMAIN_QUERIES: Record<string, string[]> = {
  research: ["research", "academic"],
  office: ["office", "document"],
  development: ["developer", "code"],
  other: ["productivity"]
};

const QUERY_TO_TASK = new Map<string, string>();
for (const [task, queries] of Object.entries(TASK_QUERIES)) {
  QUERY_TO_TASK.set(task.toLowerCase(), task);
  for (const query of queries) QUERY_TO_TASK.set(query.toLowerCase(), task);
}

export interface RegistryDiscoveryResult {
  candidates: Candidate[];
  queries: string[];
  warnings: string[];
}

export interface RegistryDiscoveryOptions {
  limit?: number;
  timeoutMs?: number;
  maxQueries?: number;
  queries?: string[];
  verifyPackages?: boolean;
  fetchImpl?: typeof fetch;
}

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  runtimeArguments?: Array<{ type?: string; value?: string; valueHint?: string }>;
  packageArguments?: Array<{ type?: string; value?: string; isRequired?: boolean }>;
  transport?: { type?: string };
  environmentVariables?: Array<{ name?: string; isRequired?: boolean; isSecret?: boolean; description?: string }>;
}

interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: RegistryPackage[];
  remotes?: Array<{ type?: string; transport_type?: string; url?: string }>;
}

interface RegistryEntry {
  server?: RegistryServer;
  _meta?: Record<string, { isLatest?: boolean; status?: string }>;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function deriveDiscoveryQueries(intent: Intent): string[] {
  const queries: string[] = [];
  for (const task of intent.tasks) {
    const key = task.trim();
    const translated = TASK_QUERIES[key] ?? [];
    for (const query of translated) queries.push(query);
    if (translated.length === 0) queries.push(key);
  }
  if (intent.tasks.length === 0) {
    for (const domain of intent.domains) {
      for (const translated of DOMAIN_QUERIES[domain] ?? []) queries.push(translated);
    }
  }
  for (const signal of intent.signals) {
    if (/^[a-z0-9][a-z0-9 .+#-]{2,}$/i.test(signal)) queries.push(signal);
  }
  return unique(queries).slice(0, 8);
}

function isLatest(entry: RegistryEntry): boolean {
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  return meta?.isLatest !== false && meta?.status !== "deleted" && meta?.status !== "deprecated";
}

function registryId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ("registry-" + base).slice(0, 60).replace(/-+$/g, "");
}

function latestServerEntries(entries: RegistryEntry[], query: string): Array<{ server: RegistryServer; query: string }> {
  const byName = new Map<string, { server: RegistryServer; query: string; latest: boolean }>();
  for (const entry of entries) {
    if (entry.server === undefined) continue;
    const server = entry.server;
    const name = server.name?.trim() ?? "";
    if (name === "") continue;
    const latest = isLatest(entry);
    const existing = byName.get(name);
    if (existing === undefined || (latest && !existing.latest)) {
      byName.set(name, { server, query, latest });
    }
  }
  return [...byName.values()].map((entry) => ({ server: entry.server, query: entry.query }));
}

function installFor(server: RegistryServer): { spec: McpInstallSpec; requires: Requirement[]; credentials: string[] } | null {
  const serverId = registryId(server.name ?? server.title ?? "mcp");
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find((entry) => entry.registryType === "npm" && typeof entry.identifier === "string" && entry.identifier !== "");
  if (npm !== undefined) {
    const identifier = npm.identifier as string;
    const version = typeof npm.version === "string" && npm.version !== "" ? npm.version : undefined;
    const env = Array.isArray(npm.environmentVariables)
      ? npm.environmentVariables.map((entry) => entry.name).filter((name): name is string => typeof name === "string" && name !== "")
      : [];
    const requiredEnv = Array.isArray(npm.environmentVariables)
      ? npm.environmentVariables.filter((entry) => entry.isRequired).map((entry) => entry.name).filter((name): name is string => typeof name === "string" && name !== "")
      : [];
    const runtimeArgs = Array.isArray(npm.runtimeArguments)
      ? npm.runtimeArguments.map((entry) => entry.value).filter((value): value is string => typeof value === "string" && value !== "")
      : [];
    const packageArgs = Array.isArray(npm.packageArguments) ? npm.packageArguments.filter((entry) => entry.isRequired) : [];
    if (packageArgs.length > 0) return null;
    const args = [...runtimeArgs, version === undefined ? identifier : identifier + "@" + version];
    const requires: Requirement[] = [{ kind: "runtime", label: "Node.js 20+", hint: "通过 npx 启动；首次运行会下载依赖。" }];
    if (requiredEnv.length > 0) {
      requires.push({ kind: "manual-setup", label: "环境变量：" + requiredEnv.join(", "), hint: "安装前需要配置；否则 MCP 会启动失败。" });
    }
    return {
      spec: {
        method: "dsh-install",
        kind: "mcp",
        server: serverId,
        transport: "stdio",
        command: npm.runtimeHint ?? "npx",
        args,
        env: env.map((name) => " + name + "),
        timeoutMs: 180000
      },
      requires,
      credentials: requiredEnv
    };
  }

  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const remote = remotes.find((entry) => {
    const type = entry.type ?? entry.transport_type ?? "";
    return (type === "streamable-http" || type === "http" || type === "sse") && typeof entry.url === "string" && entry.url !== "";
  });
  if (remote !== undefined) {
    const transport = (remote.type ?? remote.transport_type) === "sse" ? "stdio" : "http";
    if (transport !== "http") return null;
    return {
      spec: {
        method: "dsh-install",
        kind: "mcp",
        server: serverId,
        transport: "http",
        url: remote.url as string,
        timeoutMs: 120000
      },
      requires: [{ kind: "network", label: "远程 MCP", hint: "数据会发送到第三方托管服务。" }],
      credentials: []
    };
  }
  return null;
}

export function candidateFromRegistry(server: RegistryServer, intent: Intent, query: string): Candidate | null {
  const name = server.title?.trim() || server.name?.trim() || "";
  const install = installFor(server);
  if (name === "" || install === null) return null;
  const remote = install.spec.transport === "http";
  const envNames = install.spec.env?.map((entry) => entry.replace(/^\$\{/, "").replace(/\}$/, "")) ?? [];
  return {
    id: registryId(server.name ?? name),
    type: "mcp",
    name,
    description: server.description?.trim() || "MCP Registry server",
    domains: intent.domains.length > 0 ? [intent.domains[0] as string] : ["other"],
    tasks: (() => {
      const task = QUERY_TO_TASK.get(query.toLowerCase());
      if (task === undefined) return [];
      const description = (server.description ?? "").toLowerCase();
      const terms = [task, ...(TASK_QUERIES[task] ?? []), query].map((term) => term.toLowerCase()).filter((term) => term.length >= 2);
      return terms.some((term) => description.includes(term)) ? [task] : [];
    })(),
    tools: [],
    risk: {
      level: "high",
      writes: false,
      external_requests: true,
      sensitive_permissions: false
    },
    credentials: install.credentials.filter((entry) => entry !== ""),
    requires: install.requires,
    install: install.spec,
    group: "discovered",
    weight: 0.5,
    homepage: server.websiteUrl ?? server.repository?.url,
    sourceRepo: server.repository?.url,
    packageVersion: server.version,
    notes: [
      "来自 MCP Registry，未做安全审计；安装前检查仓库、许可证和权限。",
      ...(envNames.length > 0 ? ["环境变量：" + envNames.join(", ")] : [])
    ],
    discovery: {
      source: "registry",
      ...(server.repository?.url === undefined ? {} : { repo: server.repository.url }),
      url: server.websiteUrl ?? server.repository?.url ?? "https://registry.modelcontextprotocol.io",
      stars: 0,
      quality: remote ? 0.62 : 0.7,
      sourcePriority: 0.9,
      query,
      verified: false
    }
  };
}

async function searchOnce(query: string, options: RegistryDiscoveryOptions): Promise<{ entries: RegistryEntry[]; warning?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3500);
  try {
    const url = REGISTRY_BASE + "/servers?search=" + encodeURIComponent(query) + "&limit=" + String(options.limit ?? 10);
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "dsh-forage/0.2" }
    });
    if (!response.ok) return { entries: [], warning: "MCP Registry 搜索失败：" + query + "（HTTP " + String(response.status) + "）" };
    const body = await response.json() as { servers?: RegistryEntry[] };
    return { entries: Array.isArray(body.servers) ? body.servers : [] };
  } catch (error) {
    return { entries: [], warning: "MCP Registry 搜索失败：" + query + "（" + String(error) + "）" };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyNpmPackage(candidate: Candidate, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean | undefined> {
  if (candidate.install.method !== "dsh-install" || candidate.install.kind !== "mcp" || candidate.install.transport !== "stdio") return undefined;
  const args = candidate.install.args ?? [];
  const spec = args[args.length - 1];
  if (spec === undefined) return undefined;
  const split = spec.lastIndexOf("@");
  if (split <= 0 || split === spec.length - 1) return undefined;
  const packageName = spec.slice(0, split);
  const version = spec.slice(split + 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://registry.npmjs.org/" + encodeURIComponent(packageName) + "/" + encodeURIComponent(version), { signal: controller.signal });
    return response.ok;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverRegistry(intent: Intent, options: RegistryDiscoveryOptions = {}): Promise<RegistryDiscoveryResult> {
  const queries = (options.queries ?? deriveDiscoveryQueries(intent)).slice(0, options.maxQueries ?? 6);
  const candidates = new Map<string, Candidate>();
  const warnings: string[] = [];
  for (const query of queries) {
    const result = await searchOnce(query, options);
    if (result.warning !== undefined) warnings.push(result.warning);
    for (const entry of latestServerEntries(result.entries, query)) {
      const candidate = candidateFromRegistry(entry.server, intent, query);
      if (candidate === null) continue;
      if (candidate.tasks.length === 0 && QUERY_TO_TASK.has(query.toLowerCase())) continue;
      const existing = candidates.get(candidate.id);
      if (existing === undefined) {
        candidates.set(candidate.id, candidate);
      } else if ((candidate.packageVersion ?? "") > (existing.packageVersion ?? "")) {
        candidates.set(candidate.id, candidate);
      }
    }
  }
  let output = [...candidates.values()];
  if (options.verifyPackages !== false) {
    const checked: Candidate[] = [];
    for (const candidate of output) {
      const verified = await verifyNpmPackage(candidate, options.fetchImpl ?? fetch, 2000);
      if (verified === false) {
        warnings.push("npm 包不存在，已丢弃 Registry 候选：" + candidate.name);
        continue;
      }
      if (verified === true && candidate.discovery !== undefined) {
        candidate.discovery = { ...candidate.discovery, packageVerified: true, quality: Math.min(0.85, (candidate.discovery.quality ?? 0.6) + 0.05) };
      }
      checked.push(candidate);
    }
    output = checked;
  }
  if (output.length > 0) warnings.push("MCP Registry 仍为 preview；候选可能不完整，已交叉检查 npm 并同时查询 GitHub。");
  return { candidates: output, queries, warnings: unique(warnings) };
}
