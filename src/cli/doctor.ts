import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveDshHome } from "../scopes/paths.js";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  level: DoctorLevel;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  dshHome: string;
  cwd: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; error: number };
}

export interface DoctorOptions {
  cwd: string;
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  dshHome?: string;
}

const SHIMS = ["node", "npm", "npx", "pnpm", "dsh", "dsh-forage"] as const;

function isAbsoluteCommand(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

function quotedPaths(text: string): string[] {
  return [...text.matchAll(/"([^"\r\n]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => isAbsoluteCommand(value));
}

function isAsarPath(value: string): boolean {
  return /\.asar(?:[\\/]|$)/i.test(value);
}

function checkShim(home: string, name: string): DoctorCheck[] {
  const file = path.join(home, "bin", name + ".cmd");
  if (!existsSync(file)) {
    return [{
      id: "shim:" + name,
      level: "warn",
      message: "缺少启动器 " + file,
      fix: "重新运行 DSH 安装器，或把 " + name + " 加入 PATH；也可以直接运行 node <repo>/dist/src/index.js。"
    }];
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return [{ id: "shim:" + name, level: "error", message: "无法读取 " + file + "：" + String(error) }];
  }
  const checks: DoctorCheck[] = [];
  const missing = quotedPaths(text).filter((value) => !isAsarPath(value) && !existsSync(value));
  if (missing.length > 0) {
    checks.push({
      id: "shim:" + name,
      level: "error",
      message: "启动器 " + name + ".cmd 指向不存在的路径：" + missing.join(", "),
      fix: "重新运行 DSH 安装器，或把 " + file + " 改为新安装路径；不要保留指向已删除目录的 shim。"
    });
  } else {
    checks.push({ id: "shim:" + name, level: "ok", message: name + ".cmd 的目标存在" });
  }
  if (name === "dsh" && !/ELECTRON_RUN_AS_NODE=1/i.test(text)) {
    checks.push({
      id: "shim:dsh-mode",
      level: "error",
      message: "dsh.cmd 没有设置 ELECTRON_RUN_AS_NODE=1，会尝试启动 GUI 而不是 CLI。",
      fix: "在 dsh.cmd 中加入 set ELECTRON_RUN_AS_NODE=1 后再调用 dsh-desktop-host/lib/cli.js。"
    });
  }
  if (name === "dsh-forage" && /DeepSeek Harness\.exe/i.test(text)) {
    checks.push({
      id: "shim:dsh-forage-electron",
      level: "warn",
      message: "dsh-forage.cmd 通过 Electron 可执行文件启动 CLI；应用升级或移动后很容易失效。",
      fix: "直接用 node.exe 运行 dist/src/index.js，不经过 DeepSeek Harness.exe。"
    });
  }
  return checks;
}

function hasLocalRegistry(home: string): boolean {
  const profiles = path.join(home, "profiles");
  if (!existsSync(profiles)) return false;
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(profiles, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
      if (manifest.dependencies?.["@dsh-forage/mcp-registry"] !== undefined) return true;
    }
  } catch {
    // A broken profile is reported by the installer checks; do not duplicate it here.
  }
  return false;
}

