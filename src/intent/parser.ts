import { containsTerm, normalizeText, unique } from "../util/text.js";
import type { Intent } from "../types.js";

export class IntentError extends Error {
  override name = "IntentError";
}

interface DomainRule {
  id: string;
  label: string;
  keywords: string[];
}

interface TaskRule {
  label: string;
  domain: string;
  keywords: string[];
}

interface ConstraintRule {
  label: string;
  keywords: string[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    id: "research",
    label: "科研",
    keywords: [
      "论文", "文献", "引用", "学术", "科研", "检索", "paper", "papers",
      "literature", "citation", "citations", "cite", "research", "arxiv",
      "openalex", "semantic scholar", "doi", "bibtex", "zotero", "文献库", "pdf",
      "论文写作", "科研绘图", "科研写作", "学术写作"
    ]
  },
  {
    id: "office",
    label: "办公",
    keywords: [
      "docx", "word", "文档", "报告", "合同", "excel", "xlsx", "表格",
      "spreadsheet", "工作簿", "worksheet", "ppt", "pptx", "powerpoint",
      "幻灯片", "演示", "slide", "slides", "office", "模板", "template"
    ]
  },
  {
    id: "development",
    label: "开发",
    keywords: [
      "代码", "仓库", "git", "github", "测试", "test", "api", "mcp", "插件",
      "plugin", "部署", "deploy", "database", "数据库", "debug", "调试", "重构"
    ]
  }
];

const TASK_RULES: TaskRule[] = [
  {
    label: "文献检索",
    domain: "research",
    keywords: ["检索", "搜索", "查找", "paper", "papers", "literature", "arxiv", "openalex", "semantic scholar", "doi"]
  },
  {
    label: "论文撰写",
    domain: "research",
    keywords: ["撰写", "写作", "write", "writing", "manuscript", "paper writing", "论文写作", "起草"]
  },
  {
    label: "科研绘图",
    domain: "research",
    keywords: ["科研绘图", "绘图", "画图", "可视化", "plot", "plotting", "figure", "figures", "chart", "diagram", "示意图"]
  },
  {
    label: "引用整理",
    domain: "research",
    keywords: ["引用", "citation", "citations", "cite", "bibtex", "参考文献", "ris"]
  },
  {
    label: "PDF解析",
    domain: "research",
    keywords: ["pdf", "全文", "解析", "parse", "extract", "抽取"]
  },
  {
    label: "本地文献库",
    domain: "research",
    keywords: ["zotero", "文献库", "本地库", "library", "本地文献"]
  },
  {
    label: "学术元数据",
    domain: "research",
    keywords: ["元数据", "metadata", "doi", "bibtex", "ris", "作者", "author"]
  },
  {
    label: "文档读写",
    domain: "office",
    keywords: ["word", "docx", "文档", "报告", "合同", "doc"]
  },
  {
    label: "表格处理",
    domain: "office",
    keywords: ["excel", "xlsx", "表格", "spreadsheet", "工作簿", "worksheet"]
  },
  {
    label: "演示制作",
    domain: "office",
    keywords: ["ppt", "pptx", "powerpoint", "幻灯片", "演示", "slide", "slides", "presentation"]
  },
  {
    label: "格式转换",
    domain: "office",
    keywords: ["转换", "convert", "markdown", "markitdown", "导出", "pdf"]
  },
  {
    label: "模板生成",
    domain: "office",
    keywords: ["模板", "template"]
  },
  {
    label: "代码修改",
    domain: "development",
    keywords: ["代码", "code", "重构", "refactor", "修复", "fix"]
  },
  {
    label: "测试运行",
    domain: "development",
    keywords: ["测试", "test", "pytest", "vitest", "jest", "覆盖率", "coverage"]
  },
  {
    label: "仓库分析",
    domain: "development",
    keywords: ["仓库", "repository", "git", "github", "gitlab", "commit", "diff"]
  },
  {
    label: "MCP开发",
    domain: "development",
    keywords: ["mcp", "插件", "plugin", "工具开发", "tool development"]
  }
];

const CONSTRAINT_RULES: ConstraintRule[] = [
  {
    label: "只读优先",
    keywords: ["只读", "不要写", "不写文件", "别写", "不要修改", "read-only", "readonly", "no write", "do not write", "don't write"]
  },
  {
    label: "本地优先",
    keywords: ["本地", "离线", "local", "offline", "on-prem"]
  },
  {
    label: "无需凭证",
    keywords: ["无需密钥", "不需要密钥", "无密钥", "免密钥", "不要 api key", "不要api key", "no api key", "no key", "without credential", "keyless"]
  },
  {
    label: "不要安装",
    keywords: ["不要安装", "不要装", "别安装", "no install", "without installing", "don't install"]
  },
  {
    label: "隐私敏感",
    keywords: ["隐私", "机密", "confidential", "private", "敏感数据"]
  }
];

export const DOMAIN_LABELS: Record<string, string> = {
  research: "科研",
  office: "办公",
  development: "开发",
  other: "其他"
};

export const TASK_LABELS: string[] = TASK_RULES.map((rule) => rule.label);
export const CONSTRAINT_LABELS: string[] = CONSTRAINT_RULES.map((rule) => rule.label);

