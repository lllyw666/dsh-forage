import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export class GithubInstallError extends Error {
  readonly code: string;
  readonly fix: string;
  override name = "GithubInstallError";

  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export interface GithubSkillSource {
  owner: string;
  repo: string;
  subdir: string;
  ref: string;
}

export interface MaterializeOptions {
  cacheRoot: string;
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MaterializedSkill {
  path: string;
  source: string;
  repository: string;
  subdir: string;
  cached: boolean;
}

const OWNER = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const COMPLETE_SUFFIX = ".forage-github.json";

function markerFor(cacheDir: string): string {
  return cacheDir + COMPLETE_SUFFIX;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

function splitRef(value: string): { value: string; ref: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0) return { value, ref: "HEAD" };
  const ref = value.slice(at + 1);
  if (ref === "" || !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) {
    throw new GithubInstallError("GITHUB_SOURCE_INVALID", "GitHub ref 不合法。", "使用 owner/repo#subdir@ref 形式。");
  }
  return { value: value.slice(0, at), ref };
}

export function isGithubSkillSource(source: string): boolean {
  return source.startsWith("github:");
}

export function parseGithubSkillSource(source: string): GithubSkillSource {
  if (!isGithubSkillSource(source)) {
    throw new GithubInstallError("GITHUB_SOURCE_INVALID", "不是 GitHub Skill 源：" + source, "使用 github:owner/repo#subdir@ref。");
  }
  const raw = source.slice("github:".length);
  const hash = raw.indexOf("#");
  const repoPart = hash >= 0 ? raw.slice(0, hash) : raw;
  const pathPart = hash >= 0 ? raw.slice(hash + 1) : "";
  const parsed = splitRef(repoPart);
  const slash = parsed.value.indexOf("/");
  if (slash <= 0 || slash === parsed.value.length - 1) {
    throw new GithubInstallError("GITHUB_SOURCE_INVALID", "GitHub 源必须是 owner/repo。", "使用 github:owner/repo#subdir@ref。");
  }
  const owner = parsed.value.slice(0, slash);
  const repo = parsed.value.slice(slash + 1);
  if (!OWNER.test(owner) || !REPO.test(repo)) {
    throw new GithubInstallError("GITHUB_SOURCE_INVALID", "GitHub owner/repo 不合法。", "检查 catalog 的 install.source。");
  }
  const pathParsed = splitRef(pathPart);
  const subdir = pathParsed.value.replace(/^\/+|\/+$/g, "");
  const segments = subdir === "" ? [] : subdir.split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) {
    throw new GithubInstallError("GITHUB_SOURCE_INVALID", "GitHub 子目录不合法：" + subdir, "子目录不能包含 .. 或空段。");
  }
  return { owner, repo, subdir: segments.join("/"), ref: pathParsed.ref };
}

interface TarEntry {
  name: string;
  type: string;
  data: Buffer;
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readString(buffer, offset, length).trim();
  if (raw === "") return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function* tarEntries(buffer: Buffer): Generator<TarEntry> {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    if (size < 0 || size > 200 * 1024 * 1024) {
      throw new GithubInstallError("GITHUB_ARCHIVE_INVALID", "tar 条目大小异常：" + name, "仓库归档可能损坏。");
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) break;
    const fullName = prefix === "" ? name : prefix + "/" + name;
    if (type === "0" || type === "\0" || type === "7") {
      yield { name: fullName, type: "file", data: buffer.subarray(dataStart, dataEnd) };
    } else if (type === "5") {
      yield { name: fullName, type: "directory", data: Buffer.alloc(0) };
    }
    // Symlinks and hardlinks are deliberately skipped: a downloaded skill
    // must not create links outside its cache directory.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GithubInstallError("GITHUB_ARCHIVE_UNSAFE", "tar 路径越界：" + target, "拒绝解压该归档。");
  }
}

function writeExtracted(cacheDir: string, entry: TarEntry, relative: string): void {
  const target = path.resolve(cacheDir, relative);
  assertInside(cacheDir, target);
  if (entry.type === "directory") {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, entry.data);
}

function extractSkill(archive: Buffer, cacheDir: string, subdir: string): void {
  const rootPrefix = subdir === "" ? "" : subdir;
  let found = false;
  let files = 0;
  for (const entry of tarEntries(archive)) {
    const normalized = path.posix.normalize(entry.name);
    const firstSlash = normalized.indexOf("/");
    if (firstSlash < 0) continue;
    const inner = normalized.slice(firstSlash + 1);
    if (rootPrefix !== "") {
      if (inner !== rootPrefix && !inner.startsWith(rootPrefix + "/")) continue;
      const relative = inner === rootPrefix ? "" : inner.slice(rootPrefix.length + 1);
      if (relative === "") continue;
      writeExtracted(cacheDir, entry, relative);
      found = true;
      files += 1;
      if (files > 5000) throw new GithubInstallError("GITHUB_ARCHIVE_TOO_LARGE", "归档文件数超过 5000。", "只安装必要的 Skill 子目录。");
    } else {
      const relative = inner.replace(/^\.git\//, "");
      if (relative === "" || relative.startsWith(".git/")) continue;
      writeExtracted(cacheDir, entry, relative);
      found = true;
      files += 1;
      if (files > 5000) throw new GithubInstallError("GITHUB_ARCHIVE_TOO_LARGE", "归档文件数超过 5000。", "只安装必要的 Skill 子目录。");
    }
  }
  if (!found) {
    throw new GithubInstallError("GITHUB_SKILL_NOT_FOUND", "归档中没有找到 Skill 子目录：" + subdir, "检查 install.source 的 #subdir。");
  }
  if (!existsSync(path.join(cacheDir, "SKILL.md"))) {
    throw new GithubInstallError("GITHUB_SKILL_INVALID", "下载的 Skill 目录没有 SKILL.md。", "确认子目录指向 SKILL.md 所在目录。");
  }
}

function complete(cacheDir: string, source: string): void {
  writeFileSync(markerFor(cacheDir), JSON.stringify({ source, fetchedAt: new Date().toISOString() }) + "\n", "utf8");
}

function cacheIsFresh(cacheDir: string, maxAgeMs: number): boolean {
  if (!existsSync(cacheDir)) return false;
  const marker = markerFor(cacheDir);
  if (!existsSync(marker)) return false;
  try {
    return Date.now() - statSync(marker).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

export async function materializeGithubSkill(
  source: string,
  options: MaterializeOptions
): Promise<MaterializedSkill> {
  const parsed = parseGithubSkillSource(source);
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const cacheDir = path.join(options.cacheRoot, safeSegment(parsed.owner) + "-" + safeSegment(parsed.repo) + "-" + key);
  const maxAgeMs = Math.max(60_000, options.maxAgeMs ?? 24 * 60 * 60 * 1000);
  if (cacheIsFresh(cacheDir, maxAgeMs)) {
    return { path: cacheDir, source, repository: parsed.owner + "/" + parsed.repo, subdir: parsed.subdir, cached: true };
  }
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  rmSync(markerFor(cacheDir), { force: true });

  const url = "https://codeload.github.com/" + parsed.owner + "/" + parsed.repo + "/tar.gz/" + parsed.ref;
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000);
  const timer = setTimeout(() => controller.abort(new Error("GitHub archive timed out")), timeoutMs);
  let archive: Buffer;
  try {
    const headers: Record<string, string> = { "user-agent": "dsh-forage-github-install" };
    if (options.token !== undefined && options.token !== "") headers.authorization = "Bearer " + options.token;
    const response = await (options.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new GithubInstallError("GITHUB_DOWNLOAD_FAILED", "GitHub 归档下载失败：" + String(response.status) + " " + response.statusText, "检查网络/仓库是否公开，或设置 GITHUB_TOKEN。");
    }
    const compressed = Buffer.from(await response.arrayBuffer());
    if (compressed.length > (options.maxBytes ?? 80 * 1024 * 1024)) {
      throw new GithubInstallError("GITHUB_ARCHIVE_TOO_LARGE", "GitHub 归档超过大小上限。", "改用较小的 Skill 子目录或手动安装。");
    }
    archive = gunzipSync(compressed);
  } catch (error) {
    if (error instanceof GithubInstallError) throw error;
    throw new GithubInstallError("GITHUB_DOWNLOAD_FAILED", "GitHub 归档下载/解压失败：" + String(error instanceof Error ? error.message : error), "检查网络或设置 GITHUB_TOKEN。");
  } finally {
    clearTimeout(timer);
  }

  const temp = cacheDir + ".tmp-" + String(process.pid) + "-" + String(Date.now());
  mkdirSync(temp, { recursive: true });
  try {
    extractSkill(archive, temp, parsed.subdir);
    mkdirSync(path.dirname(cacheDir), { recursive: true });
    renameSync(temp, cacheDir);
    complete(cacheDir, source);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    rmSync(markerFor(cacheDir), { force: true });
    throw error;
  }
  return { path: cacheDir, source, repository: parsed.owner + "/" + parsed.repo, subdir: parsed.subdir, cached: false };
}

export function githubCacheRoot(dshHome: string): string {
  return path.join(dshHome, "forage", "github-src");
}
