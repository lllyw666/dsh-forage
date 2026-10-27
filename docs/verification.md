# Verification record

Date: 2026-10-26  
Platform: Windows, DSH 0.2.1-rc.2 desktop, Node 24.21.0 Electron runtime  
Package: dsh-forage 0.2.0

This file records what was actually checked for v0.2.0, including what was not checked.

## Automated tests

Command (CI and normal local):

    npm test

Local equivalent used during development:

    tsc -p tsconfig.json && node scripts/test.mjs

Result:

- 102 project tests
- 101 passed
- 1 skipped: POSIX symlink launch test (Windows host)
- 0 failed
- 4 registry plan tests + 8 `/forage` command tests (`npm run test:plugin`): 12 passed

Coverage includes intent parsing, catalog validation, ranking and default selection, local-first installed-Skill matching, picker parsing, command construction, local mcp.json/skill writes with backups, duplicate/installed detection, remove/update with backups, dsh-install remove/update construction, session-scope MCP writes/status/remove and guards, embedding provider/fallback/cache (hashed + HTTP), GitHub query derivation/repo inspection/MCP npx inference/schema validation, `/forage` command parsing/registration, npm pack allowlist, failure isolation, approval preconditions, project-scope preflight, secret redaction, JSON contracts, a full forge-to-deploy loop with the local backend and with a fake dsh, scope status/shadowing, MCP and Skill promote/demote, target conflicts and replacement, the Windows .cmd launcher, the Electron GUI executable guard, the doctor environment checks including local-registry detection, and the pure `planMounts` merge/expansion logic (standalone plugin test).

## Live CLI checks

Plan:

    dsh-forage plan "帮我检索这几篇 RAG 论文并整理引用，最好只读，不需要密钥" --json --top 5

Observed:

- intent.domains = ["research"]
- intent.tasks = ["文献检索", "引用整理"]
- intent.constraints = ["只读优先", "无需凭证"]
- 5 candidates
- defaultSelection = ["semantic-scholar"]
- one default per scholarly-search group
- project-scope warning because the build directory has no .git

Dry run:

    dsh-forage deploy semantic-scholar --scope user --dry-run

Observed:

- planned command:
  dsh --profile install mcp add semantic-scholar --scope user --transport stdio --timeout 120000 -- npx -y semantic-scholar-mcp
- no process launched
- exit code 0

Fake deployment:

    dsh-forage deploy fake-ok,fake-fail,fake-builtin --catalog tests/fixtures/catalog --scope user --yes --json --dsh-bin tests/fixtures/fake-dsh.mjs

Observed:

- fake-ok: installed
- fake-fail: failed, duplicate-server fix hint
- fake-builtin: available, no command
- exit code 1
- 2 process launches, proving the builtin did not launch anything and the failure did not block the next item

No-default JSON path:

    dsh-forage forge "用 Excel 处理表格并生成图表" --scope user --yes --json

Observed:

- mode = plan
- reason = no-default-selection
- defaultSelection = []
- stdout is valid JSON, no human text

## Third-party metadata checks

Candidate package metadata was read from the npm registry on 2026-10-26. The following were checked for name, version, license, bin, and rough tool surface:

- @pipeworx/mcp-arxiv 0.1.4, MIT
- @pipeworx/mcp-openalex 0.1.2, MIT
- semantic-scholar-mcp 1.0.3, MIT
- zotero-mcp 1.1.0, MIT
- @modelcontextprotocol/server-pdf 2.0.3, MIT
- @negokaz/excel-mcp-server 0.12.0, MIT
- @mindstone/mcp-server-office 0.3.0, FSL-1.1-MIT

dsh-install command forms were checked against @dsh-tools/dsh-install 0.1.1 source:

- mcp add options and -- passthrough
- skills add --scope / --name / --link
- project scope resolution requiring a .git directory
- -e KEY environment-variable reference semantics

## Scope lifecycle checks

A temporary project with a `.git` directory and a temporary DSH_HOME was used to exercise the real CLI without touching the live user profile:

    dsh-forage promote --id paper --yes --json
    dsh-forage status --json
    dsh-forage demote --id paper --yes --json

