import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshInstallClient, DshNotFoundError } from "../src/deploy/dsh-install.js";

test("Windows Electron GUI 可执行文件会被拒绝", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-gui-"));
  const exe = path.join(dir, "DeepSeek Harness.exe");
  writeFileSync(exe, "", "utf8");
  mkdirSync(path.join(dir, "resources"), { recursive: true });
  writeFileSync(path.join(dir, "resources", "app.asar"), "", "utf8");
  try {
    const client = new DshInstallClient({
      dshBin: exe,
      cwd: dir,
      env: process.env,
      platform: "win32",
      timeoutMs: 10000
    });
    assert.throws(
      () => client.resolve(),
      (error: unknown) => error instanceof DshNotFoundError && /桌面端/.test(error.fix)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows .cmd 启动器支持带空格的路径", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-cmd-"));
  const script = path.join(dir, "fake dsh.cmd");
  writeFileSync(script, "@echo off\r\necho args:%*\r\nexit /b 0\r\n", "utf8");
  try {
    const client = new DshInstallClient({
      dshBin: script,
      cwd: dir,
      env: process.env,
      platform: "win32",
      timeoutMs: 10000
    });
    const result = await client.run(["--profile", "install", "mcp", "add", "example"], 10000);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
