# npm release

The package is published as `dsh-forage` (public). The version in
`package.json` is the source of truth.

## Preflight

    npm ci
    npm run typecheck
    npm test
    npm run test:plugin
    npm pack --dry-run

`npm pack --dry-run` must list `dist/src`, `catalog`, `plugin`,
`command-plugin`, `docs`, `SKILL.md`, and the root docs. It must not list
tests, `node_modules`, or the API-reference extraction used during development.

## Publish

Local, after `npm login` (2FA/OTP may be required):

    npm publish --access public

CI: push a tag such as `v0.2.0`; `.github/workflows/publish.yml` runs the
checks and then `npm publish --access public --provenance`. Configure the
`NPM_TOKEN` repository secret with an automation token. Provenance additionally
needs the workflow's `id-token: write` permission (already set).

## What is intentionally not in the tarball

- `tests/`, `dist/tests/`
- `plugin/test/`, `command-plugin/test/`
- `node_modules/`, `.test-tmp/`, `dsh-api-ref/`
- local desktop/profile backups

The `files` allowlist in `package.json` is authoritative; do not add a broad
`.npmignore` instead.

## Versioning

- patch: fix, docs, catalog metadata
- minor: new command, scope, provider, or installer behavior
- major: breaking CLI/JSON contract or scope semantics

`publishConfig.provenance` is enabled. A local publish without CI provenance
must pass `--no-provenance` if the registry rejects it; prefer the workflow.
