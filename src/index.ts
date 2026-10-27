#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli/main.js";

export { runCli, defaultCliContext, type CliContext } from "./cli/main.js";
export { parseArgs, helpText, CliUsageError, type CliOptions } from "./cli/args.js";
export { runDoctor } from "./cli/doctor.js";
export type { DoctorCheck, DoctorLevel, DoctorReport } from "./cli/doctor.js";
export { parseIntent, parseIntentJson, IntentError, DOMAIN_LABELS } from "./intent/parser.js";
export { INTENT_SCHEMA_PROMPT } from "./intent/prompts.js";
export { rankCandidates } from "./ranker/index.js";
export { loadCatalog, findPackageRoot, packageVersion } from "./catalog/loader.js";
export { CatalogError } from "./catalog/schema.js";
export { deployCandidates, DeployPreflightError, findGitRoot } from "./deploy/orchestrator.js";
export { buildDeploymentCommand } from "./deploy/command.js";
export { scopeContext, resolveDshHome, findProjectRoot } from "./scopes/paths.js";
export { buildStatus } from "./scopes/status.js";
export { transferItem, previewTransfer } from "./scopes/transfer.js";
export { ScopeError } from "./scopes/types.js";
export type {
  Candidate,
  CatalogFile,
  DeployReport,
  DeployResult,
  DeployStatus,
  DeploymentCommand,
  Intent,
  RankedCandidate,
  Risk,
  Scope
} from "./types.js";
export type {
  ScopeContext,
  McpEntry,
  InstalledItem,
  TransferPlan,
  TransferResult
} from "./scopes/types.js";
export type { StatusPayload, StatusMcp, StatusSkill } from "./scopes/status.js";

function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(path.resolve(invoked));
    return process.platform === "win32"
      ? modulePath.toLowerCase() === invokedPath.toLowerCase()
      : modulePath === invokedPath;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
