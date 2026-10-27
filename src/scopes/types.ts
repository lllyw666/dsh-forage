import type { Scope } from "../types.js";

export class ScopeError extends Error {
  readonly code: string;
  readonly fix: string;
  override name = "ScopeError";

  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export interface ScopeContext {
  cwd: string;
  dshHome: string;
  projectRoot?: string;
  userMcpPath: string;
  projectMcpPath?: string;
  sessionMcpPath: string;
  sessionId?: string;
  userSkillsRoot: string;
  projectSkillsRoot?: string;
  skillsManifestPath: string;
}

export type McpTransport = "stdio" | "http" | "streamable-http";

export type McpEnv = Record<string, string> | string[];

export interface McpEntry {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: string[] | Record<string, string>;
  env?: McpEnv;
  cwd?: string;
  toolCallTimeoutMs?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface McpRegistry {
  version?: number;
  servers: Record<string, McpEntry>;
}

export interface InstalledMcp {
  kind: "mcp";
  name: string;
  scope: Scope;
  path: string;
  entry: McpEntry;
  shadowedBy?: Scope;
}

export interface SkillInfo {
  kind: "skill";
  name: string;
  description: string;
  scope: Scope;
  root: string;
  path: string;
  sourcePath: string;
  bundle: boolean;
  shadowedBy?: Scope;
}

export interface InstalledItem {
  kind: "mcp" | "skill";
  name: string;
  description?: string;
  scope: Scope;
  path: string;
}

export interface TransferPlan {
  item: InstalledItem;
  sourceScope: Scope;
  targetScope: Scope;
  commands: string[];
  notes: string[];
}

export interface TransferResult {
  ok: boolean;
  item: InstalledItem;
  sourceScope: Scope;
  targetScope: Scope;
  status: "promoted" | "demoted" | "planned" | "failed";
  message: string;
  commands: string[];
  warnings: string[];
  fix?: string;
}

export interface SkillManifestRecord {
  source?: string;
  ref?: string;
  scope?: Scope;
  target?: string;
  installedAt?: string;
  origin?: { source?: string; addedAt?: string };
  [key: string]: unknown;
}

export interface SkillManifest {
  version: 1;
  skills: Record<string, SkillManifestRecord>;
}
