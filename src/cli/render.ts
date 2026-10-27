import type { Candidate, DeployReport, EffectiveBackend, Intent, RankedCandidate, Scope } from "../types.js";
import type { StatusPayload } from "../scopes/status.js";
import type { LocalMatch } from "../scopes/local-match.js";
import type { TransferPlan, TransferResult } from "../scopes/types.js";
import type { DoctorReport } from "./doctor.js";
import type { SoftwareEntry } from "../software/catalog.js";
import { DOMAIN_LABELS } from "../intent/parser.js";
import { renderCandidateList } from "../picker/cli.js";
import { buildDeploymentCommand } from "../deploy/command.js";
import { truncate } from "../util/text.js";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m"
} as const;

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? code + text + ANSI.reset : text;
}

function domainNames(domains: string[]): string {
  return domains.map((domain) => DOMAIN_LABELS[domain] ?? domain).join(" / ");
}

function scopeLabel(scope: Scope): string {
  return scope === "user" ? "用户级（~/.dsh）" : scope === "session" ? "会话级（临时）" : "项目级（.dsh/）";
}

export function renderPlan(intent: Intent, ranked: RankedCandidate[], options: {
  version: string;
  scope: Scope;
  color: boolean;
  catalogCount?: number;
  localMatches?: LocalMatch[];
  discovery?: { queries: string[]; candidates: number } | null;
}): string {
  const lines: string[] = [];
  lines.push(paint("dsh-forage " + options.version, ANSI.bold, options.color) + paint("  ·  意图 → 候选 → 审批 → dsh-install", ANSI.dim, options.color));
  lines.push("");
  lines.push(paint("意图  ", ANSI.cyan, options.color) + domainNames(intent.domains) + (intent.tasks.length === 0 ? "（未识别具体任务）" : "  ·  " + intent.tasks.join(" / ")));
  if (intent.constraints.length > 0) {
    lines.push(paint("约束  ", ANSI.cyan, options.color) + intent.constraints.join(" / "));
  }
  const defaults = ranked.filter((entry) => entry.defaultSelected).length;
  lines.push(paint("作用域 ", ANSI.cyan, options.color) + scopeLabel(options.scope) + "  ·  候选 " + String(ranked.length) + " 个  ·  默认勾选 " + String(defaults) + " 个");
  if (options.discovery !== undefined && options.discovery !== null) {
    lines.push(paint("发现  ", ANSI.cyan, options.color) + "在线发现 · 查询 " + truncate(options.discovery.queries.slice(0, 4).join(" / "), 80) + " · 命中 " + String(options.discovery.candidates) + " 个");
  } else {
    lines.push(paint("发现  ", ANSI.cyan, options.color) + "离线 catalog 兜底（--offline 或在线发现无结果）");
  }
  if (options.localMatches !== undefined && options.localMatches.length > 0) {
    lines.push("");
    lines.push(paint("本地已安装（先确认，不要重复安装）", ANSI.bold, options.color));
    for (const match of options.localMatches) {
      const kind = match.kind === "skill" ? "Skill" : "MCP";
      lines.push("  - " + kind + " " + match.name + paint("  " + match.scope + "  ·  " + String(match.score) + " 分", ANSI.dim, options.color));
      if (match.reasons.length > 0) lines.push(paint("    " + match.reasons.slice(0, 3).join(" / "), ANSI.dim, options.color));
    }
    lines.push(paint("  先问用户：直接使用本地，还是继续搜索新项？继续搜索用 --no-local。", ANSI.yellow, options.color));
  }
  if (ranked.length === 0) {
    lines.push("");
    lines.push(paint("没有匹配到候选。", ANSI.yellow, options.color));
    lines.push("可能原因：约束排除了所有安装项（例如“不要安装”），或 catalog 未覆盖该领域。");
    lines.push("贡献候选：docs/catalog-guide.md");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(renderCandidateList(ranked, { color: options.color }));
  if (defaults === 0) {
    lines.push("");
    lines.push(paint("没有默认勾选项：候选涉及写入、外部网络限制或缺少凭证，需要你显式选择。", ANSI.yellow, options.color));
  }
  return lines.join("\n");
}

export function renderDeploymentPreview(candidates: Candidate[], scope: Scope, color: boolean, backend: EffectiveBackend = "dsh-install"): string {
  const lines: string[] = [];
  lines.push(paint("部署预览", ANSI.bold, color) + paint("  ·  " + scopeLabel(scope), ANSI.dim, color));
  candidates.forEach((candidate, index) => {
    lines.push("");
    lines.push("  " + String(index + 1) + ". " + candidate.name + paint("  (" + candidate.id + ")", ANSI.dim, color));
    if (candidate.install.method === "builtin") {
      lines.push(paint("     内置能力，无需执行安装命令。", ANSI.green, color));
      return;
    }
    const command = buildDeploymentCommand(candidate, scope, backend);
    lines.push(paint("     " + (command?.display ?? "无法生成命令"), ANSI.dim, color));
  });
  return lines.join("\n");
}

function statusIcon(status: DeployReport["results"][number]["status"], color: boolean): string {
  if (status === "installed") return paint("✓", ANSI.green, color);
  if (status === "failed") return paint("✗", ANSI.red, color);
  if (status === "planned") return paint("○", ANSI.cyan, color);
  if (status === "available") return paint("●", ANSI.green, color);
  return paint("-", ANSI.yellow, color);
}

export function renderReport(report: DeployReport, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint(report.dryRun ? "部署预览结果" : "部署结果", ANSI.bold, color) + paint("  ·  " + scopeLabel(report.scope) + "  ·  后端 " + report.backend, ANSI.dim, color));
  for (const result of report.results) {
    lines.push("");
    lines.push("  " + statusIcon(result.status, color) + " " + result.name + paint("  " + result.status, ANSI.dim, color));
    lines.push("     " + result.message);
    if (result.command !== undefined) lines.push(paint("     " + result.command, ANSI.dim, color));
    if (result.fix !== undefined) lines.push(paint("     修复：" + result.fix, ANSI.yellow, color));
    if (result.stderr !== undefined && result.stderr.trim() !== "") {
      lines.push(paint("     stderr：" + truncate(result.stderr.trim().replace(/\s+/g, " "), 500), ANSI.dim, color));
    }
  }
  lines.push("");
  const summary = report.summary;
  lines.push(paint("汇总  ", ANSI.cyan, color)
    + "成功 " + String(summary.installed)
    + "  ·  失败 " + String(summary.failed)
    + "  ·  跳过 " + String(summary.skipped)
    + "  ·  内置 " + String(summary.available)
    + "  ·  预览 " + String(summary.planned));
  for (const warning of report.warnings) lines.push(paint("注意  " + warning, ANSI.yellow, color));
  if (report.dryRun) lines.push(paint("这是预览；去掉 --dry-run 并在确认后加 --yes 才会真正写入。", ANSI.dim, color));
  return lines.join("\n");
}

