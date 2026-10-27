# dsh-forage architecture

Status: v0.2.0, implementation notes and decision record.

## Context

DeepSeek Harness already has an installer. @dsh-tools/dsh-install owns registry-backed MCP / Skill installation, hot remounting, removal, and an audit log. What it deliberately does not own is the decision before installation:

- which capabilities are relevant to a free-form task;
- which are safe enough to preselect;
- what the user needs to know before approving;
- how to turn one user selection into a sequence of independent install operations.

dsh-forage is a thin decision layer above dsh-install. It must not reimplement package management, registries, hot reload, or config file formats.

## Goals

1. Turn a task description into a small ranked candidate set.
2. Expose enough metadata for an informed decision: risk, write behaviour, credentials, prerequisites, license, version.
3. Keep the human in the loop, always.
4. Make each installation an independent transaction with an explicit result.
5. Be scriptable from a DSH Skill without giving up approval.
6. Keep the catalog cheap to contribute and easy to validate.

## Non-goals

- A general-purpose MCP package manager.
- A new remote registry or marketplace.
- Silent / unattended installation as the default.
- Replacing dsh-install's registry, audit, or hot-mount code.
- A GUI in v0.1.
- Vector search in v0.1.

## Pipeline

    task text
       |
       v
    Intent Parser  ---- optional --intent/--intent-file (model-provided)
       |
       v
    Candidate Ranker <---- catalog/*.json + project catalog + --catalog
       |
       v
    Picker (CLI) / JSON output
       |
       v
    Human approval
       |
       v
    Deploy Orchestrator
       |
       +--> dsh --profile install mcp add ...
       +--> dsh --profile install skills add ...
       +--> builtin: no command, status "available"
       |
       v
    per-item report + summary + exit code

The DSH Skill sits beside the CLI: it uses the same plan JSON, presents a compact table, asks the user, then invokes deploy. There is no second business logic path.

## Intent parsing

Input: one task description, up to 8000 characters.

Output:

    {
      "tasks": ["文献检索", "引用整理"],
      "domains": ["research"],
      "signals": ["论文", "引用", "RAG"],
      "constraints": ["只读优先", "无需凭证"],
      "confidence": 0.74,
      "locale": "mixed"
    }

v0.1 is deterministic and local:

- Domain rules for research / office / development, with Chinese and English keywords.
- Task rules that map keyword hits to a fixed task vocabulary.
- Constraint rules for read-only, local, no-credentials, no-install, privacy.
- ASCII terms use word boundaries; CJK terms use substring matching.
- Domain inclusion threshold is 50% of the strongest domain, capped at 3 domains.
- No network, no model call, no credentials.

A model can provide better structure through --intent or --intent-file. The CLI validates and normalizes the JSON: Chinese domain aliases such as 科研 become research; constraint aliases such as read-only become 只读优先; if both prose and structured intent are present, the structured intent wins and prose only fills missing tasks/signals.

Why rules first: the MVP must work offline, be testable, and fail predictably. The model-facing path is an optimization, not a dependency.

## Catalog

The curated catalog is now an **offline fallback and verified seed**, not the default source. `plan`/`forge` prefer live discovery (MCP Registry + GitHub); catalog candidates are used when discovery is disabled, unavailable, or returns nothing.

A catalog file has a domain and a list of candidates. The validator enforces:

- schemaVersion == 1;
- a known domain;
- unique candidate IDs within a file;
- kebab-case IDs and server names;
- required name / description / domains / tasks / tools / risk / credentials / install;
- known risk levels and boolean risk fields;
- MCP credentials must also appear in install.env, because that is how dsh-install receives an environment-variable reference rather than a literal secret;
- stdio installs require command and args, and must not carry url;
- HTTP installs require an http(s) URL, and must not carry command;
- skill installs require a source;
- builtin installs require a provides list;
- candidate type must match install kind;
- URLs and verifiedAt are validated when present.

Loading order:

1. built-in catalog JSON under the package root
2. explicit --catalog files or directories, repeatable (a project catalog such as .dsh/forage/catalog requires this opt-in)

Project catalogs are not auto-loaded: a workspace-controlled catalog is executable input and should not appear merely because a repository was cloned. Duplicate IDs across sources are a hard error. Project or third-party catalogs cannot silently shadow the built-in catalog.

Why a hard error: a shadowed candidate could change a command, risk level, or credential declaration while keeping a familiar ID. Failing loud is preferable to a silent behavior change. A future version can add an explicit override flag with a diff.

### Discovery sources

`plan`/`forge` run discovery by default. The MCP Registry source queries `/v0.1/servers?search=...` with translated task queries and maps npm packages or remote HTTP endpoints into `Candidate` objects. GitHub derives short repository-search queries from `intent.tasks` and `intent.signals`, inspects at most three repositories, and reads only `skills/*/SKILL.md` or a root `SKILL.md` plus `package.json`. Both normalize candidates with a `discovery` block (source, URL, stars/quality, query, package verification). Every discovered candidate is forced to `risk.level = high` and is therefore never default-selected.

Discovered candidates are written to `~/.dsh/forage/discovered.json`; `deploy --id` merges that snapshot to resolve IDs. A GitHub Skill's `github:owner/repo#subdir@ref` source is materialized by the local backend: download the codeload tar.gz, extract only that subdirectory under `~/.dsh/forage/github-src` with path checks and size limits, then install it like a local Skill. Registry npm candidates are cross-checked against the npm package/version endpoint; Registry remains a preview source, so GitHub is always queried as a fallback and health checks run before install. GitHub API limits and tokens are handled as warnings, not as plan failures. `--offline` forces the catalog path.

