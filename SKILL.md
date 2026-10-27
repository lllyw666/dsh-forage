---
name: dsh-forage
description: Task-intent capability router for DeepSeek Harness. Use when the user wants to discover, install, and manage Skills or MCP servers for a concrete task; plans candidates, asks for explicit selection, writes the DSH registry locally with backups or delegates to dsh-install, and manages project/user scope promotion.
---

# dsh-forage

Route a concrete task to a small, reviewed set of DSH capabilities, then let the user pick before anything is installed.

Use this skill when the user asks for capabilities rather than for a specific known package, for example:

- "帮我找几个能检索论文、整理引用的 MCP"
- "处理 Excel 和 PPT，有什么现成能力？"
- "I need a local PDF reader for this workspace."

Do not use it for general npm package management, for installing a package the user already named, or for browsing unrelated marketplaces.

## Required behaviour

1. **Plan first, never install from the plan.**
2. **Show the candidate metadata** the user needs to decide: id, name, risk, writes, external requests, credentials, prerequisites, and whether it is a built-in.
3. **Ask the user to choose.** Do not treat your own recommendation as approval.
4. **Dry-run the selected IDs**, show the exact commands, then ask for explicit approval.
5. **Only then deploy with --yes.** Never add --yes silently.

## CLI resolution

Try these in order and use the first that works:

    dsh-forage --version
    node <path-to-dsh-forage>/dist/src/index.js --version

`dsh-forage` is not published to npm yet. Do not use `npx -y dsh-forage`: it would fetch nothing or an unrelated package. If neither command works, stop and tell the user how to install or link the CLI. Do not install the CLI globally on your own.

## Workflow

### 0. Check the environment

    dsh-forage doctor --json

If any check has level "error", stop and report its `fix` field. Do not plan or deploy from a broken environment. Common errors: a launcher points at a deleted DSH install, an MCP command no longer exists, or the workspace is the DSH installation directory.

### 1. Plan

    dsh-forage plan "<user task>" --json --scope project --top 5

By default this performs online discovery (MCP Registry + GitHub) and returns dynamic candidates; the static catalog is only a fallback. Use `--offline` only when the user wants the curated/offline set or the network is unavailable. Set `DSH_FORAGE_DISCOVERY=off` for deterministic tests.

Use project scope by default. Use --scope user only when the workspace is not a git repository and the user explicitly agrees to a global install, or when the user asks for user scope. project requires a .git directory. `--scope session` is a temporary MCP-only overlay: it is cleaned on plugin load/unload, does not support Skills, and the MCP tools are host-global while active, so do not present it as strong multi-session isolation. On the desktop host the cwd is the application directory, so project-scope MCPs are normally used in a web/headless profile whose cwd is the project; prefer user scope for desktop. A user-scope MCP appears in every project and can add significant tool-schema context.

The JSON includes:

- intent: extracted tasks, domains, signals, constraints
- candidates[]: rank, id, name, risk, credentials, missingCredentials, requires, builtin, command, defaultSelected, defaultBlockedBy
- defaultSelection[]: IDs that are safe by default
- localMatches[]: already-installed Skills/MCPs that look relevant (`kind`, `name`, `scope`, `description`, `score`, `reasons`)
- discovery: online discovery queries, candidate count, snapshot path, warnings; null when `--offline`
- selection: native multi-select payload (`type`, `question`, `options`, `allowOther`) for `ask_user_question`
- warnings[]: environment or scope issues

If the user already supplied a structured intent, use --intent or --intent-file instead of re-parsing prose.

### Local-first rule

If `localMatches` is non-empty, **stop before presenting new candidates and ask the user explicitly**:

> 本地已有 <names>，它们看起来能覆盖这个任务。
> A. 直接用本地  B. 搜索新的  C. 其他（请输入你的想法，例如“本地 nature-figure + 再找一个绘图 MCP”）

- A: use the local Skill (call the `skill` tool with its name) or local MCP tools; do **not** deploy or search GitHub, and do not install a duplicate.
- B: rerun with `--no-local` (online discovery is already the default), then present the new candidates and continue the normal approval flow.
- C: take the free-text answer, keep any local matches that still apply, and discovery-search for the rest. Do not discard one side just because the other exists. If the custom text is a new task, re-run plan with it.
- Never silently ignore a local match and never auto-install a replacement.