export function renderCatalog(candidates: Candidate[], color: boolean): string {
  const lines: string[] = [];
  lines.push(paint("能力目录", ANSI.bold, color) + paint("  ·  " + String(candidates.length) + " 个候选", ANSI.dim, color));
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const domain = candidate.domains[0] ?? "other";
    const group = DOMAIN_LABELS[domain] ?? domain;
    const bucket = groups.get(group) ?? [];
    bucket.push(candidate);
    groups.set(group, bucket);
  }
  for (const [group, entries] of groups) {
    lines.push("");
    lines.push(paint(group, ANSI.cyan, color));
    for (const candidate of entries) {
      const risk = candidate.risk.level === "low" ? "低风险" : candidate.risk.level === "medium" ? "中风险" : "高风险";
      const action = candidate.risk.writes ? "写入" : "只读";
      const credentials = candidate.credentials.length === 0 ? "无凭证" : "凭证 " + candidate.credentials.join(", ");
      lines.push("  " + candidate.id.padEnd(16) + "  " + candidate.type.toUpperCase().padEnd(7) + "  " + risk + "  " + action + "  " + credentials);
      lines.push("    " + candidate.description);
    }
  }
  return lines.join("\n");
}

export function renderScopeStatus(payload: StatusPayload, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint("安装状态", ANSI.bold, color) + paint("  ·  " + (payload.scope === "all" ? "全部作用域" : payload.scope === "user" ? "用户级" : payload.scope === "session" ? "会话级" : "项目级"), ANSI.dim, color));
  lines.push("");
  lines.push(paint("DSH_HOME  ", ANSI.cyan, color) + payload.dshHome);
  lines.push(paint("项目根    ", ANSI.cyan, color) + (payload.projectRoot ?? "（无 .git，project scope 不可用）"));
  lines.push("");
  lines.push(paint("MCP", ANSI.bold, color));
  if (payload.mcps.length === 0) lines.push("  （无）");
  for (const item of payload.mcps) {
    const scope = item.scope === "user" ? "用户级" : item.scope === "session" ? "会话级" : "项目级";
    const tools = item.toolCount === undefined ? "" : " · catalog " + String(item.toolCount) + " tools";
    const shadow = item.shadowedBy === undefined ? "" : paint(" · 被 " + item.shadowedBy + " 同名项遮蔽", ANSI.yellow, color);
    lines.push("  " + item.name + paint("  " + scope + tools, ANSI.dim, color) + shadow);
    lines.push(paint("    " + item.path, ANSI.dim, color));
  }
  lines.push("");
  lines.push(paint("Skill", ANSI.bold, color));
  if (payload.skills.length === 0) lines.push("  （无）");
  for (const item of payload.skills) {
    const scope = item.scope === "user" ? "用户级" : item.scope === "session" ? "会话级" : "项目级";
    const shadow = item.shadowedBy === undefined ? "" : paint(" · 被 " + item.shadowedBy + " 同名项遮蔽", ANSI.yellow, color);
    lines.push("  " + item.name + paint("  " + scope, ANSI.dim, color) + shadow);
    lines.push(paint("    " + item.sourcePath, ANSI.dim, color));
    if (item.description !== "") lines.push("    " + item.description);
  }
  for (const warning of payload.warnings) lines.push(paint("注意  " + warning, ANSI.yellow, color));
  lines.push("");
  lines.push(paint("汇总  ", ANSI.cyan, color)
    + "用户级 MCP " + String(payload.summary.userMcps)
    + " · 项目级 MCP " + String(payload.summary.projectMcps)
    + " · 用户级 Skill " + String(payload.summary.userSkills)
    + " · 项目级 Skill " + String(payload.summary.projectSkills));
  return lines.join("\n");
}