### Local-first matching

Before presenting catalog/GitHub candidates, `plan` calls `findLocalMatches` against the effective installed MCP registry and skill roots. It scores names, frontmatter descriptions, SKILL.md text, and catalog metadata against the intent's tasks/signals; project-scope skills win over user-scope duplicates, and shadowed MCPs are skipped. The result is advisory: `plan` exposes `localMatches`, the interactive `forge` path asks whether to use them first, and a no answer reruns with `--no-local`. A local match is not a capability or security verification; it only avoids duplicate installation when the user already has the relevant Skill/MCP.

Every interactive selection also exposes a free-text **Other** choice. In the local-first prompt it means "keep the local matches and also search" (or a new instruction); in the capability picker it records a custom combination without changing the current toggle set; in deployment/remove/update/promote approvals it pauses the action so the caller can re-plan. The JSON plan carries `localMatches` and `userNotes` for non-interactive agents to implement the same rule.

## Safe deployment and native selection

Before writing a batch, `deploy` runs an MCP health check (`initialize` + `tools/list` over stdio or `initialize` over HTTP) for each eligible MCP. Any failure aborts the whole batch before a write. The local backend then creates a batch backup containing `mcp.json`, `skills-manifest.json`, and the skills root; a write failure restores all three. Discovered candidates and `--staged` installs write `enabled:false`, and `enable --id` flips the entry after review. `--activate` forces enabled. Health check can only be skipped explicitly with `--no-health-check`.

`plan --json` emits a `selection` object (`type: multi_select`, `allowOther: true`, options derived from candidates). The GUI agent can pass this to `ask_user_question` for a native checkbox panel with a free-text Other answer; the terminal picker remains the fallback.

## Discovery-first

`plan`/`forge` default to live discovery instead of starting from the curated catalog. The flow is: translate intent tasks/signals into short English-oriented queries, query the public MCP Registry (`/v0.1/servers?search=...`) and GitHub in parallel, normalize both into `Candidate` objects, deduplicate by source identity, enforce a two-skills-per-repo cap, and rank with task relevance, source quality, and risk. GitHub skill task tags are derived from the skill name (not incidental words in its body), so a manuscript skill that merely mentions figures is not tagged as a plotting skill. Registry candidates carry npm package pins or remote HTTP URLs; GitHub Skills re-use the codeload materializer.

