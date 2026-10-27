import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DeploymentRunner, RunResult } from "../types.js";

export class DshNotFoundError extends Error {
  readonly fix: string;
  override name = "DshNotFoundError";

  constructor(bin: string, fix: string) {
    super(`找不到 dsh 可执行文件：${bin}`);
    this.fix = fix;
  }
}

export interface DshInstallClientOptions {
  dshBin?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

interface ResolvedCommand {
  executable: string;
  prefixArgs: string[];
  useCmdWrapper: boolean;
}

const MAX_CAPTURED_OUTPUT = 256 * 1024;
const CMD_UNSAFE = /["%!^&|<>\r\n\u0000]/;

function executableExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((entry) => entry.trim()).filter(Boolean);
}

function findOnPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(path.delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const names = [bin];
  if (platform === "win32" && path.extname(bin) === "") {
    names.push(...executableExtensions(env, platform).map((ext) => bin + ext.toLowerCase()));
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // Continue searching.
        }
      }
    }
  }
  return undefined;
}

export function resolveDshCommand(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform
): ResolvedCommand {
  const hasSeparator = bin.includes("/") || bin.includes("\\");
  let resolved = hasSeparator ? path.resolve(cwd, bin) : undefined;
  if (resolved !== undefined && !existsSync(resolved) && platform === "win32" && path.extname(resolved) === "") {
    for (const ext of executableExtensions(env, platform)) {
      if (existsSync(resolved + ext.toLowerCase())) {
        resolved += ext.toLowerCase();
        break;
      }
    }
  }
  if (resolved === undefined) resolved = findOnPath(bin, env, platform);
  if (resolved === undefined || !existsSync(resolved)) {
    throw new DshNotFoundError(
      bin,
      "安装 @dsh-tools/dsh-install 后确认 dsh 在 PATH 中，或用 --dsh-bin 指定可执行文件；也支持直接指向一个 .mjs 启动脚本。"
    );
  }
  const extension = path.extname(resolved).toLowerCase();
  if (platform === "win32" && extension === ".exe" && existsSync(path.join(path.dirname(resolved), "resources", "app.asar"))) {
    throw new DshNotFoundError(
      resolved,
      "这是 DSH 桌面端的 GUI 可执行文件，不是 CLI。请改用 ~/.dsh/bin/dsh.cmd，或把 --dsh-bin 指向 dsh-desktop-host/lib/cli.js（.mjs 启动脚本）。"
    );
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { executable: process.execPath, prefixArgs: [resolved], useCmdWrapper: false };
  }
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    return {
      executable: env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: [resolved],
      useCmdWrapper: true
    };
  }
  if (platform === "win32" && extension === ".ps1") {
    throw new DshNotFoundError(
      resolved,
      "不能直接启动 .ps1 形式的 dsh；请指向 npm 生成的 dsh.cmd，或设置 --dsh-bin 为 .mjs/.exe。"
    );
  }
  return { executable: resolved, prefixArgs: [], useCmdWrapper: false };
}

function quoteCmd(value: string): string {
  if (CMD_UNSAFE.test(value)) {
    throw new DshNotFoundError(
      value,
      "Windows 的 dsh.cmd 启动器无法安全接收包含双引号、百分号、感叹号、脱字符、与号、管道、重定向或换行的参数；请改用 .mjs 启动脚本或去掉这些字符。"
    );
  }
  return `"${value}"`;
}

function buildCmdLine(resolved: ResolvedCommand, args: string[]): string {
  const all = [...resolved.prefixArgs, ...args];
  return `"${all.map(quoteCmd).join(" ")}"`;
}

export class DshInstallClient implements DeploymentRunner {
  private readonly bin: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly defaultTimeoutMs: number;
  private resolved: ResolvedCommand | undefined;

  constructor(options: DshInstallClientOptions) {
    this.bin = options.dshBin ?? options.env?.DSH_FORAGE_DSH_BIN ?? "dsh";
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.defaultTimeoutMs = options.timeoutMs ?? 180_000;
  }

  resolve(): ResolvedCommand {
    if (this.resolved === undefined) {
      this.resolved = resolveDshCommand(this.bin, this.env, this.cwd, this.platform);
    }
    return this.resolved;
  }

  async run(args: string[], timeoutMs = this.defaultTimeoutMs): Promise<RunResult> {
    const started = Date.now();
    let resolved: ResolvedCommand;
    try {
      resolved = this.resolve();
    } catch (error) {
      return {
        code: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      };
    }

    let command = resolved.executable;
    let spawnArgs: string[];
    let windowsVerbatimArguments = false;
    if (resolved.useCmdWrapper) {
      try {
        const line = buildCmdLine(resolved, args);
        command = resolved.executable;
        spawnArgs = ["/d", "/s", "/v:off", "/c", line];
        windowsVerbatimArguments = true;
      } catch (error) {
        return {
          code: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started
        };
      }
    } else {
      spawnArgs = [...resolved.prefixArgs, ...args];
    }

    const env: NodeJS.ProcessEnv = { ...this.env };
    if (!resolved.useCmdWrapper && resolved.prefixArgs.length > 0) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }

    return await new Promise<RunResult>((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(command, spawnArgs, {
        cwd: this.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments
      });

      const append = (current: string, chunk: Buffer | string): string => {
        if (current.length >= MAX_CAPTURED_OUTPUT) return current;
        const next = current + chunk.toString();
        return next.length > MAX_CAPTURED_OUTPUT ? next.slice(0, MAX_CAPTURED_OUTPUT) : next;
      };

      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, Math.max(1000, timeoutMs));
      timer.unref?.();

      const finish = (exitCode: number | null, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          code: exitCode,
          stdout,
          stderr,
          error,
          timedOut,
          durationMs: Date.now() - started
        });
      };

      child.on("error", (error) => finish(null, error.message));
      child.on("close", (exitCode) => {
        if (timedOut) finish(exitCode, `命令超时（${timeoutMs}ms）`);
        else finish(exitCode);
      });
    });
  }
}