export function renderTransferPlan(plan: TransferPlan, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint("迁移预览", ANSI.bold, color) + paint("  ·  " + plan.sourceScope + " → " + plan.targetScope, ANSI.dim, color));
  lines.push("");
  lines.push("  " + plan.item.kind.toUpperCase() + "  " + plan.item.name);
  lines.push(paint("  " + plan.item.path, ANSI.dim, color));
  for (const command of plan.commands) lines.push(paint("  " + command, ANSI.dim, color));
  for (const note of plan.notes) lines.push(paint("注意  " + note, ANSI.yellow, color));
  return lines.join("\n");
}

export function renderTransferResult(result: TransferResult, color: boolean): string {
  const lines: string[] = [];
  const icon = result.status === "planned" ? paint("○", ANSI.cyan, color) : result.ok ? paint("✓", ANSI.green, color) : paint("✗", ANSI.red, color);
  lines.push(icon + " " + result.item.kind.toUpperCase() + " " + result.item.name + paint("  " + result.status, ANSI.dim, color));
  lines.push("  " + result.message);
  for (const command of result.commands) lines.push(paint("  " + command, ANSI.dim, color));
  for (const warning of result.warnings) lines.push(paint("注意  " + warning, ANSI.yellow, color));
  if (result.fix !== undefined) lines.push(paint("修复  " + result.fix, ANSI.yellow, color));
  return lines.join("\n");
}

export function renderDoctor(report: DoctorReport, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint("dsh-forage doctor", ANSI.bold, color) + paint("  ·  " + report.cwd, ANSI.dim, color));
  lines.push("");
  for (const check of report.checks) {
    const icon = check.level === "ok"
      ? paint("✓", ANSI.green, color)
      : check.level === "warn"
        ? paint("!", ANSI.yellow, color)
        : paint("✗", ANSI.red, color);
    lines.push(icon + " " + check.message);
    if (check.fix !== undefined) lines.push(paint("   修复：" + check.fix, ANSI.dim, color));
  }
  lines.push("");
  lines.push(paint("汇总  ", ANSI.cyan, color)
    + "正常 " + String(report.summary.ok)
    + " · 警告 " + String(report.summary.warn)
    + " · 错误 " + String(report.summary.error));
  return lines.join("\n");
}
export function renderSoftware(entries: SoftwareEntry[], query: string, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint("软件前置", ANSI.bold, color) + paint(query === "" ? "  ·  全部" : "  ·  " + query, ANSI.dim, color));
  if (entries.length === 0) {
    lines.push("");
    lines.push("没有找到匹配的软件。请用浏览器搜索官方名称并核对许可证。");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push("");
    lines.push(paint(entry.name, ANSI.bold, color) + paint("  ·  " + entry.license, ANSI.dim, color));
    lines.push("  用途：" + entry.purpose);
    if (entry.official !== undefined) {
      lines.push(paint("  官方：" + entry.official.url, ANSI.cyan, color));
      if (entry.official.note !== undefined) lines.push(paint("        " + entry.official.note, ANSI.dim, color));
    }
    for (const option of entry.freeOptions) {
      lines.push(paint("  免费/替代：" + option.name + " · " + option.url, ANSI.green, color));
      lines.push(paint("            " + option.license + (option.note === undefined ? "" : " · " + option.note), ANSI.dim, color));
    }
    lines.push(paint("  搜索：" + "https://www.google.com/search?q=" + encodeURIComponent(entry.searchQuery), ANSI.dim, color));
    for (const note of entry.notes) lines.push(paint("  注意：" + note, ANSI.yellow, color));
  }
  lines.push("");
  lines.push(paint("免责声明", ANSI.bold, color));
  lines.push("  仅提供官方或开源软件入口，不提供破解、激活绕过、网盘或来源不明的二进制。dsh-forage 与软件厂商无隶属关系，不保证可用性/安全性/许可证/更新。");
  lines.push("  付费软件请自行购买合法许可证；下载前核对官方域名、签名和哈希。风险由用户自行承担。");
  return lines.join("\n");
}
