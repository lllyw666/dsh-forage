import test from "node:test";
import assert from "node:assert/strict";
import { parseSelectionInput, selectCandidates } from "../src/picker/cli.js";
import type { Candidate, RankedCandidate } from "../src/types.js";

function entry(id: string, defaultSelected: boolean): RankedCandidate {
  const candidate: Candidate = {
    id,
    type: "mcp",
    name: id,
    description: id,
    domains: ["research"],
    tasks: ["文献检索"],
    tools: [],
    risk: { level: "low", writes: false, external_requests: true, sensitive_permissions: false },
    credentials: [],
    install: {
      method: "dsh-install",
      kind: "mcp",
      server: id,
      transport: "stdio",
      command: "npx",
      args: []
    }
  };
  return {
    candidate,
    score: 80,
    confidence: "high",
    reasons: [],
    defaultSelected,
    missingCredentials: [],
    defaultBlockedBy: []
  };
}

test("选择输入支持编号、区间、全选和清空", () => {
  assert.deepEqual(parseSelectionInput("1,3-4", 5), { kind: "toggle", indexes: [0, 2, 3] });
  assert.deepEqual(parseSelectionInput("a", 5), { kind: "all" });
  assert.deepEqual(parseSelectionInput("n", 5), { kind: "none" });
  assert.deepEqual(parseSelectionInput("o", 5), { kind: "other" });
  assert.deepEqual(parseSelectionInput("", 5), { kind: "accept" });
  assert.equal(parseSelectionInput("9", 5).kind, "invalid");
  assert.equal(parseSelectionInput("4-2", 5).kind, "invalid");
});

test("选择器切换默认项后回车确认", async () => {
  const ranked = [entry("a", true), entry("b", false), entry("c", false)];
  const answers = ["2", ""];
  const output: string[] = [];
  const selected = await selectCandidates(ranked, {
    ask: async () => answers.shift() ?? "",
    write: (text) => output.push(text),
    defaults: [0],
    count: ranked.length,
    interactive: true
  });
  assert.deepEqual(selected, [0, 1]);
  assert.ok(output.some((line) => line.includes("已选")));
});

test("选择器支持 q 取消", async () => {
  const ranked = [entry("a", true)];
  const selected = await selectCandidates(ranked, {
    ask: async () => "q",
    write: () => undefined,
    defaults: [0],
    count: 1,
    interactive: true
  });
  assert.equal(selected, null);
});

test("非交互模式直接返回默认项", async () => {
  const ranked = [entry("a", true), entry("b", false)];
  const selected = await selectCandidates(ranked, {
    write: () => undefined,
    defaults: [0],
    count: ranked.length,
    interactive: false
  });
  assert.deepEqual(selected, [0]);
});
test("选择器支持输入其他想法而不改变当前勾选", async () => {
  const ranked = [entry("a", true), entry("b", false)];
  const answers = ["o", "本地 nature-figure + 新的绘图 MCP", "2", ""];
  const notes: string[] = [];
  const selected = await selectCandidates(ranked, {
    ask: async () => answers.shift() ?? "",
    write: () => undefined,
    defaults: [0],
    count: ranked.length,
    interactive: true,
    onOther: (text) => { notes.push(text); }
  });
  assert.deepEqual(selected, [0, 1]);
  assert.deepEqual(notes, ["本地 nature-figure + 新的绘图 MCP"]);
});