function detectLocale(text: string): Intent["locale"] {
  const hasHan = /[\u3400-\u9fff]/.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "zh";
  return "en";
}

export function parseIntent(text: string): Intent {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new IntentError("任务描述不能为空。用法：dsh-forage \"帮我检索论文并整理引用\"");
  }
  if (trimmed.length > 8000) {
    throw new IntentError("任务描述过长（上限 8000 字符），请压缩到一两个句子。");
  }

  const normalized = normalizeText(trimmed);
  const signals: string[] = [];
  const domainScores = new Map<string, number>();

  for (const rule of DOMAIN_RULES) {
    let hits = 0;
    for (const keyword of rule.keywords) {
      if (containsTerm(normalized, keyword)) {
        hits += 1;
        signals.push(keyword);
      }
    }
    if (hits > 0) domainScores.set(rule.id, hits);
  }

  const sortedDomains = [...domainScores.entries()].sort((a, b) => b[1] - a[1]);
  const maxDomainScore = sortedDomains[0]?.[1] ?? 0;
  const domainThreshold = Math.max(1, Math.ceil(maxDomainScore * 0.5));
  let domains = sortedDomains
    .filter(([, score]) => score >= domainThreshold)
    .slice(0, 3)
    .map(([id]) => id);
  if (domains.length === 0) domains = ["other"];

  const matchedTasks: Array<{ label: string; domain: string; hits: number }> = [];
  for (const rule of TASK_RULES) {
    let hits = 0;
    for (const keyword of rule.keywords) {
      if (containsTerm(normalized, keyword)) {
        hits += 1;
        signals.push(keyword);
      }
    }
    if (hits > 0) matchedTasks.push({ label: rule.label, domain: rule.domain, hits });
  }
  matchedTasks.sort((a, b) => b.hits - a.hits);
  const tasks = matchedTasks.slice(0, 8).map((task) => task.label);

  const constraints: string[] = [];
  for (const rule of CONSTRAINT_RULES) {
    if (rule.keywords.some((keyword) => containsTerm(normalized, keyword))) {
      constraints.push(rule.label);
    }
  }

  const totalHits = [...domainScores.values()].reduce((sum, value) => sum + value, 0)
    + matchedTasks.reduce((sum, task) => sum + task.hits, 0)
    + constraints.length;
  const confidence = totalHits === 0 ? 0.2 : Math.min(0.95, 0.25 + totalHits * 0.07);

  return {
    tasks,
    domains,
    signals: unique(signals).slice(0, 16),
    constraints,
    confidence: Number(confidence.toFixed(2)),
    locale: detectLocale(trimmed)
  };
}

const DOMAIN_ALIASES: Record<string, string> = {
  research: "research",
  "科研": "research",
  scholar: "research",
  academic: "research",
  office: "office",
  "办公": "office",
  document: "office",
  development: "development",
  dev: "development",
  coding: "development",
  "开发": "development",
  other: "other",
  "其他": "other"
};

const CONSTRAINT_ALIASES: Record<string, string> = {
  "只读": "只读优先",
  "read-only": "只读优先",
  readonly: "只读优先",
  "本地": "本地优先",
  local: "本地优先",
  offline: "本地优先",
  "无需密钥": "无需凭证",
  keyless: "无需凭证",
  "no credentials": "无需凭证",
  "不要安装": "不要安装",
  "no install": "不要安装",
  "隐私": "隐私敏感",
  private: "隐私敏感"
};

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new IntentError(`intent.${field} 必须是字符串数组`);
  }
  return unique(value.map((item) => (item as string).trim()).filter(Boolean));
}

export function parseIntentJson(value: unknown): Intent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntentError("intent 必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  const rawDomains = readStringArray(record.domains, "domains");
  const domains = unique(rawDomains.map((domain) => DOMAIN_ALIASES[normalizeText(domain)] ?? domain));
  const unknownDomains = domains.filter((domain) => !["research", "office", "development", "other"].includes(domain));
  if (unknownDomains.length > 0) {
    throw new IntentError("intent.domains 包含未知领域：" + unknownDomains.join(", "));
  }
  const tasks = readStringArray(record.tasks, "tasks");
  const signals = readStringArray(record.signals, "signals");
  const constraints = unique(
    readStringArray(record.constraints, "constraints").map(
      (constraint) => CONSTRAINT_ALIASES[normalizeText(constraint)] ?? constraint
    )
  );
  if (domains.length === 0 && tasks.length === 0) {
    throw new IntentError("intent 至少需要 domains 或 tasks 之一");
  }
  const confidenceValue = record.confidence;
  const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
    ? Math.min(1, Math.max(0, confidenceValue))
    : 0.8;
  const localeValue = record.locale;
  const inferredLocale = detectLocale([...tasks, ...signals, ...domains].join(" "));
  const locale: Intent["locale"] = localeValue === "zh" || localeValue === "en" || localeValue === "mixed"
    ? localeValue
    : inferredLocale;
  return {
    tasks,
    domains: domains.length > 0 ? domains : ["other"],
    signals,
    constraints,
    confidence,
    locale
  };
}
