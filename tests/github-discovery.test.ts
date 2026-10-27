import test from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "../src/intent/parser.js";
import { deriveGithubQueries, discoverGithub } from "../src/discovery/github.js";
import { validateCatalog } from "../src/catalog/schema.js";

function repo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Yuan1z0825/nature-skills",
    html_url: "https://github.com/Yuan1z0825/nature-skills",
    description: "符合nature论文学术表达和科研绘图的Skill",
    default_branch: "main",
    stargazers_count: 50808,
    archived: false,
    fork: false,
    topics: ["skills", "research"],
    license: { spdx_id: "Apache-2.0" },
    name: "nature-skills",
    ...overrides
  };
}

const skillFiles: Record<string, string> = {
  "skills/nature-figure/SKILL.md": "---\nname: nature-figure\ndescription: Scientific figure and plotting workflow.\n---\n",
  "skills/nature-writing/SKILL.md": "---\nname: nature-writing\ndescription: Academic paper writing workflow.\n---\n",
  "skills/nature-data/SKILL.md": "---\nname: nature-data\ndescription: Data availability statements.\n---\n"
};

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/search/repositories")) {
    return Promise.resolve(new Response(JSON.stringify({ items: [repo()] }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  if (url.includes("/contents/skills")) {
    return Promise.resolve(new Response(JSON.stringify([
      { type: "dir", name: "nature-data", path: "skills/nature-data" },
      { type: "dir", name: "nature-figure", path: "skills/nature-figure" },
      { type: "dir", name: "nature-writing", path: "skills/nature-writing" }
    ]), { status: 200, headers: { "content-type": "application/json" } }));
  }
  for (const [path, body] of Object.entries(skillFiles)) {
    if (url.endsWith("/" + path)) return Promise.resolve(new Response(body, { status: 200 }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

test("deriveGithubQueries uses task-specific short queries", () => {
  const intent = parseIntent("我要进行论文撰写和科研绘图");
  const queries = deriveGithubQueries(intent);
  assert.ok(queries.some((query) => query === "科研绘图 skill"));
  assert.ok(queries.some((query) => query === "论文撰写 skill"));
});

test("discoverGithub inspects skill repos and produces valid candidates", async () => {
  const intent = parseIntent("我要进行论文撰写和科研绘图");
  const result = await discoverGithub(intent, {
    fetchImpl: fakeFetch as unknown as typeof fetch,
    maxRepos: 1,
    maxCandidates: 6,
    timeoutMs: 1000
  });
  assert.ok(result.candidates.length >= 2);
  const figure = result.candidates.find((candidate) => candidate.name === "nature-figure");
  assert.ok(figure);
  assert.equal(figure.type, "skill");
  assert.equal(figure.discovery?.repo, "Yuan1z0825/nature-skills");
  assert.ok((figure.discovery?.sourcePriority ?? 0) >= 0.8);
  assert.equal(figure.discovery?.stars, 50808);
  assert.equal(figure.install.method, "dsh-install");
  if (figure.install.method === "dsh-install" && figure.install.kind === "skill") {
    assert.match(figure.install.source, /github:Yuan1z0825\/nature-skills#skills\/nature-figure@main/);
  } else {
    assert.fail("expected a skill install spec");
  }
  assert.deepEqual(figure.tasks, ["科研绘图"]);
  const catalog = validateCatalog({
    schemaVersion: 1,
    domain: "research",
    capabilities: result.candidates
  }, "github-test");
  assert.equal(catalog.capabilities.length, result.candidates.length);
});

test("discoverGithub infers an npx install for an MCP package", async () => {
  const intent = parseIntent("论文写作 MCP");
  const mcpRepo = repo({
    full_name: "example/paper-mcp",
    html_url: "https://github.com/example/paper-mcp",
    description: "An MCP server for paper writing",
    name: "paper-mcp",
    topics: ["mcp"],
    stargazers_count: 12
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/search/repositories")) return new Response(JSON.stringify({ items: [mcpRepo] }), { status: 200 });
    if (url.endsWith("/package.json")) return new Response(JSON.stringify({ name: "paper-mcp", version: "1.0.0", description: "paper writing" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await discoverGithub(intent, { fetchImpl, maxRepos: 1, timeoutMs: 1000 });
  const candidate = result.candidates.find((entry) => entry.type === "mcp");
  assert.ok(candidate);
  assert.equal(candidate.install.method, "dsh-install");
  if (candidate.install.method === "dsh-install" && candidate.install.kind === "mcp") {
    assert.equal(candidate.install.command, "npx");
    assert.deepEqual(candidate.install.args, ["-y", "paper-mcp"]);
  } else {
    assert.fail("expected an MCP install spec");
  }
  assert.equal(candidate.discovery?.repo, "example/paper-mcp");
});
