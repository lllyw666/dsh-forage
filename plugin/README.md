# @dsh-forage/mcp-registry

A minimal, hot-mounting MCP registry for DSH 0.2.x.

## Why this exists

DSH's base profile does not ship an MCP registry or an MCP client mount. The
community `@dsh-tools/dsh-install@0.1.1` bundle is the usual consumer of
`~/.dsh/mcp.json`, but its peer range targets DSH 0.1.x and DSH 0.2.x skips
it (or crashes when it is force-loaded with an exact-version exemption).

`dsh-forage --backend local` writes `mcp.json` correctly, but a file writer
alone does not mount tools. This package provides the missing read/mount half.

## What it does

- On activation, reads `$DSH_HOME/mcp.json` and the project
  `<cwd>/.dsh/mcp.json` (project entries shadow user entries by name).
- Mounts every enabled server through `@deepseek-ai/dsh-mcp-client`.
- Expands `${VAR}` references in `env` and HTTP `headers` from `process.env`;
  keys with missing variables are omitted and logged.
- Accepts `stdio` and `streamable-http` (also tolerates an older `http`
  transport value and maps it to `streamable-http`).
- Watches `mcp.json` / the project registry (default 500 ms polling), mounts new
  servers, unmounts removed ones, and re-mounts changed entries. Set
  `watch: false` in the row config to disable this.
- Disposes its child fibers when the host unloads the plugin.

## What it deliberately does not do

- No install/remove/audit CLI. The dsh-forage CLI owns the write side.
- No third-party package download. The server command comes from `mcp.json`.
- No compatibility exemption or version forcing.
- Do not enable this plugin and dsh-install's mcp-registry at the same time; both read the same mcp.json and would mount duplicate servers.

## Install

For a desktop profile:

    dsh plugin --profile desktop add file:<repo>/plugin

Then restart DSH once so the plugin itself is loaded (or let the running plugin
manager hot-load it). After that, registry changes are picked up by the watcher
without another restart. For a web/headless profile, use the same command with
`--profile web` or the profile you actually boot.

If `dsh plugin add` hits a pnpm store mismatch, install manually:

1. Copy this directory to
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@dsh-forage\mcp-registry`.
2. In the profile's `package.json`, add
   `"@dsh-forage/mcp-registry": "file:<repo>/plugin"` to `dependencies` and
   `"@dsh-forage/mcp-registry"` to `dsh.profile.bundles`.
3. Restart DSH.

`dsh-forage doctor` reports `mcp:mount` as ok once the package is listed in a
profile's dependencies; if the tools still do not appear, restart DSH.

## Scope note

The desktop host's working directory is the application directory, not the
current project, so project-scope MCP entries are normally used by a
web/headless profile whose `cwd` is the project. User-scope entries work in
both.