function checkMcp(home: string, localRegistry: boolean): DoctorCheck[] {
  const file = path.join(home, "mcp.json");
  if (!existsSync(file)) return [{ id: "mcp", level: "ok", message: "未配置 MCP（mcp.json 不存在）" }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return [{ id: "mcp", level: "error", message: "mcp.json 不是合法 JSON：" + String(error), fix: "修正 mcp.json 后重试。" }];
  }
  const servers = (parsed as { servers?: unknown }).servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return [{ id: "mcp", level: "error", message: "mcp.json 的 servers 必须是对象。", fix: "修正 mcp.json 后重试。" }];
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) return [{ id: "mcp", level: "ok", message: "MCP 注册表为空" }];
  const checks: DoctorCheck[] = [];
  for (const [name, raw] of entries) {
    if (typeof raw !== "object" || raw === null) {
      checks.push({ id: "mcp:" + name, level: "error", message: name + " 的配置不是对象。" });
      continue;
    }
    const entry = raw as { enabled?: unknown; command?: unknown; args?: unknown };
    if (entry.enabled === false) {
      checks.push({ id: "mcp:" + name, level: "ok", message: name + " 已禁用" });
      continue;
    }
    if (typeof entry.command !== "string" || entry.command === "") {
      checks.push({ id: "mcp:" + name, level: "error", message: name + " 缺少 command。", fix: "补齐 command 或移除该条目。" });
      continue;
    }
    if (isAbsoluteCommand(entry.command) && !existsSync(entry.command)) {
      checks.push({
        id: "mcp:" + name,
        level: "error",
        message: name + " 的 command 不存在：" + entry.command,
        fix: "把 command 改为当前 runtime 的 node.exe，或移除该 MCP。"
      });
      continue;
    }
    const badArgs = (Array.isArray(entry.args) ? entry.args : [])
      .filter((value): value is string => typeof value === "string")
      .filter((value) => isAbsoluteCommand(value) && /\.(?:js|mjs|cjs)$/i.test(value) && !existsSync(value));
    if (badArgs.length > 0) {
      checks.push({
        id: "mcp:" + name,
        level: "error",
        message: name + " 的入口脚本不存在：" + badArgs.join(", "),
        fix: "重新安装该 MCP，或修正 args 中的绝对路径。"
      });
      continue;
    }
    if (!isAbsoluteCommand(entry.command)) {
      checks.push({
        id: "mcp:" + name,
        level: "warn",
        message: name + " 依赖 PATH 启动 " + entry.command + "；PATH 里没有对应运行时就会静默断开。",
        fix: "确认 " + entry.command + " 在 PATH 中，或把 command 改成绝对路径。"
      });
      continue;
    }
    checks.push({ id: "mcp:" + name, level: "ok", message: name + " 的 command 存在" });
  }
  const enabled = entries.filter(([, raw]) => {
    return typeof raw === "object" && raw !== null && (raw as { enabled?: unknown }).enabled !== false;
  }).length;
  if (enabled > 0) {
    if (localRegistry) {
      checks.push({
        id: "mcp:mount",
        level: "ok",
        message: "mcp.json 有 " + String(enabled) + " 个启用的 MCP；@dsh-forage/mcp-registry 已安装（若工具未出现，重启 DSH）"
      });
    } else {
      checks.push({
        id: "mcp:mount",
        level: "warn",
        message: "mcp.json 有 " + String(enabled) + " 个启用的 MCP；本地后端只写配置，挂载需要兼容的 mcp-registry 插件。",
        fix: "安装 @dsh-forage/mcp-registry（项目 plugin/ 目录），或使用兼容的 dsh-install；否则工具不会出现。"
      });
    }
  }
  return checks;
}

function checkWorkspace(home: string, cwd: string): DoctorCheck[] {
  const shim = path.join(home, "bin", "dsh.cmd");
  if (!existsSync(shim)) return [];
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return [];
  }
  const exe = quotedPaths(text).find((value) => /\.exe$/i.test(value) && !isAsarPath(value));
  if (exe === undefined) return [];
  const appRoot = path.dirname(exe);
  const isDesktopApp = /DeepSeek Harness\.exe$/i.test(path.basename(exe))
    || existsSync(path.join(appRoot, "resources", "app.asar"));
  if (!isDesktopApp) return [];
  const relative = path.relative(appRoot, path.resolve(cwd));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return [{
      id: "workspace:inside-app",
      level: "error",
      message: "当前工作区位于 DSH 安装目录内：" + cwd,
      fix: "把项目移到普通目录（例如 D:\\projects\\dsh-forage）；安装目录的 ACL 常导致沙箱 grantWrite 失败。"
    }];
  }
  return [{ id: "workspace", level: "ok", message: "工作区不在 DSH 安装目录内" }];
}

function checkSkill(home: string, packageRoot: string): DoctorCheck[] {
  const installed = path.join(home, "skills", "dsh-forage.md");
  const source = path.join(packageRoot, "SKILL.md");
  if (!existsSync(installed)) {
    return [{
      id: "skill",
      level: "warn",
      message: "未安装 dsh-forage Skill：" + installed,
      fix: "重启 DSH 后重新安装 SKILL.md；运行中的 DSH 会锁住该文件。"
    }];
  }
  if (!existsSync(source)) return [{ id: "skill", level: "warn", message: "找不到源 SKILL.md：" + source }];
  try {
    if (readFileSync(installed, "utf8") !== readFileSync(source, "utf8")) {
      return [{
        id: "skill",
        level: "warn",
        message: "已安装的 Skill 与源码 SKILL.md 不一致（可能是旧版本或被本地注释改过）。",
        fix: "重启 DSH 释放文件锁，然后用源 SKILL.md 覆盖 ~/.dsh/skills/dsh-forage.md。"
      }];
    }
    return [{ id: "skill", level: "ok", message: "已安装 Skill 与源码一致" }];
  } catch (error) {
    return [{ id: "skill", level: "error", message: "无法读取 Skill：" + String(error) }];
  }
}

