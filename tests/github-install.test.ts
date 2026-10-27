import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeGithubSkill, parseGithubSkillSource } from "../src/discovery/github-install.js";

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  buffer.write(text, offset, length, "ascii");
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function tarFile(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length), padded]);
}

function archive(): Buffer {
  const files = [
    tarFile("nature-skills-main/skills/nature-figure/SKILL.md", "---\nname: nature-figure\ndescription: figure\n---\n"),
    tarFile("nature-skills-main/skills/nature-figure/assets/style.txt", "plot style\n"),
    tarFile("nature-skills-main/README.md", "readme\n")
  ];
  return gzipSync(Buffer.concat([...files, Buffer.alloc(1024, 0)]));
}

test("parseGithubSkillSource handles owner/repo, subdir and ref", () => {
  assert.deepEqual(parseGithubSkillSource("github:Yuan1z0825/nature-skills#skills/nature-figure@main"), {
    owner: "Yuan1z0825",
    repo: "nature-skills",
    subdir: "skills/nature-figure",
    ref: "main"
  });
  assert.deepEqual(parseGithubSkillSource("github:owner/repo"), {
    owner: "owner", repo: "repo", subdir: "", ref: "HEAD"
  });
  assert.throws(() => parseGithubSkillSource("github:owner/repo#../evil"), /子目录不合法/);
});

test("materializeGithubSkill extracts only the skill subdir and caches it", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "forage-github-skill-"));
  try {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(new Uint8Array(archive()), { status: 200 });
    }) as unknown as typeof fetch;
    const source = "github:Yuan1z0825/nature-skills#skills/nature-figure@main";
    const first = await materializeGithubSkill(source, {
      cacheRoot: path.join(base, "cache"),
      fetchImpl,
      timeoutMs: 2000
    });
    assert.equal(first.cached, false);
    assert.equal(existsSync(path.join(first.path, "SKILL.md")), true);
    assert.match(readFileSync(path.join(first.path, "SKILL.md"), "utf8"), /nature-figure/);
    assert.match(readFileSync(path.join(first.path, "assets", "style.txt"), "utf8"), /plot style/);
    assert.equal(existsSync(path.join(first.path, "README.md")), false);
    const second = await materializeGithubSkill(source, {
      cacheRoot: path.join(base, "cache"),
      fetchImpl,
      timeoutMs: 2000
    });
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
