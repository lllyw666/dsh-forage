import type { RankedCandidate } from "../types.js";
import { DOMAIN_LABELS } from "../intent/parser.js";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m"
} as const;

export interface RenderOptions {
  color?: boolean;
}

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? code + text + ANSI.reset : text;
}

function riskLabel(level: RankedCandidate["candidate"]["risk"]["level"]): string {
  if (level === "low") return "低风险";
  if (level === "medium") return "中风险";
  return "高风险";
}

function typeLabel(entry: RankedCandidate): string {
  if (entry.candidate.install.method === "builtin") return "内置";
  return entry.candidate.type.toUpperCase();
}

function defaultLabel(entry: RankedCandidate): string {
  if (entry.defaultSelected) return "默认勾选";
  if (entry.defaultBlockedBy.length > 0) return "未默认勾选：" + entry.defaultBlockedBy[0];
  return "未默认勾选";
}

export function renderCandidateList(ranked: RankedCandidate[], options: RenderOptions = {}): string {
  const color = options.color === true;
  const lines: string[] = [];
  lines.push(paint("候选能力", ANSI.bold, color));
  const groups = new Map<string, Array<{ entry: RankedCandidate; index: number }>>();
  ranked.forEach((entry, index) => {
    const domain = entry.candidate.domains[0] ?? "other";
    const group = DOMAIN_LABELS[domain] ?? domain;
    const bucket = groups.get(group) ?? [];
    bucket.push({ entry, index });
    groups.set(group, bucket);
  });
  for (const [group, entries] of groups) {
    lines.push("");
    lines.push(paint("  " + group, ANSI.cyan, color));
    for (const { entry, index } of entries) {
      const candidate = entry.candidate;
      const selected = entry.defaultSelected;
      const box = selected ? "[x]" : "[ ]";
      const boxText = paint(box, selected ? ANSI.green : ANSI.dim, color);
      const tags = [typeLabel(entry), riskLabel(candidate.risk.level), candidate.risk.writes ? "写入" : "只读"];
      lines.push("  " + boxText + " " + String(index + 1) + ". " + paint(candidate.name, ANSI.bold, color) + "  " + paint("· " + tags.join(" · "), ANSI.dim, color));
      lines.push("      " + candidate.description);
      const tasks = candidate.tasks.slice(0, 4).join(" / ");
      const toolCount = candidate.toolCount ?? candidate.tools.length;
      const credentialText = candidate.credentials.length === 0
        ? "无"
        : candidate.credentials.map((key) => entry.missingCredentials.includes(key) ? key + "（未设置）" : key).join(", ");
      const meta = "任务 " + tasks + " · 工具 " + String(toolCount)
        + " · 外部请求 " + (candidate.risk.external_requests ? "是" : "否")
        + " · 凭证 " + credentialText;
      lines.push(paint("      " + meta, ANSI.dim, color));
      lines.push(paint("      " + defaultLabel(entry), selected ? ANSI.green : ANSI.yellow, color));
      if (entry.reasons.length > 0) {
        lines.push(paint("      依据 " + entry.reasons.slice(0, 4).join(" · "), ANSI.dim, color));
      }
      const requirements = candidate.requires ?? [];
      if (requirements.length > 0) {
        const first = requirements[0];
        if (first !== undefined) {
          lines.push(paint("      前置 " + first.label + (first.hint === undefined ? "" : "：" + first.hint), ANSI.yellow, color));
        }
      }
    }
  }
  return lines.join("\n");
}

export type SelectionParse =
  | { kind: "accept" }
  | { kind: "cancel" }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "other" }
  | { kind: "toggle"; indexes: number[] }
  | { kind: "invalid"; message: string };

export function parseSelectionInput(input: string, count: number): SelectionParse {
  const value = input.trim();
  if (value === "") return { kind: "accept" };
  const lowered = value.toLowerCase();
  if (lowered === "q" || lowered === "quit" || lowered === "cancel") return { kind: "cancel" };
  if (lowered === "a" || lowered === "all") return { kind: "all" };
  if (lowered === "n" || lowered === "none") return { kind: "none" };
  if (lowered === "?" || lowered === "help" || lowered === "h") return { kind: "help" };
  if (lowered === "o" || lowered === "other" || lowered === "自定义") return { kind: "other" };
  const indexes: number[] = [];
  const tokens = value.split(/[\s,，、]+/).filter(Boolean);
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) return { kind: "invalid", message: "范围起点不能大于终点：" + token };
      if (start < 1 || end > count) return { kind: "invalid", message: "编号超出范围：" + token };
      for (let index = start; index <= end; index += 1) indexes.push(index - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) return { kind: "invalid", message: "无法识别：" + token };
    const number = Number(token);
    if (number < 1 || number > count) return { kind: "invalid", message: "编号超出范围：" + token };
    indexes.push(number - 1);
  }
  return { kind: "toggle", indexes: [...new Set(indexes)].sort((a, b) => a - b) };
}

export interface SelectOptions {
  ask?: (question: string) => Promise<string>;
  write: (text: string) => void;
  defaults: number[];
  count: number;
  interactive: boolean;
  onOther?: (text: string) => void | Promise<void>;
}

function summarizeSelection(selected: Set<number>, ranked: RankedCandidate[]): string {
  if (selected.size === 0) return "已选：无";
  const names = [...selected]
    .sort((a, b) => a - b)
    .map((index) => String(index + 1) + ". " + (ranked[index]?.candidate.name ?? "?"))
    .join("，");
  return "已选：" + names;
}

export async function selectCandidates(ranked: RankedCandidate[], options: SelectOptions): Promise<number[] | null> {
  const selected = new Set(options.defaults.filter((index) => index >= 0 && index < options.count));
  if (!options.interactive || options.ask === undefined) {
    return [...selected].sort((a, b) => a - b);
  }
  const ask = options.ask;
  for (;;) {
    const answer = await ask("切换编号（如 1,3-5；回车确认，a 全选，n 清空，o 其他想法，q 取消，? 帮助）：");
    const parsed = parseSelectionInput(answer, options.count);
    if (parsed.kind === "accept") return [...selected].sort((a, b) => a - b);
    if (parsed.kind === "cancel") return null;
    if (parsed.kind === "help") {
      options.write("  " + "输入编号切换勾选；1-3 表示区间；a 全选；n 清空；o 输入其他想法；回车接受当前选择。");
      continue;
    }
    if (parsed.kind === "other") {
      const text = await ask("输入其他想法（回车返回，不修改当前勾选）：");
      if (text.trim() !== "") {
        if (options.onOther !== undefined) await options.onOther(text.trim());
        options.write("  已记录其他想法：" + text.trim());
      }
      continue;
    }
    if (parsed.kind === "all") {
      for (let index = 0; index < options.count; index += 1) selected.add(index);
    } else if (parsed.kind === "none") {
      selected.clear();
    } else if (parsed.kind === "toggle") {
      for (const index of parsed.indexes) {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
      }
    } else {
      options.write("  " + parsed.message);
      continue;
    }
    options.write("  " + summarizeSelection(selected, ranked));
  }
}
