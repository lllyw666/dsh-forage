import type { Candidate, Intent, RankedCandidate } from "../types.js";
import { DOMAIN_LABELS } from "../intent/parser.js";
import { clamp, containsTerm, unique } from "../util/text.js";
import { semanticScore } from "./semantic.js";

export interface RankOptions {
  env?: NodeJS.ProcessEnv;
  topN?: number;
  maxDefaults?: number;
}

export function candidateText(candidate: Candidate): string {
  return [
    candidate.id,
    candidate.name,
    candidate.description,
    ...candidate.domains,
    ...candidate.tasks,
    ...candidate.tools,
    ...(candidate.notes ?? [])
  ].join(" ");
}

function requirementBlocksDefault(candidate: Candidate): string | undefined {
  const blocking = candidate.requires?.find(
    (requirement) => requirement.kind === "desktop-app" || requirement.kind === "manual-setup"
  );
  if (blocking !== undefined) return `需要人工准备：${blocking.label}`;
  return undefined;
}

function constraintBlock(candidate: Candidate, intent: Intent, missingCredentials: string[]): string | undefined {
  if (intent.constraints.includes("只读优先") && candidate.risk.writes) {
    return "涉及写入，不符合只读约束";
  }
  if (intent.constraints.includes("无需凭证") && candidate.credentials.length > 0) {
    return "需要凭证，不符合免凭证约束";
  }
  if (intent.constraints.includes("本地优先") && candidate.risk.external_requests) {
    return "会访问外部网络，不符合本地优先约束";
  }
  if (intent.constraints.includes("隐私敏感") && candidate.risk.external_requests) {
    return "会访问外部网络，不符合隐私约束";
  }
  if (missingCredentials.length > 0) {
    return `缺少环境变量：${missingCredentials.join(", ")}`;
  }
  return undefined;
}

function baseEligibility(candidate: Candidate): string | undefined {
  if (candidate.risk.level !== "low") return "风险等级不是 low";
  if (candidate.risk.writes) return "涉及写入";
  if (candidate.risk.sensitive_permissions) return "涉及敏感权限";
  return requirementBlocksDefault(candidate);
}

export interface ScoreBoost {
  score: number;
  reason?: string;
}

