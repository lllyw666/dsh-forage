import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const directory = path.resolve("dist", "tests");
const files = readdirSync(directory)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(directory, file));
if (files.length === 0) {
  console.error("no compiled tests found in " + directory);
  process.exit(1);
}
const temp = mkdtempSync(path.join(os.tmpdir(), "dsh-forage-tests-"));
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, NO_COLOR: "1", TEMP: temp, TMP: temp }
});
rmSync(temp, { recursive: true, force: true });
if (result.error !== undefined) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