function checkInstaller(home: string): DoctorCheck[] {
  const profiles = path.join(home, "profiles");
  if (!existsSync(profiles)) return [{ id: "installer", level: "ok", message: "没有 DSH profile；dsh-install 未安装，默认本地后端可用。" }];
  const checks: DoctorCheck[] = [];
  let found = false;
  let entries;
  try {
    entries = readdirSync(profiles, { withFileTypes: true });
  } catch {
    return [{ id: "installer", level: "warn", message: "无法读取 profiles 目录：" + profiles }];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(profiles, entry.name);
    const manifestPath = path.join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: { dependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
    } catch {
      continue;
    }
    const version = manifest.dependencies?.["@dsh-tools/dsh-install"];
    if (version === undefined) continue;
    found = true;
    const compatibilityPath = path.join(dir, "compatibility.json");
    let exemptions: unknown;
    try {
      if (existsSync(compatibilityPath)) {
        exemptions = (JSON.parse(readFileSync(compatibilityPath, "utf8")) as Record<string, unknown>)["@dsh-tools/dsh-install@" + version];
      }
    } catch {
      checks.push({ id: "installer:" + entry.name, level: "warn", message: entry.name + " 的 compatibility.json 不是合法 JSON；仅影响 --backend dsh-install。" });
      continue;
    }
    if (!Array.isArray(exemptions) || exemptions.length === 0) {
      checks.push({
        id: "installer:" + entry.name,
        level: "warn",
        message: entry.name + " 安装了 @dsh-tools/dsh-install@" + version + "，但没有为当前 DSH 版本登记精确版本豁免；仅影响 --backend dsh-install。",
        fix: "默认 auto 会走本地后端，不受影响；只有显式使用 --backend dsh-install 时才需要处理此警告，且不要为了加载它随意 accept-risk。"
      });
    } else {
      checks.push({
        id: "installer:" + entry.name,
        level: "warn",
        message: entry.name + " 的 installer 只对 " + exemptions.join(", ") + " 豁免；其他版本会被跳过（仅影响 --backend dsh-install）。",
        fix: "默认 auto 会走本地后端；只有显式使用 --backend dsh-install 时才需要确认 dsh --profile " + entry.name + " mcp list 没有 skipping 警告。"
      });
    }
  }
  if (!found) checks.push({ id: "installer", level: "ok", message: "没有 profile 安装 dsh-install；默认本地后端可用，只有 --backend dsh-install 不可用。" });
  return checks;
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const env = options.env ?? process.env;
  const home = options.dshHome ?? resolveDshHome(env);
  const checks: DoctorCheck[] = [];
  if (!existsSync(home)) {
    checks.push({ id: "dsh-home", level: "error", message: "DSH_HOME 不存在：" + home, fix: "确认 DSH_HOME，或先启动一次 DSH。" });
  } else if (!statSync(home).isDirectory()) {
    checks.push({ id: "dsh-home", level: "error", message: "DSH_HOME 不是目录：" + home });
  } else {
    checks.push({ id: "dsh-home", level: "ok", message: "DSH_HOME 存在：" + home });
    try {
      accessSync(home, constants.W_OK);
      checks.push({ id: "dsh-home:writable", level: "ok", message: "DSH_HOME 可写" });
    } catch {
      checks.push({ id: "dsh-home:writable", level: "error", message: "DSH_HOME 不可写；本地后端无法写 mcp.json/skills。", fix: "检查 " + home + " 的权限，或设置可写的 DSH_HOME。" });
    }
    checks.push({ id: "backend:local", level: "ok", message: "本地部署后端可用（默认 auto 在未显式指定 dsh 时使用）" });
    for (const name of SHIMS) checks.push(...checkShim(home, name));
    checks.push(...checkMcp(home, hasLocalRegistry(home)));
    checks.push(...checkWorkspace(home, options.cwd));
    checks.push(...checkSkill(home, options.packageRoot));
    checks.push(...checkInstaller(home));
  }
  const summary = {
    ok: checks.filter((check) => check.level === "ok").length,
    warn: checks.filter((check) => check.level === "warn").length,
    error: checks.filter((check) => check.level === "error").length
  };
  return { ok: summary.error === 0, dshHome: home, cwd: path.resolve(options.cwd), checks, summary };
}