Discovered candidates are written to `~/.dsh/forage/discovered.json`; `deploy --id` merges that snapshot so a candidate can be installed after the plan. If discovery returns nothing or fails, plan falls back to the catalog with a warning; `--offline` forces that path and `DSH_FORAGE_DISCOVERY=off` gives deterministic test behavior.

## Ranking

For each candidate, the ranker combines:

- domain overlap: +35, with a small +8 base when the intent is "other";
- exact task overlap: +18 each, capped at +54;
- signal overlap against id/name/description/domains/tasks/tools/notes: +3 each, capped at +18;
- lexical similarity between the intent vocabulary and candidate text: up to +18 at a 0.12 threshold;
- risk: low +6, medium +1, high -8;
- builtin: +4;
- editorial weight: 0..1, multiplied by 8;
- GitHub discovery source trust: `sourcePriority × clamp(log10(stars+1)/5)` × 30, capped at +30; official orgs 0.95, ≥50k stars 0.9, ≥10k 0.8, ≥1k 0.65, ≥100 0.5, otherwise 0.3. The log normalization prevents raw stars from overwhelming task relevance;
- missing credentials: -8;
- constraint penalties: read-only + writes -30, no-credentials + credentials -25, local/privacy + external requests -8/-15.

The default semantic layer is lexical: it tokenizes English words and CJK bigrams and uses Jaccard similarity. A second, optional layer (`src/ranker/embeddings.ts`) accepts an `EmbeddingProvider`, caches vectors by provider+text, applies cosine similarity as a bounded score boost, and falls back to the lexical ranker on provider error or timeout. The bundled `hashed-lexical` provider is deterministic and offline; `src/ranker/http-embedding.ts` implements an OpenAI-compatible `/api/embed` client for `--embedding http` (configured by `DSH_FORAGE_EMBEDDING_*`) without blocking a plan.

The final ordering is score desc, risk asc, weight desc, id asc. The top N (default 5) is returned.

## Software prerequisites

When a capability requires a desktop application, `dsh-forage software <name>` returns a curated prerequisite record: official vendor URL, free/open-source alternatives, a browser search entry, license notes, and a disclaimer. It never returns cracked builds, activation bypasses, netdisk links, or direct binaries, and it does not install or execute the application. This keeps the software layer separate from MCP/Skill installation and avoids turning the catalog into an unverified download index.

## Default selection

This is the most important safety decision in the product.

A candidate is eligible for default selection only when all of the following hold:

- it matches the intent by domain or task (no unrelated low-risk candidate is preselected);
- risk level is low;
- writes is false;
- sensitive permissions is false;
- no credentials are missing;
- there is no desktop-app or manual-setup prerequisite;
- it does not violate an explicit constraint such as read-only or no-credentials.

Then the ranker applies two additional caps:

- at most 2 default selections;
- at most one candidate per editorial group.

Groups are how the catalog avoids installing three equivalent scholarly-search servers at once. For example, semantic-scholar, openalex, and arxiv all use group "scholarly-search"; only the best-scoring one is selected by default. Alternatives remain visible and can be selected manually.

Built-in candidates are not automatically selected when they write files. The office-builtin candidate has risk medium and writes true, so the user must choose it explicitly. This is intentional: "already installed" does not mean "safe to invoke without consent" for a write operation.

## Picker

The CLI picker groups candidates by their first domain and displays:

- selection state and rank;
- type / risk / write tags;
- description;
- task labels, tool count, external-request flag, credential names;
- default reason or the reason it was not defaulted;
- ranking reasons and the first prerequisite.

Selection input supports:

- numbers: 1,3,5
- ranges: 1,3-5
- a / all
- n / none
- ? / help
- q / quit / cancel
- empty line: accept current selection

