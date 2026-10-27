import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 60000;

function dshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return path.resolve(configured.trim());
  return path.join(os.homedir(), ".dsh");
}

function findProjectRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    try {
      if (existsSync(path.join(current, ".git")) && statSync(path.join(current, ".git")).isDirectory()) return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readRegistry(file) {
  if (!existsSync(file)) return { version: 1, servers: {} };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(file + ": registry must be a JSON object");
  if (raw.version !== 1) throw new Error(file + ": unsupported registry version " + JSON.stringify(raw.version));
  if (typeof raw.servers !== "object" || raw.servers === null || Array.isArray(raw.servers)) {
    throw new Error(file + ": servers must be an object");
  }
  return raw;
}

function expandValue(value, env, missing) {
  let failed = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (env[key] === undefined) {
      failed = true;
      missing.add(key);
      return "";
    }
    return env[key];
  });
  return failed ? undefined : expanded;
}

function expandRecord(record, env, missing) {
  const out = {};
  if (Array.isArray(record)) {
    for (const key of record) {
      if (typeof key !== "string") continue;
      if (env[key] === undefined) {
        missing.add(key);
        continue;
      }
      out[key] = env[key];
    }
    return out;
  }
  if (typeof record !== "object" || record === null) return out;
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== "string") continue;
    const value = expandValue(raw, env, missing);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeHeaders(headers, env, missing) {
  if (Array.isArray(headers)) {
    const out = {};
    for (const line of headers) {
      if (typeof line !== "string") continue;
      const index = line.indexOf(":");
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      const value = expandValue(line.slice(index + 1).trim(), env, missing);
      if (key !== "" && value !== undefined) out[key] = value;
    }
    return out;
  }
  return expandRecord(headers, env, missing);
}

function projectEntry(serverName, entry, env) {
  if (typeof entry !== "object" || entry === null || entry.enabled === false) return undefined;
  const timeout = Number.isInteger(entry.toolCallTimeoutMs) && entry.toolCallTimeoutMs > 0
    ? entry.toolCallTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (entry.transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.trim() === "") return undefined;
    const missing = new Set();
    return {
      config: {
        transport: "stdio",
        serverName,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.filter((value) => typeof value === "string") : [],
        env: expandRecord(entry.env, env, missing),
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        toolCallTimeoutMs: timeout,
        failOnStartupError: false
      },
      missing: [...missing]
    };
  }
  if (entry.transport === "streamable-http" || entry.transport === "http") {
    if (typeof entry.url !== "string" || entry.url.trim() === "") return undefined;
    const missing = new Set();
    return {
      config: {
        transport: "streamable-http",
        serverName,
        url: entry.url,
        headers: normalizeHeaders(entry.headers, env, missing),
        toolCallTimeoutMs: timeout,
        failOnStartupError: false
      },
      missing: [...missing]
    };
  }
  return undefined;
}

/**
 * Pure planning helper: read user/project registries, merge with project
 * shadowing, and return the mcp-client configs that should be mounted.
 * Exported for unit tests; the Cordis plugin uses it.
 */
export function planMounts(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? dshHome(env);
  const userFile = path.join(home, "mcp.json");
  const projectRoot = options.projectRoot === undefined ? findProjectRoot(cwd) : options.projectRoot;
  const projectFile = projectRoot === undefined ? undefined : path.join(projectRoot, ".dsh", "mcp.json");
  const sessionFile = path.join(home, "forage", "session-mcp.json");
  const user = readRegistry(userFile);
  const project = projectFile === undefined ? { servers: {} } : readRegistry(projectFile);
  const session = readRegistry(sessionFile);
  const merged = new Map();
  for (const [serverName, entry] of Object.entries(user.servers)) merged.set(serverName, { entry, scope: "user" });
  for (const [serverName, entry] of Object.entries(project.servers)) merged.set(serverName, { entry, scope: "project" });
  for (const [serverName, entry] of Object.entries(session.servers)) merged.set(serverName, { entry, scope: "session" });
  const mounts = [];
  const warnings = [];
  for (const [serverName, target] of merged) {
    if (!SERVER_NAME.test(serverName)) {
      warnings.push("skip " + JSON.stringify(serverName) + ": invalid server name");
      continue;
    }
    if (typeof target.entry !== "object" || target.entry === null || target.entry.enabled === false) continue;
    const projected = projectEntry(serverName, target.entry, env);
    if (projected === undefined) {
      warnings.push("skip " + serverName + ": unsupported or incomplete entry");
      continue;
    }
    if (projected.missing.length > 0) {
      warnings.push(serverName + ": missing env " + projected.missing.join(", "));
    }
    mounts.push({ name: serverName, scope: target.scope, config: projected.config, missing: projected.missing });
  }
  return { mounts, warnings, userFile, projectFile, sessionFile };
}