The interactive `forge` command asks the same question in a TTY; non-interactive JSON callers must read `localMatches` and ask in their own UI before deploying. In this GUI, prefer `ask_user_question` with an explicit **Other** option and allow custom text; never reduce the choice to a binary yes/no.

Discovery is on by default for `plan`/`forge`: it queries the MCP Registry and GitHub using translated task/signal keywords, normalizes/deduplicates the results, and ranks by task relevance, source quality, and risk. Registry and GitHub candidates are unverified and always high risk; they receive source-trust weights (Registry priority/quality, or GitHub source priority × normalized stars; low-star repos are penalized) and are never default-selected. Never install without reading the repository/SKILL.md/license/scripts, and expect rate limits without GITHUB_TOKEN. A discovered Skill's GitHub subdirectory is downloaded by the local backend into `~/.dsh/forage/github-src`; a discovered MCP uses its registry npm package pin or remote HTTP URL. Both remain unverified high-risk choices. If discovery returns nothing or fails, the plan falls back to the catalog with a warning.

### 2. Present a compact decision table

Show one row per candidate, for example:

| ID | Capability | Risk | Writes | Credentials | Default |
|---|---|---|---|---|---|
| semantic-scholar | Semantic Scholar | low | no | none | yes |
| zotero | Zotero Local | low | no | none | no (needs desktop Zotero) |
| pdf-reader | PDF Reader | medium | yes | none | no |

Add a short note for each candidate that has prerequisites or missing credentials. Do not dump the full JSON unless the user asks for it.

### Software prerequisites

When a candidate needs a desktop application (for example `zotero`, or a `desktop-app` requirement named SnapGene), run:

    dsh-forage software <name> --json

Present only the official link, free/open-source alternatives, and the browser search entry. Never provide cracked builds, activation bypasses, or netdisk links. Tell the user to verify the vendor domain, license, signature, and checksum before installing. Software installation is manual; dsh-forage does not download or execute it.

### 3. Ask for selection

Use `plan.selection` as the source for a native GUI multi-select: call `ask_user_question` with `multi_select: true`, map `selection.options` to question options, and always provide an **Other** free-text path. In a terminal, the CLI picker (`o` for Other) is equivalent. If the user says "you choose", pick only from defaultSelection and say why; do not add write or high-risk candidates. If they pick a high-risk candidate, repeat the specific risk and ask for a second confirmation before using --include-high-risk. If they choose Other, incorporate the text into the plan (re-run discovery/`--no-local` as needed) instead of forcing one of the preset answers.

### 4. Dry-run and approve

    dsh-forage deploy --id <id1>,<id2> --scope <scope> --backend local --dry-run --json

Show the planned commands and any warnings. If a candidate is already installed, report it as skipped and offer `update`/`remove` instead of forcing a duplicate. Ask: "执行这些安装吗？" with **yes / no / Other (free text)**; an Other answer means stop, incorporate it, and re-plan. Only after an explicit yes:

    dsh-forage deploy --id <id1>,<id2> --scope <scope> --backend local --yes --json

Before any write, MCP candidates get an initialize + tools/list health check. If any candidate fails, the whole batch stops before writing (staging). Do not use `--no-health-check` unless the user explicitly accepts the risk. Discovery candidates are written `enabled:false`; after review, run `dsh-forage enable --id <server> --scope <scope>` to activate. `--staged` forces disabled, `--activate` forces enabled. On a write failure, the local backend restores `mcp.json`, `skills-manifest.json`, and the skills root; report the `rollback` field. Optional: add `--embedding hashed` for a deterministic offline vector boost, or `--embedding http` when `DSH_FORAGE_EMBEDDING_URL` is configured; `auto` uses HTTP if configured, otherwise hashed. These are not guaranteed model embeddings; failure/timeout falls back to lexical ranking.