Numbers toggle. This makes the default set a starting point rather than a lock-in.

In non-interactive or --json mode, no prompt is shown; defaults are used for planning. A real deployment still requires --yes, so "no prompt" never becomes "no approval".

## Deployment backends

`auto` is the default. It chooses the local backend unless the caller explicitly supplies `--dsh-bin`, `DSH_FORAGE_DSH_BIN`, or a `DeploymentRunner`; those explicit signals keep the old dsh-install path for scripts and tests. `local` and `dsh-install` force one backend.

The local backend writes the same registry files DSH reads:

- user scope: `~/.dsh/mcp.json`, `~/.dsh/skills/`, `~/.dsh/skills-manifest.json`;
- project scope: `<project>/.dsh/mcp.json`, `<project>/.dsh/skills/`;
- before every write it copies the old registry to `mcp.json.bak-<timestamp>`, then writes a temp file and replaces the target;
- env keys are stored as `$` + `{KEY}` references, never literal values;
- an existing MCP name is rejected rather than overwritten;
- local Skill sources must be a local `.md` file or a directory containing `SKILL.md`; Git/npm sources require `--backend dsh-install`;
- local writes do not mount by themselves; the bundled `plugin/` (`@dsh-forage/mcp-registry`) reads and watches the registry and mounts/unmounts enabled servers (no restart needed when the watcher is active).

The dsh-install backend preserves hot mounting, removal audit, and Git/npm skill sources, at the cost of depending on a plugin that is incompatible with DSH 0.2.x as of 0.1.1.

### Mount layer

DSH's base profile has no MCP registry or MCP client mount; a config writer alone is inert. The project ships a minimal Cordis bundle in `plugin/`:

- it reads `~/.dsh/mcp.json`, `<cwd>/.dsh/mcp.json`, and `~/.dsh/forage/session-mcp.json`, with session > project > user precedence;
- it expands `$` + `{VAR}` references in `env`/`headers`, omitting and warning about missing variables;
- it mounts each enabled server through `@deepseek-ai/dsh-mcp-client` and disposes the child fibers on unload;
- it polls the registries and hot-mounts/unmounts changes; it has no install/remove/audit CLI and performs no third-party download;
- it deletes the session overlay when the plugin loads or unloads, so session entries never survive a restart.

The desktop host's cwd is the application directory, so project-scope entries are normally consumed by a web/headless profile whose cwd is the project; desktop use is usually user scope. `dsh-forage doctor` reports `mcp:mount` as ok when `@dsh-forage/mcp-registry` appears in a profile's dependencies.

### Command surface

`command-plugin/` is a separate Cordis bundle with `inject: ["commands"]`. It registers a read-only host command `/forage` through `ctx.commands.register`; the Web client's slash-command adapter renders it without creating a model message. The handler spawns the configured CLI entry (`config.cli` or `DSH_FORAGE_CLI`) with Node/Electron-as-Node and formats `plan`, `status`, `doctor`, or `catalog` JSON. Install/remove/update are deliberately rejected so the terminal approval gate remains authoritative. The plugin is separate from the registry plugin so headless profiles without a command service keep mounting MCPs.

## npm packaging

The package is a single public npm package with a `files` allowlist: `dist/src`, `catalog`, `plugin` runtime files, `command-plugin` runtime files, docs, and the root Skill/docs. Tests and build-only extraction are excluded. `prepack` builds; `.github/workflows/publish.yml` publishes tagged releases with provenance. The two Cordis bundles remain subdirectories, not separate published packages.

## Deployment contract (dsh-install backend)

Commands are built as argv, never as one shell string:

    dsh --profile install mcp add <server> --scope <user|project> --transport stdio \
      [-e KEY ...] [--cwd DIR] [--timeout MS] -- <command> <args...>

    dsh --profile install mcp add <server> --scope <user|project> --transport http \
      --url <url> [--header "Key: Value" ...]

    dsh --profile install skills add <source> --scope <user|project> \
      [--name <name>] [--link]

