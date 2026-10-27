import test from "node:test";
import assert from "node:assert/strict";
import { parseIntent, parseIntentJson, IntentError } from "../src/intent/parser.js";

test("中文科研任务提取领域、任务与只读约束", () => {
  const intent = parseIntent("帮我检索这几篇 RAG 论文并整理引用，最好只读，不需要密钥");
  assert.ok(intent.domains.includes("research"));
  assert.ok(intent.tasks.includes("文献检索"));
  assert.ok(intent.tasks.includes("引用整理"));
  assert.ok(intent.constraints.includes("只读优先"));
  assert.ok(intent.constraints.includes("无需凭证"));
  assert.equal(intent.locale, "mixed");
});

test("英文办公任务提取 office 领域", () => {
  const intent = parseIntent("Please read this Excel spreadsheet and make a PowerPoint deck");
  assert.ok(intent.domains.includes("office"));
  assert.ok(intent.tasks.includes("表格处理"));
  assert.ok(intent.tasks.includes("演示制作"));
});

test("不要安装约束会被识别", () => {
  const intent = parseIntent("不要安装任何东西，只告诉我有没有本地能力");
  assert.ok(intent.constraints.includes("不要安装"));
});

test("空任务描述报错", () => {
  assert.throws(() => parseIntent("   "), IntentError);
});

test("结构化 intent 接受中文领域别名并规范化", () => {
  const intent = parseIntentJson({
    tasks: ["文献检索"],
    domains: ["科研"],
    signals: ["RAG"],
    constraints: ["read-only"],
    confidence: 0.9
  });
  assert.deepEqual(intent.domains, ["research"]);
  assert.deepEqual(intent.constraints, ["只读优先"]);
  assert.equal(intent.confidence, 0.9);
});

test("结构化 intent 缺少 domains 和 tasks 时报错", () => {
  assert.throws(() => parseIntentJson({ signals: ["x"] }), IntentError);
});
test("论文撰写和科研绘图会得到明确 task 和 research 领域", () => {
  const intent = parseIntent("我要进行论文撰写和科研绘图");
  assert.ok(intent.tasks.includes("论文撰写"));
  assert.ok(intent.tasks.includes("科研绘图"));
  assert.ok(intent.domains.includes("research"));
});
