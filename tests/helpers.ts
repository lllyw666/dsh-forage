import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { findPackageRoot, loadCatalog } from "../src/catalog/loader.js";

export const PACKAGE_ROOT = findPackageRoot();
export const CLI_ENTRY = path.join(PACKAGE_ROOT, "dist", "src", "index.js");
export const FIXTURE_CATALOG = path.join(PACKAGE_ROOT, "tests", "fixtures", "catalog");
export const FAKE_DSH = path.join(PACKAGE_ROOT, "tests", "fixtures", "fake-dsh.mjs");

export function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", DSH_FORAGE_DISCOVERY: "off", DSH_FORAGE_HEALTH_CHECK: "off", ...extra };
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: cliEnv(options.env),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
}

export async function loadRealCatalog() {
  return loadCatalog({ packageRoot: PACKAGE_ROOT, cwd: PACKAGE_ROOT, includeProjectCatalog: false });
}

export async function loadFixtureCatalog() {
  return loadCatalog({
    packageRoot: PACKAGE_ROOT,
    cwd: PACKAGE_ROOT,
    extraPaths: [FIXTURE_CATALOG],
    includeProjectCatalog: false
  });
}

export function fixtureCandidates() {
  return loadFixtureCatalog().then((catalog) =>
    catalog.capabilities.filter((candidate) => candidate.id.startsWith("fake-"))
  );
}