These forms were checked against @dsh-tools/dsh-install 0.1.1. The -- separator is essential: everything after it is the MCP child command. Env values are not passed; -e KEY tells dsh-install to store an environment-variable reference.

Limits:

- project scope requires a .git directory; both backends resolve the project root from the nearest .git;
- dsh-install 0.1.1 has no session-only scope; dsh-forage's local session overlay is separate, ephemeral, and MCP-only;
- on Windows, npm installs dsh as dsh.cmd; Node cannot spawn a .cmd directly without a shell. dsh-forage uses a cmd /d /s /v:off /c wrapper with conservative argument quoting and rejects dangerous metacharacters. A .mjs or .exe launcher avoids the wrapper entirely.

Each item is an independent operation:

- already installed in the target scope and not a replace/update -> skipped with an update/remove hint;
- missing credential -> skipped, no command attempted;
- high risk without --include-high-risk -> skipped;
- builtin -> available, no command;
- dry-run -> planned, no command;
- command exit 0 -> installed;
- command non-zero / timeout / spawn error -> failed with a fix hint.

There is no rollback across items. A failed item does not undo a successful one. This is the correct tradeoff for an installer whose own operations are independent and audited.

## Scope lifecycle

New capabilities default to project scope. Project scope keeps a capability out of unrelated projects and therefore out of their tool-schema baseline. It requires a Git root because both backends resolve the project root from the nearest `.git` directory.

The lifecycle commands are:

    dsh-forage status [--scope user|project|session] [--json]
    dsh-forage remove --id <id> --scope user|project|session [--kind mcp|skill] [--yes]
    dsh-forage update --id <id> --scope user|project|session [--kind mcp|skill] [--yes]
    dsh-forage promote --id <id> [--kind mcp|skill] [--replace] [--keep-source] [--yes]
    dsh-forage demote --id <id> [--kind mcp|skill] [--replace] [--keep-source] [--yes]

Status reads the user and project MCP registries and both skill roots. It reports scope, path, catalog tool count, and same-name shadowing. It is a read-only view; it does not mutate dsh-install state.

`remove` and `update` are explicit maintenance commands. Both require `--scope` and `--yes` in non-interactive use. With the local backend, `remove` backs up the entry before deleting it and `update` re-deploys the catalog candidate with replace semantics, backing up the old MCP/Skill. With `--backend dsh-install`, both build dsh's own `mcp remove` / `mcp update` / `skills remove` / `skills update` command and run it through the same client; backups are dsh-install's responsibility. Before deploy, the orchestrator checks the target scope and skips an already-installed candidate with an update/remove hint instead of failing; `plan` exposes the same state as `installedInScope`.

`session` is an ephemeral MCP overlay, not a fourth persistent scope. The CLI writes `~/.dsh/forage/session-mcp.json`; the registry plugin merges it over project and user, watches it, and deletes it when the plugin loads or unloads, so it never survives a restart. `mcp-client` tools are host-global, so this is not a strong isolation boundary for concurrent sessions; session Skills are rejected because DSH has no per-session skill scanner.

`dsh-forage doctor [--json]` is the environment-side counterpart: it checks DSH_HOME, launcher targets, MCP command/entry paths, whether the workspace is inside the DSH installation directory, installed Skill freshness, and dsh-install exemptions. Errors exit 1; warnings do not fail the command.

Transfer is always source-first and target-second:

1. Resolve the source entry and target conflict.
2. Require explicit approval unless dry-run.
3. Install/copy to the target.
4. Verify success.
5. Remove the source only when the target succeeded and --keep-source was not set.
6. Report source-removal failures as warnings; the target remains usable.

MCP transfer rewrites the two local registries by default, preserving command, args, env references, cwd, timeout, headers, and enabled state. `--backend dsh-install` uses add/remove instead. If an entry has literal env values, the transfer refuses rather than copying a secret into the broader scope. When replacing a target, the old target entry is captured so a failed write can attempt restoration.

