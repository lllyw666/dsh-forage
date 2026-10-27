# Catalog contribution guide

The catalog is the offline fallback and verified seed for dsh-forage; live discovery is the default. A good contribution is small, verifiable, and honest about risk.

## Where catalogs live

- Built-in research: catalog/research.json
- Built-in office: catalog/office.json
- Project-local additions: pass --catalog ./.dsh/forage/catalog explicitly
- Ad-hoc: dsh-forage --catalog ./my-catalog.json ...

Project catalogs are not auto-loaded: a workspace-controlled catalog is executable input, so it requires an explicit --catalog path. Explicit paths are appended after the built-in catalog. IDs must be globally unique across all loaded files; duplicate IDs are a hard error.

## File shape

    {
      "schemaVersion": 1,
      "domain": "research",
      "title": "科研",
      "capabilities": [
        {
          "id": "example-mcp",
          "type": "mcp",
          "name": "Example MCP",
          "description": "One sentence that says what the user can do, not what the package is.",
          "domains": ["research"],
          "tasks": ["文献检索", "学术元数据"],
          "tools": ["search_papers", "get_paper"],
          "toolCount": 2,
          "risk": {
            "level": "low",
            "writes": false,
            "external_requests": true,
            "sensitive_permissions": false
          },
          "credentials": [],
          "requires": [
            {
              "kind": "runtime",
              "label": "Node.js 20+",
              "hint": "首次运行会下载依赖"
            }
          ],
          "install": {
            "method": "dsh-install",
            "kind": "mcp",
            "server": "example-mcp",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "example-mcp"],
            "timeoutMs": 120000
          },
          "group": "scholarly-search",
          "weight": 0.7,
          "homepage": "https://github.com/owner/example-mcp",
          "sourceRepo": "https://github.com/owner/example-mcp",
          "license": "MIT",
          "packageVersion": "1.2.3",
          "verifiedAt": "2026-10-26",
          "notes": ["Free, no API key; upstream rate limits apply."]
        }
      ]
    }

The candidate domains must include the file's domain. A candidate can belong to more than one domain, for example a PDF tool used in both research and office. Put the candidate in one file to keep IDs unique; the other domain still sees it through domains.

## Field rules

| Field | Required | Notes |
|---|---|---|
| id | yes | kebab-case, 2-64 chars, globally unique |
| type | yes | mcp / skill / builtin, must match install.kind |
| name | yes | Display name, max 100 chars |
| description | yes | User outcome, max 600 chars; avoid marketing claims |
| domains | yes | research / office / development / other |
| tasks | yes | Use the canonical task vocabulary where possible |
| tools | yes | Tool names shown to the user; may be empty for builtin |
| toolCount | no | Use when tools is a representative subset |
| risk | yes | All four fields required |
| credentials | yes | Env var names only; for MCP they must also be in install.env; skill/builtin candidates cannot declare credentials in v0.1 |
| requires | no | desktop-app / runtime / network / manual-setup |
| install | yes | See below |
| group | no | Alternatives that should not all be defaulted together |
| weight | no | 0..1 editorial preference, not a popularity claim |
| homepage/sourceRepo | no | http(s) URLs |
| license | no | SPDX identifier when known |
| packageVersion | no | Version checked on the verification date |
| verifiedAt | no | YYYY-MM-DD |
| notes | no | Short caveats, max 500 chars each |

## Install shapes

stdio MCP:

    "install": {
      "method": "dsh-install",
      "kind": "mcp",
      "server": "example-mcp",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "example-mcp"],
      "env": ["EXAMPLE_API_KEY"],
      "timeoutMs": 120000
    }

HTTP MCP:

    "install": {
      "method": "dsh-install",
      "kind": "mcp",
      "server": "example-http",
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": ["Authorization: Bearer placeholder"]
    }

Skill:

    "install": {
      "method": "dsh-install",
      "kind": "skill",
      "source": "github:owner/repo#skills/example",
      "name": "example"
    }

Built-in capability:

    "install": {
      "method": "builtin",
      "provides": ["office-docx", "office-xlsx"]
    }

For MCP credentials:

- credentials lists the names, never values.
- install.env must contain the same names.
- dsh-forage passes -e NAME, so dsh-install stores an environment-variable reference.
- A candidate with a missing variable is skipped at deploy time, not installed and left broken.

## Risk rubric

| Field | true when |
|---|---|
| writes | The tool can create, modify, delete, annotate, or save files, or mutate a remote system |
| external_requests | The server calls the network or a remote API |
| sensitive_permissions | The tool can read broad local data, execute commands, control a desktop app, or mutate a live document |

| level | Meaning |
|---|---|
| low | Read-only, no sensitive permissions, ordinary network calls are fine |
| medium | Writes files or has a meaningful local side effect |
| high | Writes live user data, requires desktop automation, broad permissions, or an experimental setup |

When unsure, choose the higher risk. A false "low" is worse than a false "medium".

## Verification checklist

Before opening a PR:

1. Confirm the package exists and check its metadata:

       npm view <package> version license repository.url bin

2. Start the server once from a clean shell and confirm it does not fail immediately:

       npx -y <package>

   For MCP, connect an inspector and check tools/list:

       npx @modelcontextprotocol/inspector npx -y <package>

3. Read the README and list every tool that can write, delete, execute, or read broad local data.
4. Identify credentials and prerequisites. If the server needs a desktop app or a one-time plugin install, add a requires entry.
5. Check the license. Do not add a package whose license you cannot represent accurately. FSL, SSPL, and source-available licenses must be labelled as such.
6. Add group when the candidate is an alternative to an existing one (for example, another scholarly search MCP).
7. Set weight conservatively. It is an editorial ordering hint, not a claim about quality or downloads.
8. Test the catalog:

       npm run build
       node dist/src/index.js catalog research --json
       node dist/src/index.js plan "文献检索" --json --scope user

9. Run the full suite:

       npm test

## Review checklist

- [ ] The package is real and the install command is tested.
- [ ] The description says what the user can do.
- [ ] Risk fields are not understated.
- [ ] Credentials are names only and match install.env.
- [ ] Prerequisites are explicit.
- [ ] License and version are accurate.
- [ ] verifiedAt is today's date.
- [ ] No duplicate ID.
- [ ] No secrets, tokens, or private URLs.
- [ ] At least one test or manual verification covers the new command shape.

## Security

A catalog entry is executable input: its command and args become a real process launch. Review every entry as code. Do not accept a PR that obfuscates a command, hides a write tool, or asks users to disable approval. Report suspicious entries privately; see SECURITY.md.

## Removing or deprecating

If a package is abandoned, compromised, or its license changes:

- remove it from the catalog, or
- keep the entry only with a clear deprecation note and a high risk level.

Removing a candidate does not uninstall it from users' machines; tell users to run dsh-install remove explicitly.
