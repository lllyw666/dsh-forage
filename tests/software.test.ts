import test from "node:test";
import assert from "node:assert/strict";
import { findSoftware, SOFTWARE_DISCLAIMER, validateSoftwareUrl } from "../src/software/catalog.js";
import { runCli } from "./helpers.js";

test("SnapGene 软件条目只提供官方/开源入口", () => {
  const results = findSoftware("SnapGene");
  assert.ok(results.some((entry) => entry.id === "snapgene"));
  const snapgene = results.find((entry) => entry.id === "snapgene");
  assert.ok(snapgene?.official);
  assert.match(snapgene.official.url, /^https:\/\/www\.snapgene\.com\//);
  assert.ok(snapgene.freeOptions.some((option) => option.name.includes("SnapGene Viewer")));
  for (const entry of results) {
    if (entry.official) assert.ok(validateSoftwareUrl(entry.official.url));
    for (const option of entry.freeOptions) assert.ok(validateSoftwareUrl(option.url));
  }
  assert.match(SOFTWARE_DISCLAIMER, /不提供破解/);
  assert.doesNotMatch(JSON.stringify(results), /pan\.baidu|crack|keygen|破解下载/i);
});

test("software --json 输出官方/免费/搜索入口和免责声明", () => {
  const result = runCli(["software", "SnapGene", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    results: Array<{ id: string; official?: { url: string }; freeOptions: Array<{ url: string }> }>;
    disclaimer: string;
  };
  assert.equal(payload.ok, true);
  assert.ok(payload.results.some((entry) => entry.id === "snapgene"));
  assert.match(payload.disclaimer, /不提供破解/);
});
