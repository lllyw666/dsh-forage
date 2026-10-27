import type { Candidate, DeploymentCommand, EffectiveBackend, Scope } from "../types.js";

function quoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Build the argv for dsh-install, or the local writer's display label. */
export function buildDeploymentCommand(
  candidate: Candidate,
  scope: Scope,
  backend: EffectiveBackend = "dsh-install",
  verb: "add" | "update" = "add"
): DeploymentCommand | null {
  if (candidate.install.method === "builtin") return null;
  const install = candidate.install;
  const label = `${candidate.name} (${install.kind.toUpperCase()})`;

  if (backend === "local") {
    const target = install.kind === "mcp" ? install.server : (install.name ?? install.source);
    return {
      kind: install.kind,
      backend: "local",
      label,
      command: "local",
      args: [],
      display: `local: write ${scope} ${install.kind} ${target}`
    };
  }

  let args: string[];
  if (install.kind === "mcp") {
    args = [
      "--profile", "install",
      "mcp", verb, install.server,
      "--scope", scope,
      "--transport", install.transport
    ];
    if (install.transport === "http") {
      args.push("--url", install.url ?? "");
      for (const key of install.env ?? []) args.push("-e", key);
      for (const header of install.headers ?? []) args.push("--header", header);
    } else {
      for (const key of install.env ?? []) args.push("-e", key);
      if (install.cwd !== undefined) args.push("--cwd", install.cwd);
      if (install.timeoutMs !== undefined) args.push("--timeout", String(install.timeoutMs));
      args.push("--", install.command ?? "", ...(install.args ?? []));
    }
  } else if (verb === "update") {
    args = ["--profile", "install", "skills", "update", install.name ?? candidate.id, install.source];
    if (install.link === true) args.push("--link");
  } else {
    args = ["--profile", "install", "skills", "add", install.source, "--scope", scope];
    if (install.name !== undefined) args.push("--name", install.name);
    if (install.link === true) args.push("--link");
  }
  return {
    kind: install.kind,
    backend: "dsh-install",
    label,
    command: "dsh",
    args,
    display: ["dsh", ...args].map(quoteForDisplay).join(" ")
  };
}