export function rankCandidatesWithBoosts(
  intent: Intent,
  candidates: Candidate[],
  options: RankOptions = {},
  boosts: ReadonlyMap<string, ScoreBoost> = new Map()
): RankedCandidate[] {
  const env = options.env ?? process.env;
  const topN = Math.max(1, Math.min(20, options.topN ?? 5));
  const maxDefaults = Math.max(0, Math.min(5, options.maxDefaults ?? 2));
  const noInstall = intent.constraints.includes("不要安装");
  const ranked: RankedCandidate[] = [];

  for (const candidate of candidates) {
    if (noInstall && candidate.install.method !== "builtin") continue;

    const reasons: string[] = [];
    let score = 0;
    const domainHits = candidate.domains.filter((domain) => intent.domains.includes(domain));
    if (domainHits.length > 0) {
      score += 35;
      reasons.push(`领域匹配：${domainHits.map((domain) => DOMAIN_LABELS[domain] ?? domain).join(" / ")}`);
    } else if (intent.domains.includes("other")) {
      score += 8;
    }

    const taskHits = candidate.tasks.filter((task) => intent.tasks.includes(task));
    if (taskHits.length > 0) {
      score += Math.min(54, taskHits.length * 18);
      reasons.push(`任务匹配：${taskHits.join(" / ")}`);
    }

    const haystack = candidateText(candidate);
    const signalHits = unique(intent.signals.filter((signal) => containsTerm(haystack, signal)));
    if (signalHits.length > 0) {
      score += Math.min(18, signalHits.length * 3);
      reasons.push(`关键词：${signalHits.slice(0, 5).join(" / ")}`);
    }

    const similarity = semanticScore(intent, candidate);
    if (similarity >= 0.12) {
      score += Math.round(Math.min(18, similarity * 30));
      reasons.push(`描述相似度 ${(similarity * 100).toFixed(0)}%`);
    }
    const boost = boosts.get(candidate.id);
    if (boost !== undefined) {
      score += boost.score;
      if (boost.reason !== undefined) reasons.push(boost.reason);
    }

    if (candidate.risk.level === "low") score += 6;
    else if (candidate.risk.level === "medium") score += 1;
    else score -= 8;
    if (candidate.discovery !== undefined) {
      const discovery = candidate.discovery;
      const priority = discovery.sourcePriority ?? (discovery.source === "registry" ? 0.9 : discovery.source === "skills.sh" ? 0.8 : 0.5);
      const stars = discovery.stars ?? 0;
      const starScore = stars > 0 ? clamp(Math.log10(stars + 1) / 5, 0, 1) : 0;
      const quality = clamp(discovery.quality ?? starScore, 0, 1);
      const trust = clamp(priority * quality, 0, 1);
      const boost = Math.round(trust * 30);
      score += boost;
      const qualityLabel = discovery.quality !== undefined ? "quality " + quality.toFixed(2) : String(stars) + " stars";
      reasons.push("来源信任：" + discovery.source + " priority " + priority.toFixed(2) + " × " + qualityLabel + "（+" + String(boost) + "）");
      if (discovery.source === "github" && stars < 20) {
        const penalty = stars < 5 ? 20 : 12;
        score -= penalty;
        reasons.push("低星仓库降权（-" + String(penalty) + "）");
      }
    }
    if (candidate.install.method === "builtin") score += 4;
    score += (candidate.weight ?? 0.5) * 8;

    const missingCredentials = candidate.credentials.filter((key) => {
      const value = env[key];
      return value === undefined || value.trim() === "";
    });
    if (missingCredentials.length > 0) {
      score -= 8;
      reasons.push(`缺少凭证：${missingCredentials.join(", ")}`);
    }
    const blockedBy = constraintBlock(candidate, intent, missingCredentials);
    if (intent.constraints.includes("只读优先") && candidate.risk.writes) score -= 30;
    if (intent.constraints.includes("无需凭证") && candidate.credentials.length > 0) score -= 25;
    if (intent.constraints.includes("本地优先") && candidate.risk.external_requests) score -= 8;
    if (intent.constraints.includes("隐私敏感") && candidate.risk.external_requests) score -= 15;
    if (candidate.risk.writes) reasons.push("会写入文件或外部系统");
    else reasons.push("只读");
    if (candidate.risk.level === "high") reasons.push("高风险，安装需显式放行");
    const requirementBlock = requirementBlocksDefault(candidate);
    if (requirementBlock !== undefined) reasons.push(requirementBlock);

    const rounded = Math.round(clamp(score, 0, 100));
    ranked.push({
      candidate,
      score: rounded,
      confidence: rounded >= 70 ? "high" : rounded >= 45 ? "medium" : "low",
      reasons: unique(reasons),
      defaultSelected: false,
      missingCredentials,
      defaultBlockedBy: blockedBy === undefined ? [] : [blockedBy]
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const riskOrder = { low: 0, medium: 1, high: 2 };
    const riskDelta = riskOrder[left.candidate.risk.level] - riskOrder[right.candidate.risk.level];
    if (riskDelta !== 0) return riskDelta;
    const weightDelta = (right.candidate.weight ?? 0.5) - (left.candidate.weight ?? 0.5);
    if (weightDelta !== 0) return weightDelta;
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  const top = ranked.slice(0, topN);
  const usedGroups = new Set<string>();
  let defaults = 0;
  for (const entry of top) {
    const relevant = entry.candidate.domains.some((domain) => intent.domains.includes(domain))
      || entry.candidate.tasks.some((task) => intent.tasks.includes(task));
    if (!relevant) {
      entry.defaultBlockedBy = unique([...entry.defaultBlockedBy, "与当前任务没有明确匹配"]);
      continue;
    }
    const base = baseEligibility(entry.candidate);
    if (base !== undefined) {
      entry.defaultBlockedBy = unique([...entry.defaultBlockedBy, base]);
      continue;
    }
    if (entry.defaultBlockedBy.length > 0) continue;
    const group = entry.candidate.group ?? `__${entry.candidate.id}`;
    if (usedGroups.has(group)) {
      entry.defaultBlockedBy = unique([...entry.defaultBlockedBy, "同类能力已有默认选项"]);
      continue;
    }
    if (defaults >= maxDefaults) {
      entry.defaultBlockedBy = unique([...entry.defaultBlockedBy, "为控制上下文，默认只勾选有限项"]);
      continue;
    }
    entry.defaultSelected = true;
    usedGroups.add(group);
    defaults += 1;
  }
  return top;
}

export function rankCandidates(intent: Intent, candidates: Candidate[], options: RankOptions = {}): RankedCandidate[] {
  return rankCandidatesWithBoosts(intent, candidates, options, new Map());
}
