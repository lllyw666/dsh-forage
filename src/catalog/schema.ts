import type {
  BuiltinInstallSpec,
  Candidate,
  CatalogFile,
  InstallSpec,
  McpInstallSpec,
  Requirement,
  Risk,
  SkillInstallSpec
} from "../types.js";

export class CatalogError extends Error {
  readonly file?: string;

  constructor(message: string, file?: string) {
    super(file === undefined ? message : `${file}: ${message}`);
    this.name = "CatalogError";
    this.file = file;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REQUIREMENT_KINDS = new Set(["desktop-app", "runtime", "network", "manual-setup"]);
const DOMAIN_IDS = new Set(["research", "office", "development", "other"]);

function fail(file: string, path: string, message: string): never {
  throw new CatalogError(`${path}: ${message}`, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, file: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(file, path, "必须是对象");
  return value;
}

function text(value: unknown, file: string, path: string, maxLength = 2000): string {
  if (typeof value !== "string") fail(file, path, "必须是字符串");
  const trimmed = value.trim();
  if (trimmed === "") fail(file, path, "不能为空");
  if (trimmed.length > maxLength) fail(file, path, `过长（上限 ${maxLength} 字符）`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
    fail(file, path, "不能包含控制字符");
  }
  return trimmed;
}

function optionalText(value: unknown, file: string, path: string, maxLength = 2000): string | undefined {
  if (value === undefined) return undefined;
  return text(value, file, path, maxLength);
}

function bool(value: unknown, file: string, path: string): boolean {
  if (typeof value !== "boolean") fail(file, path, "必须是布尔值");
  return value;
}

function integer(value: unknown, file: string, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(file, path, `必须是 ${min}..${max} 的整数`);
  }
  return value;
}

function stringArray(
  value: unknown,
  file: string,
  path: string,
  options: { allowEmpty?: boolean; maxItems?: number; maxLength?: number } = {}
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(file, path, "必须是字符串数组");
  if (options.allowEmpty === false && value.length === 0) fail(file, path, "不能为空");
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    fail(file, path, `最多 ${options.maxItems} 项`);
  }
  const result = value.map((item, index) => text(item, file, `${path}[${index}]`, options.maxLength ?? 500));
  return [...new Set(result)];
}

function installKind(type: Candidate["type"], install: InstallSpec, file: string, path: string): void {
  if (type === "builtin" && install.method !== "builtin") fail(file, path, "builtin 类型必须使用 builtin 安装方式");
  if (type === "mcp" && !(install.method === "dsh-install" && install.kind === "mcp")) {
    fail(file, path, "mcp 类型必须使用 mcp 安装方式");
  }
  if (type === "skill" && !(install.method === "dsh-install" && install.kind === "skill")) {
    fail(file, path, "skill 类型必须使用 skill 安装方式");
  }
}

function parseRisk(value: unknown, file: string, path: string): Risk {
  const raw = record(value, file, path);
  const level = text(raw.level, file, `${path}.level`, 10);
  if (level !== "low" && level !== "medium" && level !== "high") {
    fail(file, `${path}.level`, "必须是 low、medium 或 high");
  }
  return {
    level,
    writes: bool(raw.writes, file, `${path}.writes`),
    external_requests: bool(raw.external_requests, file, `${path}.external_requests`),
    sensitive_permissions: bool(raw.sensitive_permissions, file, `${path}.sensitive_permissions`)
  };
}

function parseRequirements(value: unknown, file: string, path: string): Requirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(file, path, "必须是数组");
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const raw = record(item, file, itemPath);
    const kind = text(raw.kind, file, `${itemPath}.kind`, 32);
    if (!REQUIREMENT_KINDS.has(kind)) fail(file, `${itemPath}.kind`, "未知的前置条件类型");
    return {
      kind: kind as Requirement["kind"],
      label: text(raw.label, file, `${itemPath}.label`, 200),
      hint: optionalText(raw.hint, file, `${itemPath}.hint`, 500)
    };
  });
}

