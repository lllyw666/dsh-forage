import type { DeployBackend, Scope } from "../types.js";

export class CliUsageError extends Error {
  readonly code = "USAGE";
  readonly fix?: string;
  override name = "CliUsageError";

  constructor(message: string, fix?: string) {
    super(message);
    this.fix = fix;
  }
}

export type CommandName = "forge" | "plan" | "deploy" | "catalog" | "status" | "doctor" | "software" | "enable" | "remove" | "update" | "promote" | "demote" | "help" | "version";

export interface CliOptions {
  command: CommandName;
  query: string;
  ids: string[];
  scope: Scope;
  top: number;
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  noInput: boolean;
  includeHighRisk: boolean;
  catalogs: string[];
  intentJson?: string;
  intentFile?: string;
  dshBin?: string;
  backend: DeployBackend;
  embedding: "off" | "hashed" | "http" | "auto";
  github: boolean;
  githubLimit: number;
  noLocal: boolean;
  offline: boolean;
  healthCheck: boolean;
  staged: boolean;
  activate?: boolean;
  timeoutMs: number;
  domain?: string;
  scopeExplicit: boolean;
  kind?: "mcp" | "skill";
  keepSource: boolean;
  replace: boolean;
  color?: boolean;
  help: boolean;
  version: boolean;
}

const COMMANDS = new Set(["forge", "plan", "deploy", "catalog", "status", "doctor", "software", "enable", "remove", "update", "promote", "demote", "help", "version"]);

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new CliUsageError(name + " 需要整数，收到 " + JSON.stringify(value));
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliUsageError(name + " 必须在 " + String(min) + ".." + String(max) + " 之间");
  }
  return parsed;
}

function takeValue(args: string[], index: number, inline: string | undefined, name: string): { value: string; next: number } {
  if (inline !== undefined) {
    if (inline === "") throw new CliUsageError(name + " 需要一个值");
    return { value: inline, next: index };
  }
  const next = args[index + 1];
  if (next === undefined) throw new CliUsageError(name + " 需要一个值");
  return { value: next, next: index + 1 };
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let command: CommandName = "forge";
  if (args[0] !== undefined && COMMANDS.has(args[0])) {
    command = args[0] as CommandName;
    args.shift();
  }
  const options: CliOptions = {
    command,
    query: "",
    ids: [],
    scope: "project",
    top: 5,
    json: false,
    dryRun: false,
    yes: false,
    noInput: false,
    includeHighRisk: false,
    catalogs: [],
    backend: "auto",
    embedding: "off",
    github: false,
    githubLimit: 3,
    noLocal: false,
    offline: false,
    healthCheck: true,
    staged: false,
    timeoutMs: 180_000,
    scopeExplicit: false,
    keepSource: false,
    replace: false,
    help: false,
    version: false
  };
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    switch (name) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--no-input":
        options.noInput = true;
        break;
      case "--include-high-risk":
        options.includeHighRisk = true;
        break;
      case "--color":
        options.color = true;
        break;
      case "--no-color":
        options.color = false;
        break;
      case "--scope": {
        const { value, next } = takeValue(args, index, inline, name);
        if (value !== "user" && value !== "project" && value !== "session") throw new CliUsageError("--scope 只能是 user、project 或 session");
        options.scope = value;
        options.scopeExplicit = true;
        index = next;
        break;
      }
      case "--top": {
        const { value, next } = takeValue(args, index, inline, name);
        options.top = integer(value, "--top", 1, 20);
        index = next;
        break;
      }
      case "--timeout": {
        const { value, next } = takeValue(args, index, inline, name);
        options.timeoutMs = integer(value, "--timeout", 1000, 3_600_000);
        index = next;
        break;
      }
      case "--catalog": {
        const { value, next } = takeValue(args, index, inline, name);
        options.catalogs.push(value);
        index = next;
        break;
      }
      case "--id": {
        const { value, next } = takeValue(args, index, inline, name);
        options.ids.push(...value.split(/[,，\s]+/).filter(Boolean));
        index = next;
        break;
      }
      case "--ids": {
        const { value, next } = takeValue(args, index, inline, name);
        options.ids.push(...value.split(/[,，\s]+/).filter(Boolean));
        index = next;
        break;
      }
      case "--intent": {
        const { value, next } = takeValue(args, index, inline, name);
        options.intentJson = value;
        index = next;
        break;
      }
      case "--intent-file": {
        const { value, next } = takeValue(args, index, inline, name);
        options.intentFile = value;
        index = next;
        break;
      }
      case "--dsh-bin": {
        const { value, next } = takeValue(args, index, inline, name);
        options.dshBin = value;
        index = next;
        break;
      }
      case "--backend": {
        const { value, next } = takeValue(args, index, inline, name);
        if (value !== "auto" && value !== "local" && value !== "dsh-install") {
          throw new CliUsageError("--backend 只能是 auto、local 或 dsh-install");
        }
        options.backend = value;
        index = next;
        break;
      }
      case "--github": {
        options.github = true;
        break;
      }
      case "--no-local": {
        options.noLocal = true;
        break;
      }
      case "--offline": {
        options.offline = true;
        break;
      }
      case "--no-health-check": {
        options.healthCheck = false;
        break;
      }
      case "--staged": {
        options.staged = true;
        break;
      }
      case "--activate": {
        options.activate = true;
        break;
      }
      case "--github-limit": {
        const { value, next } = takeValue(args, index, inline, name);
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 6) {
          throw new CliUsageError("--github-limit 必须是 1..6 的整数");
        }
        options.githubLimit = limit;
        index = next;
        break;
      }
      case "--embedding": {
        const { value, next } = takeValue(args, index, inline, name);
        if (value !== "off" && value !== "hashed" && value !== "http" && value !== "auto") {
          throw new CliUsageError("--embedding 只能是 off、hashed、http 或 auto");
        }
        options.embedding = value;
        index = next;
        break;
      }
      case "--domain": {
        const { value, next } = takeValue(args, index, inline, name);
        options.domain = value;
        index = next;
        break;
      }
      case "--kind": {
        const { value, next } = takeValue(args, index, inline, name);
        if (value !== "mcp" && value !== "skill") throw new CliUsageError("--kind 只能是 mcp 或 skill");
        options.kind = value;
        index = next;
        break;
      }
      case "--keep-source":
        options.keepSource = true;
        break;
      case "--replace":
        options.replace = true;
        break;
      default:
        throw new CliUsageError("未知选项 " + JSON.stringify(arg), "运行 dsh-forage --help 查看可用选项。");
    }
  }

  options.query = positionals.join(" ").trim();
  if (command === "doctor" && options.query !== "") {
    throw new CliUsageError("doctor 不接受任务描述。", "运行 dsh-forage doctor [--json]，不要附加任务文本。");
  }
  if (command === "help") options.help = true;
  if (command === "version") options.version = true;
  if (options.intentJson !== undefined && options.intentFile !== undefined) {
    throw new CliUsageError("--intent 与 --intent-file 只能二选一");
  }
  if (options.staged && options.activate === true) {
    throw new CliUsageError("--staged 与 --activate 不能同时使用", "先 staging，安装后再运行 dsh-forage enable。");
  }
  return options;
}