Skill transfer uses direct file copy plus a manifest update. dsh-install's skill manifest is keyed by skill name, not scope, so adding the same skill in another scope would otherwise be rejected as a duplicate. The transfer copies the bundle or flat file, updates skills-manifest.json with the new scope/target/source, then removes the source. A target replacement is backed up; a failed copy or manifest write removes the partial target and restores the backup and manifest text. This deliberately bypasses dsh-install's audit for the skill copy; the manifest and status remain authoritative.

The promotion decision is manual on purpose. Project-level trial reduces baseline context, but promotion broadens tool exposure to every project. dsh-forage does not infer promotion from usage or session logs; the user decides after trying the capability.

## Human approval and secrets

- deployCandidates throws CONFIRMATION_REQUIRED unless yes is true or dryRun is true.
- The CLI asks y/N in a TTY; non-interactive callers must pass --yes.
- --yes is the explicit approval token. It is never implied by --json, --no-input, or a terminal being absent.
- High risk is a second gate: the candidate must also have --include-high-risk.
- Credential values are read only to check presence and to redact output. They never enter argv.
- The result report redacts any declared credential value that appears in stdout or stderr.
- The local backend writes .dsh/mcp.json and skills directly, with a backup and atomic replacement; the dsh-install backend delegates those writes to the plugin.

Threat model:

- A malicious catalog could propose an arbitrary command. The defense is review, schema validation, curated built-ins, and approval; there is no sandbox around the installed MCP itself.
- A malicious package could do anything its runtime allows. dsh-forage cannot sandbox an MCP server; users must treat candidate selection as a trust decision.
- A compromised shell wrapper could misinterpret arguments. The Windows path avoids string concatenation for normal argv, rejects cmd metacharacters, and offers .mjs/.exe as an alternative.
- Secret leakage through logs is mitigated by redaction, but third-party tools can still leak secrets they receive at runtime; dsh-forage cannot prevent that.

## Failure and exit codes

- 0: plan produced, or deployment completed without failures.
- 1: at least one deployment item failed.
- 2: usage, catalog, intent, approval, project-scope, or dsh-not-found error.

Failures are structured in --json mode:

    {
      "ok": false,
      "error": {
        "code": "PROJECT_SCOPE_WITHOUT_GIT",
        "message": "...",
        "fix": "运行 git init，或改用 --scope user。"
      }
    }

## Testing strategy

Unit tests cover parser rules, schema checks, ranking weights, default selection, picker input parsing, and command construction.

Integration tests spawn the built CLI and a fake dsh launcher. They verify:

- plan JSON shape and default cap;
- catalog JSON;
- deploy with one success, one failure, one builtin;
- failure isolation and exit code 1;
- project preflight without .git;
- unknown ID errors;
- full forge -> defaults -> deploy closed loop;
- Windows .cmd with a path containing spaces;
- secret redaction.

The fake launcher is intentionally argument-shaped like dsh, not a mock of dsh-install internals. The real integration boundary remains the CLI contract.

## Deferred

- Broader clean-machine acceptance. One Windows desktop run is recorded in docs/verification.md: dsh-install 0.1.1 + semantic-scholar + MCP health_check. That version needs an exact-version exemption on DSH 0.2.x, and the post-restart npx path is still unverified.
- Installed-state detection via dsh --profile install mcp list --format json / skills list.
- @khorsheed/dsh-capability-catalog integration. The real package exposes list_capabilities for the current instance, not a search over installable candidates. Use it for post-install verification, not as the candidate source.
- Embedding provider interface and cached vectors.
- Session-only scope. This needs either dsh-install support or a temporary registry with safe cleanup; v0.1 will not fake it.
- DSH Web GUI picker. Reuse the existing web infrastructure; do not stand up a second server.
- Candidate status / update checks and provenance signatures.