function parseInstall(value: unknown, file: string, path: string): InstallSpec {
  const raw = record(value, file, path);
  const method = text(raw.method, file, `${path}.method`, 32);
  if (method === "builtin") {
    const provides = stringArray(raw.provides, file, `${path}.provides`, {
      allowEmpty: false,
      maxItems: 40,
      maxLength: 100
    });
    const spec: BuiltinInstallSpec = { method: "builtin", provides };
    return spec;
  }
  if (method !== "dsh-install") fail(file, `${path}.method`, "只支持 dsh-install 或 builtin");
  const kind = text(raw.kind, file, `${path}.kind`, 16);
  if (kind === "skill") {
    const source = text(raw.source, file, `${path}.source`, 1000);
    if (/[\r\n]/.test(source)) fail(file, `${path}.source`, "不能包含换行");
    const spec: SkillInstallSpec = {
      method: "dsh-install",
      kind: "skill",
      source,
      name: optionalText(raw.name, file, `${path}.name`, 80),
      link: raw.link === undefined ? undefined : bool(raw.link, file, `${path}.link`)
    };
    if (spec.name !== undefined && !ID_PATTERN.test(spec.name)) {
      fail(file, `${path}.name`, "必须是 kebab-case 名称");
    }
    return spec;
  }
  if (kind !== "mcp") fail(file, `${path}.kind`, "必须是 mcp 或 skill");

  const server = text(raw.server, file, `${path}.server`, 64);
  if (!ID_PATTERN.test(server)) fail(file, `${path}.server`, "必须是 kebab-case 名称");
  const transport = raw.transport === undefined ? "stdio" : text(raw.transport, file, `${path}.transport`, 8);
  if (transport !== "stdio" && transport !== "http") fail(file, `${path}.transport`, "必须是 stdio 或 http");
  const env = stringArray(raw.env, file, `${path}.env`, { maxItems: 20, maxLength: 100 });
  for (const [index, key] of env.entries()) {
    if (!ENV_PATTERN.test(key)) fail(file, `${path}.env[${index}]`, "必须是环境变量名（大写字母、数字、下划线）");
  }
  const cwd = optionalText(raw.cwd, file, `${path}.cwd`, 1000);
  const timeoutMs = raw.timeoutMs === undefined
    ? undefined
    : integer(raw.timeoutMs, file, `${path}.timeoutMs`, 1000, 3_600_000);
  if (transport === "http") {
    if (raw.command !== undefined) fail(file, `${path}.command`, "HTTP 传输不能设置 command");
    const url = text(raw.url, file, `${path}.url`, 2000);
    if (!/^https?:\/\//i.test(url)) fail(file, `${path}.url`, "必须是 http(s) URL");
    const headers = stringArray(raw.headers, file, `${path}.headers`, { maxItems: 20, maxLength: 1000 });
    for (const [index, header] of headers.entries()) {
      if (/[\r\n]/.test(header)) fail(file, `${path}.headers[${index}]`, "不能包含换行");
    }
    const spec: McpInstallSpec = {
      method: "dsh-install",
      kind: "mcp",
      server,
      transport,
      url,
      headers,
      env,
      cwd,
      timeoutMs
    };
    return spec;
  }

  const command = text(raw.command, file, `${path}.command`, 500);
  if (/[\r\n]/.test(command)) fail(file, `${path}.command`, "不能包含换行");
  const args = stringArray(raw.args, file, `${path}.args`, { maxItems: 60, maxLength: 1000 });
  for (const [index, arg] of args.entries()) {
    if (/[\u0000\r\n]/.test(arg)) fail(file, `${path}.args[${index}]`, "不能包含换行或 NUL");
  }
  if (raw.url !== undefined) fail(file, `${path}.url`, "stdio 传输不能设置 url");
  const spec: McpInstallSpec = {
    method: "dsh-install",
    kind: "mcp",
    server,
    transport,
    command,
    args,
    env,
    cwd,
    timeoutMs
  };
  return spec;
}

function parseCandidate(value: unknown, file: string, path: string, catalogDomain: string): Candidate {
  const raw = record(value, file, path);
  const id = text(raw.id, file, `${path}.id`, 64);
  if (!ID_PATTERN.test(id)) fail(file, `${path}.id`, "必须是 2-64 位 kebab-case 名称");
  const type = text(raw.type, file, `${path}.type`, 16);
  if (type !== "mcp" && type !== "skill" && type !== "builtin") {
    fail(file, `${path}.type`, "必须是 mcp、skill 或 builtin");
  }
  const domains = stringArray(raw.domains, file, `${path}.domains`, {
    allowEmpty: false,
    maxItems: 6,
    maxLength: 32
  });
  for (const [index, domain] of domains.entries()) {
    if (!DOMAIN_IDS.has(domain)) fail(file, `${path}.domains[${index}]`, `未知领域 ${JSON.stringify(domain)}`);
  }
  if (!domains.includes(catalogDomain)) {
    fail(file, `${path}.domains`, `必须包含目录领域 ${JSON.stringify(catalogDomain)}`);
  }
  const install = parseInstall(raw.install, file, `${path}.install`);
  installKind(type, install, file, `${path}.install`);
  const credentials = stringArray(raw.credentials, file, `${path}.credentials`, {
    maxItems: 20,
    maxLength: 100
  });
  for (const [index, key] of credentials.entries()) {
    if (!ENV_PATTERN.test(key)) fail(file, `${path}.credentials[${index}]`, "必须是环境变量名");
  }
  if (install.method === "dsh-install" && install.kind === "skill" && credentials.length > 0) {
    fail(file, `${path}.credentials`, "v0.1 不支持在 skill 候选中声明凭证；请由 Skill 自身文档说明");
  }
  if (install.method === "builtin" && credentials.length > 0) {
    fail(file, `${path}.credentials`, "builtin 候选不能声明凭证");
  }
  if (install.method === "dsh-install" && install.kind === "mcp") {
    const env = new Set(install.env ?? []);
    for (const credential of credentials) {
      if (!env.has(credential)) {
        fail(file, `${path}.credentials`, `凭证 ${credential} 必须同时出现在 install.env 中，才能由 dsh-install 注入 ${'$'}{VAR} 引用`);
      }
    }
  }
  const weightValue = raw.weight;
  let weight: number | undefined;
  if (weightValue !== undefined) {
    if (typeof weightValue !== "number" || !Number.isFinite(weightValue) || weightValue < 0 || weightValue > 1) {
      fail(file, `${path}.weight`, "必须是 0..1 的数字");
    }
    weight = weightValue;
  }
  const toolCountValue = raw.toolCount;
  const toolCount = toolCountValue === undefined
    ? undefined
    : integer(toolCountValue, file, `${path}.toolCount`, 0, 10_000);
  const verifiedAt = optionalText(raw.verifiedAt, file, `${path}.verifiedAt`, 10);
  if (verifiedAt !== undefined && !DATE_PATTERN.test(verifiedAt)) {
    fail(file, `${path}.verifiedAt`, "必须是 YYYY-MM-DD");
  }
  let discovery: Candidate["discovery"];
  if (raw.discovery !== undefined) {
    const value = record(raw.discovery, file, `${path}.discovery`);
    const source = text(value.source, file, `${path}.discovery.source`, 16);
    if (source !== "github" && source !== "registry" && source !== "skills.sh") {
      fail(file, `${path}.discovery.source`, "支持 github / registry / skills.sh");
    }
    if (value.verified !== undefined && bool(value.verified, file, `${path}.discovery.verified`) !== false) {
      fail(file, `${path}.discovery.verified`, "发现项必须是未验证");
    }
    let sourcePriority: number | undefined;
    if (value.sourcePriority !== undefined) {
      if (typeof value.sourcePriority !== "number" || !Number.isFinite(value.sourcePriority) || value.sourcePriority < 0 || value.sourcePriority > 1) {
        fail(file, `${path}.discovery.sourcePriority`, "必须是 0..1 的数字");
      }
      sourcePriority = value.sourcePriority;
    }
    let quality: number | undefined;
    if (value.quality !== undefined) {
      if (typeof value.quality !== "number" || !Number.isFinite(value.quality) || value.quality < 0 || value.quality > 1) {
        fail(file, `${path}.discovery.quality`, "必须是 0..1 的数字");
      }
      quality = value.quality;
    }
    const packageVerified = value.packageVerified === undefined ? undefined : bool(value.packageVerified, file, `${path}.discovery.packageVerified`);
    const repo = value.repo === undefined ? undefined : text(value.repo, file, `${path}.discovery.repo`, 200);
    const stars = value.stars === undefined ? undefined : integer(value.stars, file, `${path}.discovery.stars`, 0, 10_000_000);
    discovery = {
      source,
      ...(repo === undefined ? {} : { repo }),
      url: text(value.url, file, `${path}.discovery.url`, 1000),
      ...(stars === undefined ? {} : { stars }),
      ...(quality === undefined ? {} : { quality }),
      ...(packageVerified === undefined ? {} : { packageVerified }),
      ...(sourcePriority === undefined ? {} : { sourcePriority }),
      query: text(value.query, file, `${path}.discovery.query`, 300),
      verified: false
    };
  }
  const candidate: Candidate = {
    id,
    type,
    name: text(raw.name, file, `${path}.name`, 100),
    description: text(raw.description, file, `${path}.description`, 600),
    domains,
    tasks: stringArray(raw.tasks, file, `${path}.tasks`, { allowEmpty: false, maxItems: 20, maxLength: 100 }),
    tools: stringArray(raw.tools, file, `${path}.tools`, { maxItems: 80, maxLength: 120 }),
    risk: parseRisk(raw.risk, file, `${path}.risk`),
    credentials,
    install,
    requires: parseRequirements(raw.requires, file, `${path}.requires`),
    group: optionalText(raw.group, file, `${path}.group`, 64),
    weight,
    toolCount,
    homepage: optionalText(raw.homepage, file, `${path}.homepage`, 1000),
    sourceRepo: optionalText(raw.sourceRepo, file, `${path}.sourceRepo`, 1000),
    license: optionalText(raw.license, file, `${path}.license`, 80),
    packageVersion: optionalText(raw.packageVersion, file, `${path}.packageVersion`, 40),
    verifiedAt,
    notes: stringArray(raw.notes, file, `${path}.notes`, { maxItems: 20, maxLength: 500 }),
    ...(discovery === undefined ? {} : { discovery })
  };
  for (const [field, url] of [["homepage", candidate.homepage], ["sourceRepo", candidate.sourceRepo]] as const) {
    if (url !== undefined && !/^https?:\/\//i.test(url)) fail(file, `${path}.${field}`, "必须是 http(s) URL");
  }
  return candidate;
}

export function validateCatalog(value: unknown, file: string): CatalogFile {
  const raw = record(value, file, "root");
  if (raw.schemaVersion !== 1) fail(file, "schemaVersion", "只支持 1");
  const domain = text(raw.domain, file, "domain", 32);
  if (!DOMAIN_IDS.has(domain)) fail(file, "domain", `未知领域 ${JSON.stringify(domain)}`);
  if (!Array.isArray(raw.capabilities)) fail(file, "capabilities", "必须是数组");
  if (raw.capabilities.length === 0) fail(file, "capabilities", "至少需要 1 个候选");
  if (raw.capabilities.length > 500) fail(file, "capabilities", "最多 500 个候选");
  const capabilities = raw.capabilities.map((candidate, index) =>
    parseCandidate(candidate, file, `capabilities[${index}]`, domain)
  );
  const ids = new Set<string>();
  for (const candidate of capabilities) {
    if (ids.has(candidate.id)) fail(file, "capabilities", `重复的能力 ID ${candidate.id}`);
    ids.add(candidate.id);
  }
  return {
    schemaVersion: 1,
    domain,
    title: optionalText(raw.title, file, "title", 100),
    capabilities
  };
}
