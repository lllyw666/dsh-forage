# @dsh-forage/forage-command

A read-only `/forage` slash command for the DSH Web GUI and interactive CLI.
It is a separate plugin from `@dsh-forage/mcp-registry` so headless profiles
without a command service keep working.

## What it shows

    /forage <task>          plan capabilities, scores, risk, installed scope
    /forage status          installed MCPs and Skills
    /forage doctor          environment check summary
    /forage catalog [domain]
    /forage help

It never installs, removes, or updates anything. Those actions need the explicit
approval gate in the terminal `dsh-forage` command or an agent request; the
command result itself is not a model message.

## Configuration

The plugin needs the CLI entry file. Set one of:

    DSH_FORAGE_CLI=<repo>/dist/src/index.js

or edit the installed row config:

    cli: "<repo>/dist/src/index.js"
    timeoutMs: 20000

`node` defaults to `process.execPath` (the DSH Electron executable); the
plugin sets `ELECTRON_RUN_AS_NODE=1` so it can execute the JS entry. Point
`node` at a real node.exe if you prefer.

## Install

    dsh plugin --profile desktop add file:<repo>/command-plugin

or copy it into the profile's node_modules and add it to
`dsh.profile.bundles`, like the registry plugin. Restart DSH once; the
running plugin manager may hot-load it.

## Limits

- No interactive picker; it renders a command result. The Web GUI slash menu
  supplies the input field.
- No install/remove/update subcommands.
- It calls the CLI as a child process; the command is read-only but the CLI
  still reads the current DSH_HOME and workspace.