export function helpText(version: string): string {
  return [
    "dsh-forage " + version + " — 任务意图驱动的 DSH 能力路由",
    "",
    "用法:",
    "  dsh-forage \"<任务描述>\" [--scope project] [--dry-run] [--json]",
    "  dsh-forage plan \"<任务描述>\" [--top 5] [--json]",
    "  dsh-forage deploy --id arxiv --id semantic-scholar [--scope project] [--yes]",
    "  dsh-forage deploy arxiv,openalex --dry-run",
    "  dsh-forage catalog [research|office] [--json]",
    "  dsh-forage status [--scope user|project] [--json]",
    "  dsh-forage doctor [--json]",
    "  dsh-forage software [name] [--json]",
    "  dsh-forage enable --id <mcp> --scope user|project|session",
    "  dsh-forage remove --id <id> --scope user|project|session [--kind mcp|skill] [--yes] [--json]",
    "  dsh-forage update --id <id> --scope user|project|session [--kind mcp|skill] [--yes] [--json]",
    "  dsh-forage promote --id <id> [--kind mcp|skill] [--keep-source] [--replace] [--yes]",
    "  dsh-forage demote --id <id> [--kind mcp|skill] [--keep-source] [--replace] [--yes]",
    "",
    "选项:",
    "  --scope <user|project|session>  部署作用域或 status 过滤；remove/update 必填；session 只支持 MCP 且是临时覆盖（部署默认 project，status 默认 all）",
    "  --top <n>                展示候选数量 1..20（默认 5）",
    "  --id <id>                部署/迁移/移除/更新指定能力，可重复或逗号分隔",
    "  --kind <mcp|skill>       迁移时明确条目类型（同名 MCP 和 Skill 并存时必须）",
    "  --keep-source            迁移成功后保留源作用域副本",
    "  --replace                目标作用域已有同名项时覆盖",
    "  --catalog <path>         追加项目外的 catalog JSON 或目录，可重复",
    "  --intent <json>          直接传入结构化意图，跳过规则解析",
    "  --intent-file <path>     从 JSON 文件读取结构化意图",
    "  --dry-run                只预览安装命令，不执行",
    "  --yes                    显式批准部署/迁移/移除/更新（非交互环境必须）",
    "  --no-input               禁用交互选择；使用默认勾选",
    "  --include-high-risk      允许安装高风险候选（仍需 --yes）",
    "  --dsh-bin <path>         dsh 可执行文件或 .mjs 启动脚本（仅 dsh-install 后端）",
    "  --backend <mode>         auto（默认）/ local / dsh-install；auto 在显式给 --dsh-bin 时用 dsh-install，否则本地写",
    "  --embedding <mode>       off（默认）/ hashed / http / auto；http 读取 DSH_FORAGE_EMBEDDING_URL，失败自动回退词法",
    "  --github                 显式启用在线发现（默认已启用；配合 DSH_FORAGE_DISCOVERY=off 时使用）",
    "  --github-limit <n>       GitHub 最多检查 1..6 个仓库，默认 3",
    "  --no-local               跳过本地已安装匹配；直接搜索 catalog/GitHub",
    "  --offline                跳过在线发现，仅使用 catalog 兜底",
    "  --no-health-check        跳过安装前 MCP health check（不推荐）",
    "  --staged                 写入 enabled:false，先 staging 后启用",
    "  --activate               强制写入 enabled:true（覆盖发现的默认禁用）",
    "  --timeout <ms>           单个安装命令超时（默认 180000）",
    "  --json                   输出机器可读 JSON",
    "  --color / --no-color     强制开启或关闭颜色",
    "  -h, --help               显示帮助",
    "  -v, --version            显示版本",
    "",
    "意图 JSON 形状:",
    "  {\"tasks\":[\"文献检索\"],\"domains\":[\"research\"],\"signals\":[\"RAG\"],\"constraints\":[\"只读优先\"]}",
    "",
    "安全默认:",
    "  - 只默认勾选低风险、只读、凭证齐全的候选，且最多 2 个、同类只选 1 个。",
    "  - 真正安装前需要人工确认；非交互环境必须显式 --yes。",
    "  - 高风险候选必须 --include-high-risk；密钥只以环境变量引用传递。"
  ].join("\n");
}
