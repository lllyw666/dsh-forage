import { mkdirSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { planMounts } from "./plan.mjs";

/** Cordis plugin name used by loader diagnostics. */
export const name = "forage-mcp-registry";
/** The MCP client publishes its tools through the tools service. */
export const inject = ["tools"];

function log(ctx, level, message) {
  try {
    ctx.logger?.[level]?.(message);
  } catch {
    // Logging must never break the host.
  }
}

function configId(target) {
  return JSON.stringify([target.scope, target.config]);
}

/**
 * Cordis apply hook: mount enabled MCP servers, watch the user/project
 * registries, and keep the mounted set in sync. Install/remove/audit remain
 * the CLI's job; this plugin only reads mcp.json and projects it onto
 * mcp-client children. Mount failures are logged and never fail the host.
 */
export async function apply(ctx, config = {}) {
  const state = new Map();
  const watched = [];
  const watchIntervalMs = Number.isInteger(config.watchIntervalMs)
    ? Math.max(50, Math.min(60000, config.watchIntervalMs))
    : 500;
  let disposed = false;
  let timer;
  let chain = Promise.resolve();
  const cwd = typeof config.cwd === "string" && config.cwd !== "" ? config.cwd : process.cwd();
  const home = typeof config.dshHome === "string" && config.dshHome !== ""
    ? path.resolve(config.dshHome)
    : typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
      ? path.resolve(process.env.DSH_HOME.trim())
      : path.join(os.homedir(), ".dsh");
  const sessionFile = path.join(home, "forage", "session-mcp.json");

  // A session overlay never survives a host/plugin reload. Recreate an empty
  // registry so the watcher can observe the file being created by the CLI.
  try {
    rmSync(sessionFile, { force: true });
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ version: 1, servers: {} }, null, 2) + "\n", "utf8");
  } catch (error) {
    log(ctx, "warn", "forage-mcp-registry: cannot reset session registry: " + String(error));
  }

  const disposeAll = async () => {
    for (const [serverName, record] of [...state]) {
      state.delete(serverName);
      try {
        await record.fiber.dispose();
      } catch (error) {
        log(ctx, "error", "forage-mcp-registry: dispose of " + serverName + " failed: " + String(error));
      }
    }
  };

  async function doSync() {
    if (disposed) return;
    let plan;
    try {
      plan = planMounts({ cwd, env: process.env, home });
    } catch (error) {
      log(ctx, "error", "forage-mcp-registry: cannot read mcp.json: " + String(error));
      return;
    }
    for (const warning of plan.warnings) log(ctx, "warn", "forage-mcp-registry: " + warning);
    const desired = new Map(plan.mounts.map((target) => [target.name, target]));
    for (const [serverName, record] of [...state]) {
      const target = desired.get(serverName);
      if (target !== undefined && configId(target) === record.id) continue;
      state.delete(serverName);
      try {
        await record.fiber.dispose();
        log(ctx, "info", "forage-mcp-registry: unmounted " + serverName + " (" + record.scope + ")");
      } catch (error) {
        log(ctx, "error", "forage-mcp-registry: dispose of " + serverName + " failed: " + String(error));
      }
    }
    for (const target of desired.values()) {
      if (state.has(target.name) || disposed) continue;
      try {
        const fiber = ctx.plugin(McpClient, target.config);
        await fiber;
        state.set(target.name, { fiber, id: configId(target), scope: target.scope });
        log(ctx, "info", "forage-mcp-registry: mounted " + target.name + " (" + target.scope + ")");
      } catch (error) {
        log(ctx, "error", "forage-mcp-registry: failed to mount " + target.name + ": " + String(error));
      }
    }
    if (desired.size === 0) log(ctx, "info", "forage-mcp-registry: no enabled MCP servers");
  }

  function sync() {
    const run = chain.then(doSync);
    chain = run.catch(() => void 0);
    return run;
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), 50);
  }

  let initial;
  try {
    initial = planMounts({ cwd, env: process.env, home });
  } catch (error) {
    log(ctx, "error", "forage-mcp-registry: cannot read mcp.json: " + String(error));
    initial = undefined;
  }

  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(timer);
    for (const file of watched) unwatchFile(file);
    try {
      rmSync(sessionFile, { force: true });
    } catch {
      // Session cleanup is best effort; the next start resets it anyway.
    }
    void disposeAll();
  }, "forage-mcp-registry.mounts");

  if (config.watch !== false && initial !== undefined) {
    for (const file of [initial.userFile, initial.projectFile, initial.sessionFile]) {
      if (typeof file !== "string" || file === "") continue;
      try {
        watchFile(file, { interval: watchIntervalMs, persistent: false }, schedule);
        watched.push(file);
      } catch (error) {
        log(ctx, "warn", "forage-mcp-registry: cannot watch " + file + ": " + String(error));
      }
    }
  }

  await sync();
}
