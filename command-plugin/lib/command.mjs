const HELP = [
  "/forage <task>        plan capabilities for a task",
  "/forage github <task>  also search GitHub for skills/MCPs (unverified, high risk)",
  "/forage status       installed MCPs and Skills",
  "/forage doctor       DSH environment check",
  "/forage catalog [domain]",
  "/forage software <name>",
  "/forage help",
  "",
  "Install / remove / update require explicit approval:",
  "use dsh-forage in a terminal, or ask the agent to run it."
].join("\n");

export function parseForageInput(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (input === "" || input === "?" || input === "help") return { action: "help" };
  const [head, ...rest] = input.split(/\s+/);
  const tail = rest.join(" ").trim();
  if (head === "status" || head === "doctor") {
    return tail === "" ? { action: head } : { action: "help", error: "/forage " + head + " takes no arguments" };
  }
  if (head === "catalog") return { action: "catalog", domain: tail };
  if (head === "software") {
    return tail === "" ? { action: "help", error: "用法：/forage software <name>" } : { action: "software", name: tail };
  }
  if (head === "github") {
    return tail === "" ? { action: "help", error: "用法：/forage github <task>" } : { action: "github", task: tail };
  }
  if (head === "plan") {
    return tail === "" ? { action: "help", error: "用法：/forage plan <task>" } : { action: "plan", task: tail };
  }
  if (head === "deploy" || head === "install" || head === "remove" || head === "update") {
    return { action: "unsupported", command: head };
  }
  if (head.startsWith("-")) return { action: "help", error: "未知选项：" + head };
  return { action: "plan", task: input };
}

function riskLabel(risk) {
  const level = risk?.level ?? "unknown";
  const extra = risk?.writes ? ", writes" : "";
  return level + extra;
}

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

export function formatPlan(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const local = Array.isArray(payload?.localMatches) ? payload.localMatches : [];
  const lines = ["Forage plan" + (payload?.intent?.query ? " · " + payload.intent.query : ""), ""];
  if (local.length > 0) {
    lines.push("Local installed matches — ask the user before searching alternatives:");
    for (const match of local) lines.push("- " + match.kind + " " + match.name + " (" + match.scope + ", " + String(match.score) + ")");
    lines.push("Use local? If no, rerun with --no-local; or type your own combination in chat.", "");
  }
  if (candidates.length === 0) {
    lines.push(local.length > 0 ? "No new candidates matched." : "No candidates matched. Try a more concrete task or /forage catalog.");
    return lines.join("\n");
  }
  candidates.forEach((candidate, index) => {
    const bits = ["#" + String(index + 1), candidate.id, "—", String(candidate.score ?? 0) + " 分", "·", riskLabel(candidate.risk)];
    if (candidate.installedInScope) bits.push("· installed " + candidate.installedInScope);
    if (candidate.defaultSelected) bits.push("· default");
    lines.push(bits.join(" "));
    if (candidate.description) lines.push("   " + truncate(candidate.description, 100));
    if (candidate.discovery) {
      const source = candidate.discovery.repo ?? candidate.discovery.url ?? "unknown";
      const quality = candidate.discovery.quality !== undefined ? "quality " + String(candidate.discovery.quality) : String(candidate.discovery.stars ?? 0) + " stars";
      lines.push("   source: " + source + " · " + candidate.discovery.source + " · " + quality + " · priority " + String(candidate.discovery.sourcePriority ?? "?"));
    }
    if (candidate.defaultBlockedBy?.length) lines.push("   blocked: " + truncate(candidate.defaultBlockedBy.join(" / "), 120));
  });
  lines.push("", "Next: dsh-forage deploy --id <id> --scope user|project --yes");
  if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of payload.warnings) lines.push("- " + warning);
  }
  return lines.join("\n");
}

