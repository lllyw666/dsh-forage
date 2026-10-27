import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, CatalogLoadResult } from "../types.js";
import { CatalogError, validateCatalog } from "./schema.js";

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export interface LoadCatalogOptions {
  packageRoot: string;
  cwd: string;
  extraPaths?: string[];
  includeProjectCatalog?: boolean;
}

export function findPackageRoot(start?: string): string {
  let current = path.resolve(start ?? path.dirname(fileURLToPath(import.meta.url)));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readTextSync(manifest)) as { name?: unknown };
        if (parsed.name === "dsh-forage") return current;
      } catch {
        // Keep walking; a malformed package.json belongs to another package.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CatalogError("找不到 dsh-forage 包根目录（package.json name 必须为 dsh-forage）");
}

function readTextSync(file: string): string {
  // Kept synchronous only for package-root and version discovery, which run once.
  return readFileSync(file, "utf8");
}

async function jsonFilesIn(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function readCatalog(file: string): Promise<Candidate[]> {
  const info = await stat(file);
  if (!info.isFile()) throw new CatalogError("不是普通文件", file);
  if (info.size > MAX_CATALOG_BYTES) throw new CatalogError("文件超过 2 MiB 上限", file);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new CatalogError(`读取失败：${String(error)}`, file);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CatalogError(`JSON 解析失败：${String(error)}`, file);
  }
  return validateCatalog(parsed, file).capabilities;
}

async function collectFiles(candidatePaths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const target of candidatePaths) {
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }
    if (info.isDirectory()) {
      files.push(...await jsonFilesIn(target));
    } else if (info.isFile() && target.endsWith(".json")) {
      files.push(target);
    } else {
      throw new CatalogError("--catalog 只接受 .json 文件或目录", target);
    }
  }
  return [...new Set(files.map((file) => path.resolve(file)))];
}

export async function loadCatalog(options: LoadCatalogOptions): Promise<CatalogLoadResult> {
  const builtinDir = path.join(options.packageRoot, "catalog");
  if (!existsSync(builtinDir)) throw new CatalogError("内置 catalog/ 目录不存在", builtinDir);
  const roots: string[] = [builtinDir];
  if (options.includeProjectCatalog === true) {
    roots.push(path.join(options.cwd, ".dsh", "forage", "catalog"));
  }
  for (const extra of options.extraPaths ?? []) {
    const target = path.resolve(options.cwd, extra);
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        const files = await jsonFilesIn(target);
        if (files.length === 0) throw new CatalogError("--catalog 目录中没有 JSON 文件", target);
      }
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CatalogError("--catalog 路径不存在", target);
      }
      throw error;
    }
    roots.push(target);
  }
  const files = await collectFiles(roots);
  if (files.length === 0) throw new CatalogError("没有找到任何 catalog JSON");
  const byId = new Map<string, { candidate: Candidate; file: string }>();
  const sources: string[] = [];
  for (const file of files) {
    const candidates = await readCatalog(file);
    sources.push(file);
    for (const candidate of candidates) {
      const existing = byId.get(candidate.id);
      if (existing !== undefined) {
        throw new CatalogError(
          `能力 ID ${JSON.stringify(candidate.id)} 重复定义（另见 ${existing.file}）`,
          file
        );
      }
      byId.set(candidate.id, { candidate, file });
    }
  }
  return {
    capabilities: [...byId.values()].map((entry) => entry.candidate),
    files: [...new Set(sources)]
  };
}

export function packageVersion(packageRoot: string): string {
  try {
    const parsed = JSON.parse(readTextSync(path.join(packageRoot, "package.json"))) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
