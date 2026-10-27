# Changelog

## 0.2.0 — 2026-10-27

Second functional release: interactive command surface, ephemeral scope, model embeddings, and npm packaging.

### Added

- Deterministic Chinese/English intent parser with domains, tasks, signals, constraints, and structured --intent input.
- Validated catalog schema and loader with built-in, project, and --catalog sources.
- Research catalog: semantic-scholar, openalex, arxiv, zotero, pdf-reader.
- Office catalog: office-builtin, excel, office-live.
- Hybrid ranking with domain / task / signal / lexical similarity, risk, constraints, and editorial weight.
- Safety defaults: low-risk read-only, credentials present, relevant, at most 2, one per group.
- CLI picker with toggles, ranges, all/none, help, cancel.
- Human approval; non-interactive deploy requires --yes.
- Local deployment backend: atomic mcp.json writes with `mcp.json.bak-*` backups, duplicate-name refusal, `${KEY}` env references, project-scope `.dsh/mcp.json`, local Skill copy + manifest, and local MCP promote/demote.
- `plugin/`: minimal `@dsh-forage/mcp-registry` Cordis bundle that reads and watches mcp.json, mounts enabled servers through `@deepseek-ai/dsh-mcp-client`, and hot-unmounts removed entries; user/project merge, env references, streamable-http, missing-env warnings, no install/remove audit.
- `--backend auto|local|dsh-install`: auto keeps dsh-install only when `--dsh-bin`/`DSH_FORAGE_DSH_BIN`/a runner is explicit; otherwise it uses the local writer.
- dsh-install command construction for stdio MCP, HTTP MCP, skill, and builtin (now opt-in).
- Per-item orchestration with failure isolation, fix hints, timeouts, and exit codes.
- Secret redaction, Windows .cmd launcher, .mjs test launcher.
- JSON plan / deploy / catalog outputs and structured errors.
- SKILL.md for DSH skill installation.
- Scope management: status, promote, demote, --replace, --keep-source, project-first lifecycle.
- `remove` / `update` for MCP and Skill; local runs back up first, `--backend dsh-install` delegates to dsh's own remove/update commands; both require an explicit `--scope`.
- `command-plugin/`: a separate read-only `/forage` host command for the Web GUI and interactive CLI (`plan`, `status`, `doctor`, `catalog`, `help`); install/remove/update stay behind the terminal approval gate.
- Ephemeral `--scope session` for MCP: writes `~/.dsh/forage/session-mcp.json`, the registry plugin watches it, and the plugin deletes it on load/unload so it never survives a restart. Session Skills are refused because DSH has no per-session skill scanner.
- `HttpEmbeddingProvider` for OpenAI-compatible `/api/embed` endpoints, configured by `DSH_FORAGE_EMBEDDING_URL`, `DSH_FORAGE_EMBEDDING_API_KEY`, and `DSH_FORAGE_EMBEDDING_MODEL`; `--embedding http|auto` with timeout/error fallback to lexical ranking.
- Native GUI selection payload: `plan.selection` (multi_select + allowOther) for `ask_user_question`; terminal picker keeps `o`/Other.
- Safe batch deployment: pre-install MCP initialize/tools/list health check, staging abort before writes, discovery items default `enabled:false`, `--staged`/`--activate`, `enable` command, batch backup of mcp.json/manifest/skills, and automatic rollback on failure.
- Registry quality: npm package/version cross-check before recommending a Registry candidate, preview warning, GitHub fallback, and stored discovery snapshot.
- Removed the experimental `dna-map` command and the bundled Python renderer.
- Discovery-first planning: `plan`/`forge` query the public MCP Registry and GitHub by task-derived queries, normalize/deduplicate candidates, rank by task/source quality/risk, snapshot discovered candidates for `deploy --id`, and fall back to the catalog only on empty/failed discovery. Add `--offline` and `DSH_FORAGE_DISCOVERY=off`.
- `dsh-forage software`: official/free-open-source/search entries for desktop prerequisites (SnapGene, Benchling, ApE, UGENE, Biopython, sgffp), with license notes and a no-cracked/no-netdisk disclaimer.
- GitHub discovery source trust: `sourcePriority × normalized stars` (`log10(stars+1)/5`) as a capped +30 ranking weight; official orgs 0.95, then 50k/10k/1k/100-star tiers. Task/risk still dominate; candidates remain unverified high risk.
- `Other` free-text choice in every interactive selection: local-first (yes/no/other), capability picker, deployment, remove, update, and promote/demote approvals; custom input pauses or extends the search instead of forcing a preset.
- Local-first matching: `plan` returns `localMatches` for already-installed Skills/MCPs; `forge` asks whether to use them before catalog/GitHub search; `--no-local` explicitly continues the search.
- GitHub Skill local installation: codeload tar.gz download, subdirectory-only extraction with path/symlink/size guards, a 24h cache under `~/.dsh/forage/github-src`, and local Skill copy; dsh-install is no longer required for discovered GitHub Skills.
- npm 0.2.0 packaging: `files` allowlist, `prepack`/`prepublishOnly`, public `publishConfig`, `.github/workflows/publish.yml` with provenance, and `docs/release.md`.
- Installed-state detection before deploy: already-installed candidates are skipped with an update/remove hint instead of failing; `plan` exposes `installedInScope`.
- Pluggable embedding ranking (`src/ranker/embeddings.ts`): deterministic hashed fallback, cache, timeout, and lexical fallback on provider failure; `--embedding hashed`.
- `doctor` environment self-check: DSH_HOME, launcher targets, MCP command/entry paths, workspace-inside-install-dir, stale installed Skill, installer exemptions.
- `--dsh-bin` rejects an Electron GUI executable with a clear fix instead of silently opening the desktop app.
- 102 project tests plus 4 registry plan tests and 8 `/forage` command tests (`npm run test:plugin`), catalog guide, architecture ADR, roadmap, security policy, npm publish workflow.

### Known gaps

- One real Windows desktop acceptance was recorded on 2026-10-26: dsh-install 0.1.1 + semantic-scholar + MCP health_check. dsh-install 0.1.1 needs an exact-version exemption on DSH 0.2.x and is skipped by 0.2.1-rc.3; the local backend is the default workaround.
- Local writes need the bundled `@dsh-forage/mcp-registry` plugin (or another compatible registry) to mount MCPs; it watches the registry and hot-mounts changes, but does not provide dsh-install's install/remove audit or Git/npm skill installs. Local Skill sources are limited to local `.md`/directory sources. `remove`/`update` use local backups or dsh's own commands; dsh-install must actually be loaded. Duplicate MCP names are skipped by deploy; use update for replacement.
- No GUI, slash command, session-only scope, model-backed embedding provider, or npm release.
- Some third-party candidate metadata can age; verifiedAt records the check date.