import { spawn } from "node:child_process";
import type { McpInstallSpec } from "../types.js";

export interface HealthCheckResult {
  ok: boolean;
  tools: string[];
  message: string;
  durationMs: number;
}

function expandEnv(install: McpInstallSpec, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of install.env ?? []) {
    const name = key.replace(/^\$\{/, "").replace(/\}$/, "");
    if (result[name] === undefined) result[name] = "";
  }
  return result;
}

function parseJsonLine(line: string): unknown {
  const value = line.trim();
  if (value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toolNames(response: unknown): string[] {
  if (response === null || typeof response !== "object") return [];
  const result = (response as { result?: unknown }).result;
  if (result === null || typeof result !== "object") return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => tool !== null && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? (tool as { name: string }).name
      : undefined)
    .filter((name): name is string => name !== undefined)
    .slice(0, 20);
}

async function checkStdio(install: McpInstallSpec, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<HealthCheckResult> {
  const started = Date.now();
  const command = install.command;
  if (command === undefined || command === "") {
    return { ok: false, tools: [], message: "stdio MCP 缺少 command。", durationMs: 0 };
  }
  return await new Promise((resolve) => {
    const child = spawn(command, install.args ?? [], {
      cwd: install.cwd === undefined || install.cwd === "" ? undefined : install.cwd,
      env: expandEnv(install, env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HealthCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* best effort */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      tools: [],
      message: "MCP health check 超时（" + String(Math.round(timeoutMs / 1000)) + "s）。",
      durationMs: Date.now() - started
    }), timeoutMs);

    child.stdin.on("error", () => { /* server may exit after handshake */ });
    const send = (message: unknown): void => {
      if (settled) return;
      try { child.stdin.write(JSON.stringify(message) + "\n"); } catch { /* reported on close */ }
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dsh-forage-health", version: "0.2.0" }
      }
    });

    const inspect = (): void => {
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseJsonLine(line) as { id?: number; result?: unknown; error?: unknown } | undefined;
        if (parsed === undefined) continue;
        if (parsed.id === 1) {
          if (parsed.error !== undefined) {
            finish({ ok: false, tools: [], message: "initialize 失败：" + JSON.stringify(parsed.error).slice(0, 300), durationMs: Date.now() - started });
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (parsed.id === 2) {
          if (parsed.error !== undefined) {
            finish({ ok: false, tools: [], message: "tools/list 失败：" + JSON.stringify(parsed.error).slice(0, 300), durationMs: Date.now() - started });
            return;
          }
          const tools = toolNames(parsed);
          finish({ ok: true, tools, message: "MCP initialize + tools/list 成功（" + String(tools.length) + " 个工具）", durationMs: Date.now() - started });
          return;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      inspect();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, tools: [], message: "无法启动 MCP：" + String(error), durationMs: Date.now() - started }));
    child.on("close", (code) => {
      if (settled) return;
      finish({
        ok: false,
        tools: [],
        message: "MCP 进程在握手前退出（code " + String(code) + "）：" + stderr.trim().slice(0, 400),
        durationMs: Date.now() - started
      });
    });
  });
}

async function checkHttp(install: McpInstallSpec, timeoutMs: number): Promise<HealthCheckResult> {
  const started = Date.now();
  if (install.url === undefined || install.url === "") {
    return { ok: false, tools: [], message: "HTTP MCP 缺少 url。", durationMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(install.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dsh-forage-health", version: "0.2.0" }
        }
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, tools: [], message: "HTTP MCP initialize 失败：HTTP " + String(response.status) + " " + text.slice(0, 300), durationMs: Date.now() - started };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (data !== undefined) {
        try { parsed = JSON.parse(data.slice(5).trim()); } catch { parsed = undefined; }
      }
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { error?: unknown }).error !== undefined) {
      return { ok: false, tools: [], message: "HTTP MCP 未返回有效 initialize 响应。", durationMs: Date.now() - started };
    }
    return { ok: true, tools: [], message: "HTTP MCP initialize 成功（未执行 tools/list）", durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, tools: [], message: "HTTP MCP health check 失败：" + String(error), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkMcpHealth(
  install: McpInstallSpec,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20_000
): Promise<HealthCheckResult> {
  if (install.transport === "http") return await checkHttp(install, timeoutMs);
  return await checkStdio(install, env, timeoutMs);
}
