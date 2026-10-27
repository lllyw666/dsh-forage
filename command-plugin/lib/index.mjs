import { spawn } from "node:child_process";
import { executeForageCommand } from "./command.mjs";

export const name = "forage-command";
export const inject = ["commands"];

function runCliFactory(config) {
  return function runCli(args, options = {}) {
    const cli = typeof config.cli === "string" && config.cli !== "" ? config.cli : process.env.DSH_FORAGE_CLI;
    if (typeof cli !== "string" || cli.trim() === "") {
      return Promise.reject(new Error("forage-command: set config.cli or DSH_FORAGE_CLI to dist/src/index.js"));
    }
    const node = typeof config.node === "string" && config.node !== "" ? config.node : process.execPath;
    const cwd = typeof config.cwd === "string" && config.cwd !== "" ? config.cwd : process.cwd();
    const timeoutMs = Number.isInteger(config.timeoutMs) ? Math.max(1000, Math.min(120000, config.timeoutMs)) : 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("forage-command timed out")), timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(node, [cli, ...args], {
          cwd,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      const chunks = [];
      const errors = [];
      let bytes = 0;
      const push = (list, chunk) => {
        bytes += chunk.length;
        if (bytes <= 2_000_000) list.push(chunk);
      };
      child.stdout.on("data", (chunk) => push(chunks, chunk));
      child.stderr.on("data", (chunk) => push(errors, chunk));
      const finish = (callback) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8")
      })));
    });
  };
}

export function apply(ctx, config = {}) {
  const run = runCliFactory(config);
  const handler = async (invocation) => {
    try {
      return await executeForageCommand(invocation.rawInput, { run, signal: invocation.signal });
    } catch (error) {
      return { kind: "error", text: "forage-command: " + String(error instanceof Error ? error.message : error) };
    }
  };
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "forage",
      description: "Plan or inspect DSH capabilities (read-only)",
      input: { hint: "<task> | status | doctor | catalog [domain] | software <name> | help" },
      handler
    });
  }, "forage-command lifecycle");
}
