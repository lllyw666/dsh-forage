# Roadmap

dsh-forage is deliberately small. The roadmap follows one rule: do not add a layer that dsh-install or DSH already owns. The local backend writes the registry DSH already owns only because dsh-install 0.1.1 is incompatible with DSH 0.2.x; hot mount, removal audit, and Git/npm skill sources stay with dsh-install.

## v0.1 — closed loop

Status: implemented and covered by 102 tests.

- [x] Rule-based intent parser with Chinese / English keywords, constraints, and structured intent input.
- [x] Validated catalog with research and office candidates.
- [x] Hybrid ranking: domain, task, signals, lexical similarity, risk, constraints, editorial weight.
- [x] CLI picker with ranges, toggles, all/none, cancel.
- [x] Safety defaults: low-risk read-only, credentials present, at most 2, one per group, relevance required.
- [x] Explicit approval; --yes required in non-interactive mode.
- [x] Local backend: atomic mcp.json/skills writes, backups, duplicate refusal, env references, project scope, local Skill + manifest, MCP promote/demote.
- [x] Minimal MCP registry plugin (`plugin/`): reads mcp.json, merges user/project, expands env/headers, mounts via @deepseek-ai/dsh-mcp-client, watches for hot mount/unmount; no install/audit CLI.
- [x] `remove` / `update` for MCP and Skill; explicit `--scope`; local backups or dsh-install commands.
- [x] dsh-install command construction for stdio MCP, HTTP MCP, skill, and builtin (opt-in via --backend dsh-install).
- [x] Independent per-item deployment with failure isolation and fix hints.
- [x] JSON output and structured errors.
- [x] Secret redaction and Windows .cmd launcher.
- [x] SKILL.md and catalog contribution guide.
- [x] Project-first scope policy; status, promote, and demote for MCP and Skill, with conflict and replacement handling.
- [x] Skill manifest synchronization; backup/restore for failed transfers.
- [x] Environment doctor: launcher targets, MCP command/entry paths, workspace-inside-install-dir, stale installed Skill, installer exemptions.

Acceptance recorded on 2026-10-26: dsh-install 0.1.1 installed semantic-scholar on DSH 0.2.1-rc.2 desktop, the aggregator hot-mounted it, and the MCP health_check tool succeeded. The run required an exact-version compatibility exemption because dsh-install 0.1.1 declares 0.1.x peers. On DSH 0.2.1-rc.3 the installer is skipped; the local backend wrote semantic-scholar into a temporary DSH_HOME, and the bundled `@dsh-forage/mcp-registry` then mounted it in a temporary web profile and in the live desktop profile (10 `mcp__semantic-scholar__*` tools, health_check OK). Post-restart npx resolution and a clean-machine repeat are still open.

## v0.2 — recall and state

- [x] Installed-state detection before deploy: target-scope MCP/Skill lookup, skip with an update/remove hint, and `installedInScope` in plan JSON.
- [x] Local-first matching: relevant installed Skills/MCPs are returned before search; `forge` asks whether to use them, and `--no-local` explicitly continues.
- [x] Remove/update on both backends: local backups; dsh-install `mcp remove` / `mcp update` / `skills remove` / `skills update`.
- [x] Embedding provider interface with a deterministic hashed fallback, vector cache, timeout, and lexical fallback; plus an OpenAI-compatible HTTP provider (`--embedding http|auto`).
- [x] Read-only `/forage` host command (`command-plugin/`) for the Web GUI and interactive CLI: plan/status/doctor/catalog/help.
- [x] Ephemeral session MCP overlay: `--scope session`, plugin watcher/cleanup, status/remove; session Skills and dsh-install are rejected.
- [x] npm packaging: 0.2.0 files allowlist, prepack build, publish workflow, and dry-run verification.
- [x] Native GUI selection payload (`multi_select` + Other) for `ask_user_question`; terminal picker remains equivalent.
- [x] Safe batch install: MCP health check before writes, staging/`enabled:false`, `--staged`/`--activate`, batch backup and automatic rollback, `enable` command.
- [x] Registry hardening: npm package/version cross-check and preview warning; GitHub fallback and discovery snapshot.
- [x] Removed the experimental `dna-map` fallback.
- [x] Discovery-first planning: MCP Registry + GitHub by default, task-query translation, candidate normalization/dedupe, per-skill relevance, discovery snapshots, catalog fallback, `--offline`.
- [x] Software prerequisite resolver: official/free-open-source/search links only, license notes, no cracked/netdisk links; manual install.
- [x] Source-trust weighting for GitHub discovery: official-org priority × normalized stars, capped at +30; unverified candidates stay high risk.
- [x] Opt-in GitHub discovery: short task-keyword queries, repository search, `skills/*/SKILL.md`/`package.json` inspection, unverified high-risk candidates, and a generated cache for deploy.
- [x] GitHub Skill local installation: codeload archive download, subdirectory-only extraction with path/symlink/size guards, 24h cache, and local Skill copy.
- [ ] Make GitHub discovery a fully pluggable candidate-source interface (tokens, marketplace sources, user preference).
- [x] Tests for duplicate installed state and re-run behavior (skip instead of overwrite).
- [ ] Integrate @khorsheed/dsh-capability-catalog for post-install verification. Its real model tool is list_capabilities, which enumerates the current instance; it is not a search over installable candidates.
- [ ] Add a pluggable candidate-source interface. Keep the curated catalog as the default source; do not silently scrape arbitrary registries.
- [ ] Improve ranking with user feedback ("not relevant" / "installed before").

## v0.3 — interaction and scope

- Independent Web GUI **graphical picker page** (native `ask_user_question` multi-select/Other already works via `plan.selection`; `/forage` itself remains text). Reuse the existing Web infrastructure; do not start a second server.
- Session **Skills** support, if DSH exposes a per-session skill scanner; MCP session scope is already implemented as an ephemeral overlay.
- Stronger per-session MCP isolation; current `mcp-client` tools are host-global while mounted.
- Non-fatal fallback for failed installs with a "retry" action.
- Richer result panel with per-item logs and copyable fix commands.

## v1.0 — publishable

- Publish dsh-forage to npm (packaging/workflow ready; registry auth/provenance pending).
- CI matrix on Linux, macOS, Windows with Node 20/22.
- Demo GIF showing task -> candidates -> select -> install -> immediate use.
- Real acceptance checklist and a recorded transcript.
- Catalog review rotation and a provenance/signature policy.
- Security audit of command construction and secret handling.
- Documentation in Chinese and English.
- Contribution guide and issue templates.
- At least 3 external catalog contributors.

## Non-goals

- A general MCP package manager or registry.
- A universal marketplace/aggregator.
- Silent installation.
- Reimplementing dsh-install's hot mount, registry, audit, or removal.
- A second web server for the GUI.
- Claiming sandboxing of third-party MCP servers. dsh-forage is a decision and approval layer, not a runtime sandbox.

## Success metrics

- A new user can go from a task sentence to a working capability in under 60 seconds, with a dry-run first.
- At least 70% of plans produce a candidate the user considers relevant.
- Default selections have a low write/high-risk rate (target: zero).
- Failed deployments produce a fix hint that names the actual missing prerequisite.
- Catalog entries remain verifiable: every entry has a source, license, version, and verifiedAt.