The default `--backend local` writes mcp.json / skills atomically with a backup. Mounting uses the bundled `@dsh-forage/mcp-registry` plugin, which watches mcp.json and mounts/unmounts changes (default polling ~500 ms). Do not claim the tools are usable until they appear or `doctor` shows `mcp:mount` ok; if the plugin is absent or `watch: false`, a restart is required. If `doctor` warns `mcp:mount`, install `<repo>/plugin` into the profile once and restart. Skills are scanned natively, so a refresh/restart is usually enough. Use `--backend dsh-install` only when the user explicitly wants dsh-install install/remove audit or a Git/npm skill source; first confirm the installer is actually loaded.

For a high-risk selection, add --include-high-risk only after the second confirmation.

### 5. Report results

Summarize per-item status: installed, failed, skipped, available, planned. For failed or skipped items, quote the fix field and the relevant environment variable names, never values.

Built-in candidates return available and need no command. For example, office-builtin means the DSH Office Skills are already part of the host; do not invent an install command for it.

## Maintenance

Only on an explicit user request; these modify or delete installed entries:

    dsh-forage remove --id <id> --scope user|project|session --yes --json
    dsh-forage update --id <id> --scope user|project|session --yes --json

Every remove/update/promote prompt must include **Other** with a free-text field; an Other answer stops the mutation and asks for a new plan. Both require an explicit `--scope` and refuse ambiguous same-name MCP/Skill entries without `--kind`. With the local backend they back up the old entry; with `--backend dsh-install` they build and run dsh's own remove/update command. `update` replaces the installed entry with the current catalog candidate. If dsh-install is skipped on this DSH version, use the local backend. Session scope is MCP-only and local-only.

The optional `command-plugin/` exposes a read-only `/forage` command in the Web GUI and interactive CLI; the base command plans with discovery/status/doctor/catalog and never installs. `/forage github <task>` remains an explicit GitHub-focused alias. Use it when the user wants a GUI-facing entry point, and still perform install/remove/update through the CLI approval flow.

## Project-first lifecycle

New capabilities should start at project scope. After the user has tried them, they may decide to promote one:

    dsh-forage status --json
    dsh-forage promote --id <id> --dry-run --json
    dsh-forage promote --id <id> --yes

Promotion moves the item from project to user scope and removes the project copy by default. It broadens both permissions and context exposure, so treat it as a separate explicit approval: never promote just because the user says the project install worked. If the target already has the same name, use --replace only after showing the conflict; otherwise stop. Use --keep-source only when the user explicitly wants both copies, and explain that the project copy will continue to shadow the user copy.

Demotion is the reverse:

    dsh-forage demote --id <id> --dry-run --json
    dsh-forage demote --id <id> --yes

Use --kind mcp or --kind skill when the same id exists as both. Skill transfers update skills-manifest.json; MCP transfers default to rewriting both local registries, while `--backend dsh-install` uses add/remove. If the source is removed and the target install fails, the source is kept; report the exact failure and do not retry blindly.

## Safety rules

- Never deploy without an explicit user approval. "Plan it" is not approval.
- Never use --yes as a convenience in an exploratory turn.
- Never automatically add --include-high-risk.
- Never install write-capable candidates just because they are top-ranked; the default selection excludes them on purpose.
- Never print, echo, or ask for secret values. Only mention credential names such as ZOTERO_API_KEY or TEST_SECRET.
- Never modify the catalog or a package to bypass a validation failure.
- Never install a package the user has not seen in the candidate table.
- If project scope fails because of a missing .git directory, explain the constraint and ask whether to use --scope user instead of silently switching.
- `--backend local` does not need dsh. If `--backend dsh-install` is selected and dsh or dsh-install is missing/skipped, stop and report the exact fix; do not attempt a custom installer.

## Failure handling

- missing credentials: ask the user to set the named environment variable in their shell, then rerun. Do not handle the value.
- project scope without .git: use --scope user only with the user's agreement.
- dsh not found with `--backend dsh-install`: install @dsh-tools/dsh-install and ensure dsh is on PATH, or pass --dsh-bin. For a plain deploy, prefer the default `--backend local`.
- duplicate server/skill: show the existing name and suggest removing it explicitly, not overwriting.
- one item fails: continue reporting the other items; do not retry blindly.

## Output style

Be concise. Use the user's language. Keep the candidate table scannable, put warnings before the approval question, and never bury the fact that something will write files or require a credential.
