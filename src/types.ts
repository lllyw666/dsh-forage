export type Scope = "user" | "project" | "session";

export type RiskLevel = "low" | "medium" | "high";

export type CapabilityType = "mcp" | "skill" | "builtin";

export type Transport = "stdio" | "http";

export type DeployBackend = "auto" | "local" | "dsh-install";

export type EffectiveBackend = "local" | "dsh-install";

export type RequirementKind =
  | "desktop-app"
  | "runtime"
  | "network"
  | "manual-setup";

export interface Risk {
  level: RiskLevel;
  writes: boolean;
  external_requests: boolean;
  sensitive_permissions: boolean;
}

export interface Requirement {
  kind: RequirementKind;
  label: string;
  hint?: string;
}

export interface McpInstallSpec {
  method: "dsh-install";
  kind: "mcp";
  server: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: string[];
  env?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface SkillInstallSpec {
  method: "dsh-install";
  kind: "skill";
  source: string;
  name?: string;
  link?: boolean;
}

export interface BuiltinInstallSpec {
  method: "builtin";
  provides: string[];
}

export type InstallSpec = McpInstallSpec | SkillInstallSpec | BuiltinInstallSpec;

export interface Candidate {
  id: string;
  type: CapabilityType;
  name: string;
  description: string;
  domains: string[];
  tasks: string[];
  tools: string[];
  toolCount?: number;
  risk: Risk;
  credentials: string[];
  requires?: Requirement[];
  install: InstallSpec;
  group?: string;
  weight?: number;
  homepage?: string;
  sourceRepo?: string;
  license?: string;
  packageVersion?: string;
  verifiedAt?: string;
  notes?: string[];
  discovery?: {
    source: "github" | "registry" | "skills.sh";
    repo?: string;
    url: string;
    stars?: number;
    installs?: number;
    quality?: number;
    packageVerified?: boolean;
    sourcePriority?: number;
    query: string;
    verified: false;
  };
}

export interface CatalogFile {
  schemaVersion: 1;
  domain: string;
  title?: string;
  capabilities: Candidate[];
}

export interface CatalogLoadResult {
  capabilities: Candidate[];
  files: string[];
}

export interface Intent {
  tasks: string[];
  domains: string[];
  signals: string[];
  constraints: string[];
  confidence: number;
  locale: "zh" | "en" | "mixed";
}

export interface RankedCandidate {
  candidate: Candidate;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  defaultSelected: boolean;
  missingCredentials: string[];
  defaultBlockedBy: string[];
}

export interface DeploymentCommand {
  kind: "mcp" | "skill";
  backend: EffectiveBackend;
  label: string;
  command: string;
  args: string[];
  display: string;
}

export type DeployStatus =
  | "installed"
  | "failed"
  | "skipped"
  | "available"
  | "planned";

export interface DeployResult {
  id: string;
  name: string;
  status: DeployStatus;
  message: string;
  fix?: string;
  command?: string;
  backend?: EffectiveBackend;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface DeploySummary {
  total: number;
  installed: number;
  failed: number;
  skipped: number;
  available: number;
  planned: number;
}

export interface DeployReport {
  scope: Scope;
  backend: EffectiveBackend;
  dryRun: boolean;
  results: DeployResult[];
  summary: DeploySummary;
  exitCode: number;
  warnings: string[];
  rollback?: { attempted: boolean; restored: boolean; backup?: string; message: string };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
  durationMs: number;
}

export interface DeploymentRunner {
  run(args: string[], timeoutMs: number): Promise<RunResult>;
}
