# Security policy

## Supported versions

Only the current v0.2 line is supported. This is an early-stage project; security fixes are applied to the latest release branch.

## Reporting

If the repository host supports private security advisories, use that. Otherwise contact the maintainers privately before opening a public issue. Do not include live credentials, tokens, or personal data in a report.

Please include:

- affected version;
- platform;
- the exact command or catalog entry;
- expected vs actual behavior;
- whether a secret, file, or approval boundary was crossed.

## Threat model

dsh-forage is an approval and routing layer, not a sandbox.

In scope:

- command injection or argument confusion in the dsh launcher;
- a catalog entry that can execute an unexpected command;
- a deployment that proceeds without explicit approval;
- a `/forage` command that mutates state or loses the terminal approval boundary;
- misleading GitHub discovery metadata, or an inferred `npx` install that runs the wrong package;
- a high-risk candidate installed without the second gate;
- credential values appearing in argv, logs, JSON, or error output;
- path / scope confusion that writes to an unexpected project;
- schema validation gaps that let malformed metadata through.

Out of scope:

- malicious behavior inside a third-party MCP server after it is installed;
- vulnerabilities in the packages themselves;
- the security of @dsh-tools/dsh-install's registry, hot mount, or audit implementation;
- OS-level sandbox escape by a process the user approved;
- supply-chain compromise of npm itself.

## Security properties

- Deployment requires yes=true, except for dry runs.
- --yes is never implied by non-interactive mode, --json, or --no-input.
- High risk requires --include-high-risk in addition to --yes.
- Default selections exclude writes, sensitive permissions, high risk, missing credentials, and manual-setup prerequisites.
- MCP credentials are stored as `$` + `{NAME}` references in the local mcp.json, or passed to dsh-install as -e NAME references; values never enter argv or the registry.
- The local backend backs up mcp.json before writing and replaces it through a temp file; duplicate names are refused.
- Declared credential values are redacted from captured stdout/stderr.
- Commands are built as argv. POSIX uses spawn without a shell.
- On Windows, a .cmd shim is launched through cmd /d /s /v:off /c with conservative quoting and a metacharacter rejection list. A .mjs or .exe launcher avoids the wrapper.
- Project scope is rejected before execution when no .git directory is found.
- `/forage` is read-only: it accepts plan/status/doctor/catalog/help (and `github` for discovery) and rejects deploy/install/remove/update; the child CLI is spawned as argv, never through a shell.
- GitHub discovery candidates are unverified external metadata. They are forced to high risk, never default-selected, and clearly labeled; the inferred `npx -y <package>` command and Git Skill source must be reviewed before installation.
- GitHub Skill archives are extracted with path traversal checks, symlink/hardlink skipping, a 5000-file limit, a compressed archive size limit, and a cache under `~/.dsh/forage/github-src`; only the requested `#subdir` is copied into the skill root.
- Software prerequisite lookup only returns official/open-source URLs and a search entry; it never returns cracked builds, activation bypasses, netdisk links, or direct binaries, and never installs software.
- Batch deployment health-checks MCPs before any write and restores `mcp.json`, `skills-manifest.json`, and the skills root on failure. Discovered candidates are written disabled by default; `enable` is an explicit second step.
- Health-check/`--no-health-check` is a preflight, not a sandbox or a security audit; a server that passes initialize can still be malicious.
- Discovery-first candidates from the MCP Registry or GitHub are unverified and always high risk; they are never default-selected and require explicit approval. The snapshot at `~/.dsh/forage/discovered.json` is local state, not a trust endorsement.
- Registry npm candidates use the registry-provided package version; remote candidates use the registry URL. Review the repository, license, and requested environment variables before installation.
- Local-first matching is read-only: it lists already-installed Skills/MCPs, never installs, and the interactive forge path asks the user before any search/install. It is not a capability or security verification.
- Session scope is a local, ephemeral MCP overlay: `~/.dsh/forage/session-mcp.json` is reset on plugin load and deleted on unload; it is not a strong multi-session isolation boundary.
- The HTTP embedding provider only reads an explicitly configured `DSH_FORAGE_EMBEDDING_URL`; the API key is sent in the Authorization header and is not written to the registry or logs. Plan/query/candidate text is sent to that endpoint by design.
- One failed item does not block the others; there is no automatic rollback.

## Residual risks

- A catalog entry is executable input. Review is the main control.
- A third-party package can do anything its runtime permits, including reading files and making network calls. Risk metadata is descriptive, not a sandbox.
- A malicious package could print a secret it receives at runtime. Redaction only covers declared credential values in captured output; a transformed secret may still leak.
- The Windows cmd wrapper is deliberately conservative and rejects some characters. Complex argv should use a .mjs/.exe launcher.
- The user can always approve a bad installation. dsh-forage tries to make the decision informed, not to override the user.
- Promotion to user scope broadens both permissions and tool-schema exposure. It requires a separate explicit approval and never happens automatically from usage.
- Session MCP tools are host-global while mounted; concurrent sessions are not hard-isolated. Use user/project scope when isolation matters.
- An external embedding endpoint sees the task and candidate text. Treat it as a data processor and do not point it at an untrusted service.
- The npm package and its Cordis sub-bundles are only as trustworthy as the registry account/token and CI provenance. Verify the published version and provenance before installing.

## Hardening checklist for users

- Run plan before deploy; read writes/credentials/requires.
- Prefer built-in capabilities for Office work when they cover the task.
- Use project scope for project-specific servers; user scope for shared tools.
- Keep the catalog and the packages updated.
- Rotate any credential that appears in a log or chat.
- Review third-party licenses, especially FSL/SSPL/source-available packages.
