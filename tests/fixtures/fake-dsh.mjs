import fs from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_DSH_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const addIndex = args.indexOf("add");
const server = addIndex >= 0 ? args[addIndex + 1] : "unknown";
if (server === "fail-me") {
  console.error("DUPLICATE_SERVER fake-fail");
  process.exit(1);
}
if (server === "fake-cred") {
  console.log("using-secret=" + (process.env.TEST_SECRET ?? ""));
}
console.log("installed " + server);
