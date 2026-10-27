import test from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "../src/intent/parser.js";
import { rankCandidates } from "../src/ranker/index.js";
import { loadRealCatalog, loadFixtureCatalog } from "./helpers.js";
import type { Candidate } from "../src/types.js";

test("科研只读查询默认只选低风险只读项，且同类只选一个", async () => {
  const catalog = await loadRealCatalog();
  const ranked = rankCandidates(parseIntent("帮我检索 RAG 论文并整理引用，只读"), catalog.capabilities, {
    env: {},
    topN: 5,
    maxDefaults: 2
  });
  assert.equal(ranked.length, 5);
  const defaults = ranked.filter((entry) => entry.defaultSelected);
  assert.ok(defaults.length >= 1);
  assert.ok(defaults.length <= 2);
  for (const entry of defaults) {
    assert.equal(entry.candidate.risk.level, "low");
    assert.equal(entry.candidate.risk.writes, false);
  }
  const searchDefaults = defaults.filter((entry) => entry.candidate.group === "scholarly-search");
  assert.equal(searchDefaults.length, 1);
});

test("办公写入场景没有默认勾选", async () => {
  const catalog = await loadRealCatalog();
  const ranked = rankCandidates(parseIntent("帮我用 Excel 处理表格并生成图表"), catalog.capabilities, {
    env: {},
    topN: 5,
    maxDefaults: 2
  });
  assert.ok(ranked.some((entry) => entry.candidate.id === "excel"));
  assert.equal(ranked.filter((entry) => entry.defaultSelected).length, 0);
});

test("不要安装时只返回内置能力", async () => {
  const catalog = await loadRealCatalog();
  const ranked = rankCandidates(parseIntent("不要安装任何东西，处理 Word 文档"), catalog.capabilities, {
    env: {},
    topN: 10,
    maxDefaults: 2
  });
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((entry) => entry.candidate.install.method === "builtin"));
});

test("缺少凭证的候选不会默认勾选", async () => {
  const catalog = await loadFixtureCatalog();
  const candidates = catalog.capabilities.filter((candidate) => candidate.id.startsWith("fake-"));
  const ranked = rankCandidates(parseIntent("文献检索"), candidates, {
    env: {},
    topN: 10,
    maxDefaults: 5
  });
  const credential = ranked.find((entry) => entry.candidate.id === "fake-cred");
  assert.ok(credential);
  assert.equal(credential.defaultSelected, false);
  assert.deepEqual(credential.missingCredentials, ["TEST_SECRET"]);
});

test("高风险候选仍可展示但不会默认勾选", async () => {
  const catalog = await loadFixtureCatalog();
  const candidates = catalog.capabilities.filter((candidate) => candidate.id.startsWith("fake-"));
  const ranked = rankCandidates(parseIntent("文献检索"), candidates, { env: {}, topN: 10, maxDefaults: 5 });
  const high = ranked.find((entry) => entry.candidate.id === "fake-high");
  assert.ok(high);
  assert.equal(high.defaultSelected, false);
});
test("GitHub 来源优先级 × stars 会形成可解释的加权", async () => {
  const catalog = await loadFixtureCatalog();
  const base = catalog.capabilities.find((candidate) => candidate.id === "fake-ok");
  assert.ok(base);
  const make = (id: string, sourcePriority: number, stars: number): Candidate => ({
    ...base,
    id,
    name: id,
    risk: { level: "high", writes: true, external_requests: true, sensitive_permissions: true },
    discovery: {
      source: "github",
      repo: "example/" + id,
      url: "https://github.com/example/" + id,
      stars,
      sourcePriority,
      query: "文献检索",
      verified: false
    }
  });
  const ranked = rankCandidates(parseIntent("文献检索"), [make("low-trust", 0.3, 5), make("high-trust", 0.9, 50_000)], {
    env: {},
    topN: 5,
    maxDefaults: 5
  });
  const high = ranked.find((entry) => entry.candidate.id === "high-trust");
  const low = ranked.find((entry) => entry.candidate.id === "low-trust");
  assert.ok(high && low);
  assert.ok(high.score > low.score);
  assert.ok(high.reasons.some((reason) => reason.includes("来源信任")));
});
