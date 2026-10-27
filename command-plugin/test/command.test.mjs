import test from "node:test";
import assert from "node:assert/strict";
import { executeForageCommand, formatPlan, parseForageInput } from "../lib/command.mjs";
import { apply, inject, name } from "../lib/index.mjs";

test("parseForageInput supports plan, status, catalog and rejects mutating verbs", () => {
  assert.deepEqual(parseForageInput("检索 RAG 论文"), { action: "plan", task: "检索 RAG 论文" });
  assert.deepEqual(parseForageInput("plan 检索 RAG 论文"), { action: "plan", task: "检索 RAG 论文" });
  assert.deepEqual(parseForageInput("status"), { action: "status" });
  assert.deepEqual(parseForageInput("catalog research"), { action: "catalog", domain: "research" });
  assert.deepEqual(parseForageInput("github 论文撰写"), { action: "github", task: "论文撰写" });
  assert.deepEqual(parseForageInput("software SnapGene"), { action: "software", name: "SnapGene" });
  assert.equal(parseForageInput("deploy semantic-scholar").action, "unsupported");
  assert.equal(parseForageInput("").action, "help");
});

test("plan command runs dsh-forage plan and formats candidates", async () => {
  const calls = [];
  const result = await executeForageCommand("检索 RAG 论文", {
    run: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({
          candidates: [{
            id: "semantic-scholar", name: "Semantic Scholar", score: 94, risk: { level: "low", writes: false },
            description: "学术论文检索", installedInScope: "user", defaultSelected: true, defaultBlockedBy: []
          }],
          warnings: []
        }),
        stderr: ""
      };
    }
  });
  assert.deepEqual(calls[0], ["plan", "检索 RAG 论文", "--json", "--top", "5"]);
  assert.equal(result.kind, "success");
  assert.match(result.text, /semantic-scholar/);
  assert.match(result.text, /installed user/);
});

test("status, doctor and catalog use their JSON payloads", async () => {
  const responses = {
    status: { mcps: [], skills: [], summary: { userMcps: 0, userSkills: 0, projectMcps: 0, projectSkills: 0, sessionMcps: 0 }, projectRoot: null },
    doctor: { summary: { ok: 13, warn: 2, error: 0 }, checks: [{ id: "mcp:mount", level: "ok", message: "ok" }] },
    catalog: { domain: "research", candidates: [{ id: "semantic-scholar", name: "Semantic Scholar" }] }
  };
  const run = async (args) => ({ code: 0, stdout: JSON.stringify(responses[args[0]]), stderr: "" });
  assert.match((await executeForageCommand("status", { run })).text, /Forage status/);
  assert.match((await executeForageCommand("doctor", { run })).text, /ok 13/);
  assert.match((await executeForageCommand("catalog research", { run })).text, /semantic-scholar/);
});

test("unsupported and failed CLI calls return errors", async () => {
  const unsupported = await executeForageCommand("remove semantic-scholar", { run: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
  assert.equal(unsupported.kind, "error");
  assert.match(unsupported.text, /read-only/);
  const failed = await executeForageCommand("status", { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
  assert.equal(failed.kind, "error");
  assert.equal(failed.text, "boom");
});

test("plugin registers a forage command with an input hint", () => {
  const registered = [];
  const ctx = {
    commands: { register(definition) { registered.push(definition); return () => {}; } },
    effect(generator) { const iterator = generator(); iterator.next(); }
  };
  apply(ctx, { cli: "C:/tmp/dist/src/index.js" });
  assert.equal(name, "forage-command");
  assert.deepEqual(inject, ["commands"]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "forage");
  assert.ok(registered[0].input.hint.includes("status"));
});

test("formatPlan shows blocked reasons and empty catalogs", () => {
  assert.match(formatPlan({ candidates: [] }), /No candidates/);
  assert.match(formatPlan({ candidates: [], localMatches: [{ kind: "skill", name: "nature-figure", scope: "project", score: 71 }] }), /nature-figure/);
  assert.match(formatPlan({ candidates: [{ id: "x", score: 1, risk: { level: "low" }, defaultBlockedBy: ["no match"] }] }), /blocked: no match/);
});
test("github mode passes --github to the CLI", async () => {
  let args;
  const result = await executeForageCommand("github 论文撰写", {
    run: async (value) => {
      args = value;
      return { code: 0, stdout: JSON.stringify({ candidates: [] }), stderr: "" };
    }
  });
  assert.deepEqual(args, ["plan", "论文撰写", "--github", "--json", "--top", "5"]);
  assert.equal(result.kind, "success");
});
test("software command only formats official/free entries", async () => {
  const calls = [];
  const result = await executeForageCommand("software SnapGene", {
    run: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({
          results: [{
            name: "SnapGene",
            license: "commercial",
            purpose: "open .dna and export PNG",
            official: { url: "https://www.snapgene.com/download" },
            freeOptions: [{ name: "SnapGene Viewer", url: "https://www.snapgene.com/snapgene-viewer" }],
            searchQuery: "SnapGene official download"
          }]
        }),
        stderr: ""
      };
    }
  });
  assert.deepEqual(calls[0], ["software", "SnapGene", "--json"]);
  assert.equal(result.kind, "success");
  assert.match(result.text, /official: https:\/\/www\.snapgene\.com/);
  assert.match(result.text, /no cracked builds/i);
});
