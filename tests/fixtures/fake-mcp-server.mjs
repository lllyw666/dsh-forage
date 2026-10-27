import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } } }) + "\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping", description: "ping" }, { name: "echo", description: "echo" }] } }) + "\n");
  }
});