Observed:

- promote copied the project Skill to the temp user skills root, updated skills-manifest.json to scope user, and removed the project copy.
- status initially showed the user-level entry and no project-level entry.
- demote copied it back to the project skills root, updated the manifest to scope project, and removed the user copy.
- status, MCP argument construction, target conflict, replace, no-git, and JSON paths are covered by the automated suite.

The full suite is 102 tests: 101 passed and 1 POSIX-only test skipped on this Windows host.

## Doctor check — 2026-10-26

After reinstalling DSH 0.2.1-rc.3 to a new install directory, the launchers and the semantic-scholar command still pointed at the removed old runtime path.

    dsh-forage doctor --json

Observed after repairing the launchers and the MCP command:

- 13 ok, 2 warn, 0 error after installing `@dsh-forage/mcp-registry`
- warnings: desktop and install profiles only exempt dsh-install 0.1.1 for 0.2.1-rc.2; these only affect `--backend dsh-install`
- `mcp:mount` is ok; DSH_HOME is writable; the installed Skill matches the source
- `dsh --profile install mcp list` still prints `skipping profile bundle "@dsh-tools/dsh-install"` on rc.3; the local registry plugin is now the mount path.

The doctor is the intended first step after a DSH reinstall or upgrade.

## Local backend verification — 2026-10-26

With DSH 0.2.1-rc.3 and a temporary DSH_HOME, the default local backend was exercised end to end:

    dsh-forage deploy --id semantic-scholar --scope user --yes --json --backend local

Observed:

- report.backend = local; result.status = installed
- mcp.json was created atomically with `command: npx`, `args: ["-y", "semantic-scholar-mcp"]`, `toolCallTimeoutMs: 120000`, `origin.source: dsh-forage`
- the env object contained no literal secret value
- a second deploy with the same name failed without modifying mcp.json
- the suite covers backup preservation, project-scope writes, local Skill copy + manifest, Git-source rejection, MCP promote/demote, and the `--backend local` CLI path
- HTTP MCP entries are written as DSH's accepted `streamable-http` transport (not `http`), and the dsh-install command builder maps `streamable-http` back to `--transport http`
- `remove` and `update` were exercised through the CLI and the local deploy path; old MCP/Skill entries were backed up before replacement/removal, and explicit `--scope` was required
- a second deploy of an already-installed MCP is skipped without touching `mcp.json`, and `plan` reports `installedInScope`
- embedding tests cover a provider that changes the order, cache reuse, failure fallback, deterministic hashed vectors, `--embedding hashed` JSON output, and an HTTP provider against a local OpenAI/Ollama-compatible test server
- local-first matching found the project-scope `nature-figure` and `nature-writing` Skills for "论文撰写和科研绘图"; `plan` returned them in `localMatches`, and `--no-local` suppressed them.
- Discovery-first `plan "解析PDF并提取文本"` queried MCP Registry (translated `pdf` query) and returned registry PDF MCPs as high-risk candidates; `deploy --id registry-ai-pdfassistant-pdfassistant --dry-run --include-high-risk` resolved the discovered snapshot and planned a local MCP write.
- `plan "论文撰写和科研绘图"` returned per-skill candidates; `nature-figure` was tagged `科研绘图` and `nature-writing` `论文撰写`, while an unrelated patent skill from the same repo was filtered. Local matching still returned the installed nature-figure/nature-writing.
- MCP health check was exercised against a fake stdio server: initialize + tools/list returned `ping`/`echo`; a missing command failed before any write.
- Staging wrote `enabled:false`, and `dsh-forage enable` flipped it to true. A two-item batch whose second item failed restored `mcp.json` and skills, with `rollback.restored=true`.
- Native selection JSON (`selection.type=multi_select`, `allowOther=true`) is emitted for the GUI `ask_user_question` path.
- Registry npm candidates are cross-checked against the npm package/version endpoint; the plan carries a Registry-preview warning and GitHub fallback.
- The experimental `dna-map` command, script, and test were removed.
- `software SnapGene --json` returned the official SnapGene download, free/open-source alternatives, a search entry, and a disclaimer containing `不提供破解`; tests reject crack/netdisk markers.
- Source-trust ranking was tested with two equal-task GitHub candidates: a 50k-star/0.9-priority entry outranked a 5-star/0.3 entry, and the reason string exposed `来源信任`/the priority × stars calculation.
- The capability picker accepts `o`/Other free text without changing the current toggle set; deployment/remove/update/promote prompts accept `[y/N/o]` and pause the action on Other so a new plan can be made.
- session scope wrote only `~/.dsh/forage/session-mcp.json`, `status --scope session` reported it, `remove --scope session` emptied it, and session Skill/dsh-install paths were rejected
- `npm pack --dry-run` produced a 129-file tarball with no tests/node_modules; contents are listed in this document's packaging section
- dsh-install remove/update paths were exercised with `tests/fixtures/fake-dsh.mjs`, asserting `mcp remove` / `mcp update` argv