export function formatSoftware(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) return "No matching software. Search the vendor site and verify the license.";
  const lines = ["Software prerequisites"];
  for (const entry of results) {
    lines.push("", entry.name + " — " + entry.license);
    lines.push("  " + entry.purpose);
    if (entry.official) lines.push("  official: " + entry.official.url);
    for (const option of entry.freeOptions ?? []) lines.push("  free/alternative: " + option.name + " — " + option.url);
    lines.push("  search: https://www.google.com/search?q=" + encodeURIComponent(entry.searchQuery));
  }
  lines.push("", "Only official/open-source links; no cracked builds or netdisk binaries.");
  return lines.join("\n");
}

export function formatStatus(payload) {
  const mcps = Array.isArray(payload?.mcps) ? payload.mcps : [];
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  const summary = payload?.summary ?? {};
  const lines = [
    "Forage status",
    "user: " + String(summary.userMcps ?? 0) + " MCP / " + String(summary.userSkills ?? 0) + " skill",
    "project: " + String(summary.projectMcps ?? 0) + " MCP / " + String(summary.projectSkills ?? 0) + " skill",
    "session: " + String(summary.sessionMcps ?? 0) + " MCP"
  ];
  for (const item of [...mcps, ...skills]) {
    lines.push("- " + item.scope + " " + item.kind + ": " + item.name);
  }
  if (lines.length === 4) lines.push("(nothing installed)");
  if (payload?.projectRoot === null) lines.push("", "No .git in this directory; project scope unavailable.");
  return lines.join("\n");
}

export function formatDoctor(payload) {
  const summary = payload?.summary ?? {};
  const lines = [
    "Forage doctor",
    "ok " + String(summary.ok ?? 0) + " / warn " + String(summary.warn ?? 0) + " / error " + String(summary.error ?? 0)
  ];
  for (const check of Array.isArray(payload?.checks) ? payload.checks : []) {
    if (check.level === "ok") continue;
    lines.push("- " + check.level + " " + check.id + ": " + check.message);
    if (check.fix) lines.push("  fix: " + check.fix);
  }
  return lines.join("\n");
}

export function formatCatalog(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const lines = ["Forage catalog" + (payload?.domain ? " · " + payload.domain : ""), ""];
  for (const candidate of candidates) lines.push("- " + candidate.id + " — " + candidate.name);
  if (candidates.length === 0) lines.push("(empty)");
  return lines.join("\n");
}

function failure(result) {
  const detail = String(result?.stderr ?? "").trim();
  return { kind: "error", text: detail === "" ? "dsh-forage exited with code " + String(result?.code) : detail.slice(0, 1200) };
}

export async function executeForageCommand(rawInput, options = {}) {
  const parsed = parseForageInput(rawInput);
  if (parsed.error) return { kind: "error", text: parsed.error + "\n\n" + HELP };
  if (parsed.action === "help") return { kind: "success", text: HELP };
  if (parsed.action === "unsupported") {
    return {
      kind: "error",
      text: "/forage is read-only. Use dsh-forage " + parsed.command + " in a terminal so the approval gate is explicit."
    };
  }
  const run = options.run;
  if (typeof run !== "function") throw new TypeError("executeForageCommand needs a run function");
  const args = parsed.action === "plan"
    ? ["plan", parsed.task, "--json", "--top", "5"]
    : parsed.action === "github"
      ? ["plan", parsed.task, "--github", "--json", "--top", "5"]
      : parsed.action === "catalog"
      ? ["catalog", ...(parsed.domain ? [parsed.domain] : []), "--json"]
      : parsed.action === "software"
      ? ["software", parsed.name, "--json"]
      : [parsed.action, "--json"];
  const result = await run(args, { signal: options.signal });
  if (result?.code !== 0) return failure(result);
  let payload;
  try {
    payload = JSON.parse(String(result.stdout ?? ""));
  } catch {
    return { kind: "error", text: "dsh-forage returned invalid JSON." };
  }
  if (parsed.action === "plan" || parsed.action === "github") return { kind: "success", text: formatPlan(payload) };
  if (parsed.action === "status") return { kind: "success", text: formatStatus(payload) };
  if (parsed.action === "doctor") return { kind: "success", text: formatDoctor(payload) };
  if (parsed.action === "software") return { kind: "success", text: formatSoftware(payload) };
  return { kind: "success", text: formatCatalog(payload) };
}

export { HELP };
