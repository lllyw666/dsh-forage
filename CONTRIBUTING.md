# Contributing

Thanks for helping improve dsh-forage. The project is small on purpose; the highest-value contributions are verified catalog entries, ranking improvements, and tests.

## Setup

    git clone <your-fork-url>
    cd dsh-forage
    npm install
    npm run build
    npm test
    npm run typecheck

Node.js 20+ is required. The runtime has no production dependencies; TypeScript and @types/node are dev dependencies.

## What to work on

- A real, installable MCP or Skill candidate with verified metadata.
- A parser case that the current rules miss, with a focused test.
- A ranking or safety-default bug, with a regression test.
- A clearer fix hint for a real dsh-install failure.
- Documentation that reduces a real support question.

For anything larger than a small PR, open an issue first. Discovery sources are allowed, but they must degrade gracefully, keep network failures as warnings, and never auto-install a discovered candidate.

## Catalog contributions

Read docs/catalog-guide.md. Every entry must be:

- a real package or a real built-in capability;
- installable with the declared command;
- honest about writes, external requests, sensitive permissions, credentials, and prerequisites;
- licensed accurately;
- verified on the date in verifiedAt;
- unique by id;
- accompanied by a manual verification note in the PR.

Do not add a candidate just because it appears in a list. Run it.

## Code guidelines

- TypeScript, strict mode, NodeNext ESM. Relative imports use .js.
- No production dependencies in the current MVP. Prefer the standard library.
- Keep command construction as argv. Never introduce a shell string path for normal execution.
- Any new install shape must be validated in schema.ts and covered by a command test.
- Any change to defaults must include a test for the read-only / write / high-risk case it affects.
- Keep JSON stdout clean. Warnings for humans go to stderr or the report.
- Error messages should include an actionable fix, not only what failed.
- User-facing text is Chinese in the CLI today; keep new messages consistent.

## Tests

    npm test

The runner builds first, then executes every dist/tests/*.test.js. Integration tests spawn the CLI and a fake dsh launcher. If you add a new catalog shape or launcher path, add an integration test.

For a quick manual check:

    node dist/src/index.js plan "帮我检索 RAG 论文" --json --scope user
    node dist/src/index.js deploy semantic-scholar --scope user --dry-run

## Secrets and privacy

Never commit secrets, tokens, cookies, private URLs, or personal paths from your machine. Catalog entries use environment-variable names only. If a test needs a credential, use an obviously fake value and assert that it is redacted, not printed.

## Commit and PR

- Keep commits focused.
- Describe the user-visible behavior, not only the files changed.
- Include the command output or a test name that proves the change.
- For a catalog entry, include the npm view output and the verification date.
- Do not bump the version unless asked.

## License

By contributing, you agree that your contribution is licensed under MIT. Third-party packages remain under their own licenses; adding metadata does not relicense them.