The mount half is provided by the bundled `@dsh-forage/mcp-registry` plugin. It watches the registries, so new entries are hot-mounted and removed entries are unmounted; without the plugin (or with `watch: false`), a restart is required. The config-layer verification above was followed by the mount-layer and watcher verification below.

## MCP registry plugin — 2026-10-26

The bundled plugin was tested in a temporary web profile first:

    dsh plugin --profile web add file:<repo>/plugin
    dsh --profile web --no-open --port 0

Observed in that unconfined test host:

- `[forage] mounts=semantic-scholar:user` and `[forage] mounted semantic-scholar (user)` in stderr
- a marker MCP wrapper wrote its start marker, proving the server child was spawned
- the plugin row appeared in `dsh --profile web --dump-config`
- no dsh-install bundle was loaded

The plugin was then installed into the live desktop profile (manual copy + package.json dependency/bundle; pnpm store mismatch blocked `dsh plugin add`). The running DSH hot-loaded it and exposed all 10 `mcp__semantic-scholar__*` tools; `health_check` returned `OK - server is running` and `version_info` returned `semantic-scholar-mcp 1.0.0`. This is the end-to-end mount evidence for the local backend + bundled registry plugin.

Watcher verification, in a fresh temporary web profile with two marker MCP wrappers:

- started with one entry: `first=True`
- added a second entry to mcp.json: `second=True` within the 500 ms poll window
- removed the second entry: the second server process wrote its SIGTERM/exit marker (`secondTerminated=True`)
- the plugin therefore mounts added entries and disposes removed ones without a restart.

## Real install acceptance — 2026-10-26

Environment:

- DSH 0.2.1-rc.2 desktop, profile desktop, DSH_HOME=%USERPROFILE%\.dsh
- @dsh-tools/dsh-install 0.1.1 installed into both install and desktop profiles
- Exact-version compatibility exemption recorded for DSH 0.2.1-rc.2 (the package's peer range targets 0.1.x)
- Bundled Node 24.21.0; npm 12.2.1 installed under ~/.dsh/tools/npm; node, npm, npx, pnpm shims under ~/.dsh/bin
- MCP: semantic-scholar-mcp 1.0.3

What was executed:

    dsh plugin --profile install allow-version @dsh-tools/dsh-install@0.1.1 --dsh-version 0.2.1-rc.2 --accept-risk
    dsh plugin --profile install add @dsh-tools/dsh-install@0.1.1
    dsh --profile install mcp list --format json

    dsh-forage deploy semantic-scholar --scope user --yes --json

The real dsh-install run reported:

    ✅ 已导入 (1)
       added semantic-scholar to user scope (stdio)
    摘要: 1 导入 · 0 部分 · 0 未迁移 · 0 失败

Registry and audit evidence:

- ~/.dsh/mcp.json contains the semantic-scholar stdio entry.
- dsh --profile install mcp get semantic-scholar returns the expected entry.
- ~/.dsh/logs/install.jsonl contains the mcp add semantic-scholar verdict with IMPORTED.

Desktop mount:

- dsh-install was added to the desktop profile and its mcp-registry row was enabled in cordis.patch.yml.
- The running desktop hot-loaded the aggregator; a child process was observed:

      node.exe <DSH_HOME>\tools\mcp\semantic-scholar\node_modules\semantic-scholar-mcp\dist\index.js

- The MCP health_check tool returned OK - server is running.
- The session tool catalog exposed all 10 Semantic Scholar tools, including search_papers, paper_citations, and paper_authors.

Initial startup issue and fix:

- The first mount used npx -y semantic-scholar-mcp; the server was listed but disconnected because the already-running desktop process did not have the new npx shim on its PATH.
- For this instance, the registry entry was updated to launch the bundled Node executable with the installed server file directly. The aggregator restarted the server and the health check passed.
- A full DSH restart should pick up ~/.dsh/bin from the user PATH and make the npx form work for future installs; that post-restart path was not re-verified in this session.

Upstream check:

- search_papers returned TypeError: fetch failed.
- A direct request to https://api.semanticscholar.org/graph/v1/paper/search returned HTTP 429 (Too Many Requests). This is an upstream rate-limit condition, not an MCP transport failure. The server process and health check remained healthy.

## Command, session, and npm packaging — 2026-10-27

- `/forage` command plugin unit tests: parsing, plan/status/doctor/catalog formatting, mutation rejection, GitHub mode, and fake `ctx.commands.register` registration (7 tests).
- The command plugin was installed into the desktop profile and the registry plugin was updated to watch the session overlay; the running app needs one restart to load both, so live GUI rendering is not yet re-verified.
- Session scope CLI tests run against a temporary DSH_HOME: deploy writes only `forage/session-mcp.json`, status reports `sessionMcps`, remove empties it; session Skill and dsh-install paths return `SESSION_SKILL_UNSUPPORTED` / `SESSION_BACKEND_UNSUPPORTED`.
- The registry plugin's `planMounts` test gives session entries precedence over project and user; the plugin resets the session file on load and deletes it on unload.
- `npm pack --dry-run` at 0.2.0 produced 129 entries, 194 KB packed / 828 KB unpacked, with no tests or node_modules; `npm publish --dry-run --no-provenance` completed the pack/publish simulation.
- GitHub discovery unit tests cover short task queries, a nature-skills-style monorepo (`skills/*/SKILL.md`), discovery metadata, schema validation, and inferred `npx` for an MCP package. A live run found `Yuan1z0825/nature-skills`; subsequent unauthenticated runs hit GitHub API rate limits, so the token path is not fully exercised.
- The GitHub Skill materializer was exercised against the real `Yuan1z0825/nature-skills` codeload archive: it extracted only `skills/nature-figure` (131 files, ~35 MB) into the cache, and a local-backend `deploy` installed it into a temporary DSH_HOME in ~13 s without dsh-install.
- No npm login is configured on this machine (`npm whoami` = ENEEDAUTH), so no real registry publication was performed. The name `dsh-forage` is currently unclaimed on npm.

## Not verified

- Every candidate's server starts successfully with its declared npx command on a clean network.
- Post-restart npx resolution for MCP child processes (the absolute-node form is verified).
- Live Web GUI rendering of `/forage` after a restart; the current command is text/plan output, not a rich picker.
- Strong multi-session isolation for session MCP scope; tools are host-global while mounted.
- Real npm publication (no auth/OTP on this machine), plus provenance from CI.
- GitHub discovery with a real token / core API budget; the unauthenticated contents API is rate-limited (README fallback and a real `nature-figure` local install were verified).
- Semantic Scholar search under a non-rate-limited API quota.

## Reproduce

    npm ci
    npm test
    node dist/src/index.js plan "帮我检索 RAG 论文" --json --scope user
    node dist/src/index.js deploy semantic-scholar --scope user --dry-run

To test the deployment path without dsh installed:

    node dist/src/index.js deploy fake-ok,fake-fail,fake-builtin --catalog tests/fixtures/catalog --scope user --yes --json --dsh-bin tests/fixtures/fake-dsh.mjs