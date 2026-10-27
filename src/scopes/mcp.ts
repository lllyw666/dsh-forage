import { existsSync, readFileSync } from "node:fs";
import type { Scope } from "../types.js";
import { mcpPath } from "./paths.js";
import { ScopeError, type InstalledMcp, type McpEntry, type McpRegistry, type ScopeContext } from "./types.js";

const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

export function readMcpRegistry(file: string): McpRegistry {
  if (!existsSync(file)) return { version: 1, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ScopeError("MCP_REGISTRY_INVALID", "MCP 注册表不是合法 JSON：" + file, String(error));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ScopeError("MCP_REGISTRY_INVALID", "MCP 注册表根必须是对象：" + file, "修正 mcp.json 后重试。");
  }
  const record = parsed as Record<string, unknown>;
  if (record.servers === undefined) return { version: 1, servers: {} };
  if (typeof record.servers !== "object" || record.servers === null || Array.isArray(record.servers)) {
    throw new ScopeError("MCP_REGISTRY_INVALID", "MCP 注册表 servers 必须是对象：" + file, "修正 mcp.json 后重试。");
  }
  return { version: typeof record.version === "number" ? record.version : 1, servers: record.servers as Record<string, McpEntry> };
}

export function listMcps(ctx: ScopeContext): InstalledMcp[] {
  const user = readMcpRegistry(ctx.userMcpPath);
  const project = ctx.projectMcpPath === undefined ? { servers: {} } : readMcpRegistry(ctx.projectMcpPath);
  const session = readMcpRegistry(ctx.sessionMcpPath);
  const result: InstalledMcp[] = [];
  for (const [name, entry] of Object.entries(user.servers)) {
    const shadowedBy = session.servers[name] !== undefined ? "session" as Scope : project.servers[name] !== undefined ? "project" as Scope : undefined;
    result.push({ kind: "mcp", name, scope: "user", path: ctx.userMcpPath, entry, ...shadowedBy === undefined ? {} : { shadowedBy } });
  }
  if (ctx.projectMcpPath !== undefined) {
    for (const [name, entry] of Object.entries(project.servers)) {
      const shadowedBy = session.servers[name] === undefined ? undefined : "session" as Scope;
      result.push({ kind: "mcp", name, scope: "project", path: ctx.projectMcpPath, entry, ...shadowedBy === undefined ? {} : { shadowedBy } });
    }
  }
  for (const [name, entry] of Object.entries(session.servers)) {
    result.push({ kind: "mcp", name, scope: "session", path: ctx.sessionMcpPath, entry });
  }
  return result;
}

export function findMcp(ctx: ScopeContext, scope: Scope, name: string): InstalledMcp | undefined {
  return listMcps(ctx).find((item) => item.scope === scope && item.name === name);
}

export function envKeys(entry: McpEntry): string[] {
  const env = entry.env;
  if (env === undefined) return [];
  if (Array.isArray(env)) {
    for (const key of env) {
      if (typeof key !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new ScopeError("MCP_ENV_INVALID", "MCP 环境变量名非法。", "环境变量名必须是大写字母、数字和下划线。");
      }
    }
    return [...new Set(env)];
  }
  if (typeof env === "object" && env !== null) {
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new ScopeError("MCP_ENV_INVALID", "MCP 环境变量名非法：" + key, "环境变量名必须是大写字母、数字和下划线。");
      }
      if (typeof value !== "string" || (value !== "" && !ENV_REFERENCE.test(value))) {
        throw new ScopeError(
          "MCP_ENV_LITERAL",
          "MCP 环境变量 " + key + " 不是环境变量引用，无法安全迁移。",
          "把项目 mcp.json 里的值改成环境变量引用（例如以美元符号和大括号包裹的 KEY），或手动处理该条目。"
        );
      }
    }
    return Object.keys(env);
  }
  throw new ScopeError("MCP_ENV_INVALID", "MCP env 必须是对象或字符串数组。", "修正 mcp.json 后重试。");
}

function headerLines(entry: McpEntry): string[] {
  const headers = entry.headers;
  if (headers === undefined) return [];
  if (Array.isArray(headers)) {
    return headers.filter((header): header is string => typeof header === "string");
  }
  if (typeof headers === "object" && headers !== null) {
    return Object.entries(headers).map(([key, value]) => key + ": " + String(value));
  }
  throw new ScopeError("MCP_HEADERS_INVALID", "MCP headers 必须是字符串数组或对象。", "修正 mcp.json 后重试。");
}

export function mcpAddArgs(name: string, entry: McpEntry, scope: Scope): string[] {
  const transport = entry.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "http" && transport !== "streamable-http") {
    throw new ScopeError("MCP_TRANSPORT_INVALID", "未知 MCP transport：" + String(transport), "只支持 stdio、http 或 streamable-http。");
  }
  const cliTransport = transport === "streamable-http" ? "http" : transport;
  const args = ["--profile", "install", "mcp", "add", name, "--scope", scope, "--transport", cliTransport];
  const keys = envKeys(entry);
  if (cliTransport === "http") {
    if (typeof entry.url !== "string" || entry.url === "") {
      throw new ScopeError("MCP_ENTRY_INVALID", "HTTP MCP 缺少 url。", "修正 mcp.json 后重试。");
    }
    args.push("--url", entry.url);
    for (const key of keys) args.push("-e", key);
    for (const header of headerLines(entry)) args.push("--header", header);
    return args;
  }
  if (typeof entry.command !== "string" || entry.command === "") {
    throw new ScopeError("MCP_ENTRY_INVALID", "stdio MCP 缺少 command。", "修正 mcp.json 后重试。");
  }
  for (const key of keys) args.push("-e", key);
  if (typeof entry.cwd === "string" && entry.cwd !== "") args.push("--cwd", entry.cwd);
  if (typeof entry.toolCallTimeoutMs === "number" && entry.toolCallTimeoutMs > 0) {
    args.push("--timeout", String(entry.toolCallTimeoutMs));
  }
  args.push("--", entry.command);
  if (Array.isArray(entry.args)) {
    for (const arg of entry.args) if (typeof arg === "string") args.push(arg);
  }
  return args;
}

export function mcpRemoveArgs(name: string, scope: Scope): string[] {
  return ["--profile", "install", "mcp", "remove", name, "--scope", scope];
}

export function mcpOffArgs(name: string, scope: Scope): string[] {
  return ["--profile", "install", "mcp", "off", name, "--scope", scope];
}

export function commandDisplay(args: string[]): string {
  return ["dsh", ...args].map((value) => /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value)).join(" ");
}

export function mcpLabel(entry: McpEntry): string {
  if (entry.transport === "http" || entry.transport === "streamable-http") return entry.url ?? "http";
  const command = entry.command ?? "";
  const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
  return (command + " " + args).trim();
}

export function isMcpEnabled(entry: McpEntry): boolean {
  return entry.enabled !== false;
}
