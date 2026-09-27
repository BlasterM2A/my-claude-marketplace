# docs-mcp-server plugin — design

Date: 2026-09-27. Status: draft for review.

## Goal

One install gives Claude Code a working connection to a **shared, remote
[docs-mcp-server](https://github.com/arabold/docs-mcp-server)** (the "Grounded
Docs" MCP server) plus a small generic client for scripted work against it. The
plugin is published in a public marketplace, so it must contain **nothing
specific to any organisation**: no hostnames, account ids, library names or
document conventions. Organisation- or project-specific workflows (for example
indexing a team's private documents) live in local skills that build on this
plugin.

Success criteria:

- `claude plugin install docs-mcp-server@blasterm2a` asks for the server URL once
  (or reads it from `DOCS_MCP_URL`) and the server's tools appear in new sessions.
- Claude can index, search and maintain the shared index through the MCP tools,
  following conventions that keep a team-shared index tidy.
- Scripts and local skills can drive the same server from the shell with
  `docs-mcp <command>`, without reimplementing the MCP protocol.
- `git grep` over the plugin finds no organisation-specific identifier.

## Non-goals

- Running or managing a local docs-mcp-server (process, store, embeddings).
- Getting private files to the server (uploading, presigning, S3). That belongs
  to the local skills that need it.
- Authentication. The target servers are reachable only over a private network
  and run without auth. If that changes, a `sensitive` token option and an
  `Authorization` header are added in a later version.

## Facts this design relies on (verified 2026-09-27, upstream v3.2.1)

- The server only ever **fetches** content from a URL it is given; no upload
  API exists (MCP tools, CLI, web UI and worker API all take a URL). `file://`
  URLs resolve on the **server's** filesystem.
- A binary document (e.g. `.docx`) is processed only when the HTTP response
  carries its exact `Content-Type`; `application/octet-stream` is rejected
  before the body is read, even when the URL ends in `.docx`.
- The MCP `scrape_docs` tool has **no `clean` option**: every scrape of a
  library + version first clears that version's pages. Appending several
  sources to one version is only possible through the upstream CLI
  (`--no-clean`) against the worker API, which a shared deployment may not
  expose.
- Remote `.zip` roots are documented upstream but indexed 0 documents on a real
  deployment; do not rely on them.
- Plugin facts (Claude Code docs): `userConfig` values substitute into MCP
  server config and skill content as `${user_config.KEY}`; files in a plugin's
  `bin/` are on the `PATH` of the Bash tool while the plugin is enabled; plugin
  MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`.
- Plugin facts (verified with `--debug-file` on Claude Code 2.1.283): a plugin
  MCP `url` expands environment variables, `${VAR:-default}` defaults and a
  nested `${DOCS_MCP_URL:-${user_config.url}}`; with neither set, Claude Code
  reports "URL is unset or invalid" and points to the plugin's options. A plugin
  MCP server whose resolved URL equals a manually configured server is
  **suppressed** ("duplicates manually-configured …").

## Components

Plugin directory `plugins/docs-mcp-server/`, version `0.1.0`.

### 1. Manifest and MCP connection (`.claude-plugin/plugin.json`)

- `userConfig.url`: string, optional, no default, not sensitive. Title "Server
  URL"; description "MCP endpoint of a docs-mcp-server, e.g.
  https://docs.example.internal/mcp. Leave empty to use the DOCS_MCP_URL
  environment variable." Saved in the user's settings (`pluginConfigs`),
  editable from `/config`.
- `mcpServers.docs-mcp-server`:
  `{ "type": "http", "url": "${DOCS_MCP_URL:-${user_config.url}}" }`. The
  environment variable wins over the saved value (per-machine or per-shell
  override, e.g. set by mise for one workspace).
  Tools become `mcp__plugin_docs-mcp-server_docs-mcp-server__<tool>`
  (`search_docs`, `scrape_docs`, `list_libraries`, `find_version`,
  `refresh_version`, `remove_docs`, `fetch_url`, `list_jobs`, `get_job_info`,
  `cancel_job`).
- Marketplace entry in `.claude-plugin/marketplace.json` and a row in the root
  `README.md`, versions kept equal (`task validate` enforces it).

### 2. CLI `bin/docs-mcp`

A single Python 3 file, standard library only, executable, `#!/usr/bin/env python3`.

**Endpoint resolution**, first non-empty value wins, in the same order as the
MCP connection: `--url`, `DOCS_MCP_URL`, `CLAUDE_PLUGIN_OPTION_URL`. None set:
exit 2 with a message naming all three. Whether Claude Code exports
`CLAUDE_PLUGIN_OPTION_URL` to `bin/` executables is undocumented, so the skill
does not rely on it (see the skill section).

**Transport**: MCP Streamable HTTP. `initialize` (protocol version
`2025-06-18`, falling back to what the server returns), `notifications/initialized`,
then the requests; keeps `Mcp-Session-Id` and sends `MCP-Protocol-Version` after
initialisation; accepts both `application/json` and `text/event-stream`
responses. TLS verification stays on; a private CA is trusted through the
standard `SSL_CERT_FILE`. `--insecure` disables verification and prints a
warning to stderr.

**Commands** (text output is the tool's own text content; `--json` prints the
raw JSON-RPC result):

| Command | Maps to |
|---|---|
| `tools` | `tools/list` (names and one-line descriptions) |
| `call <tool> [JSON]` | any tool, arguments as a JSON object |
| `libraries` | `list_libraries` |
| `versions <library> [--target V]` | `find_version` |
| `search <library> <query> [--version V] [--limit N]` | `search_docs` |
| `scrape <library> <url> [--version V] [--max-pages N] [--max-depth N] [--scope subpages\|hostname\|domain] [--include P]... [--exclude P]... [--wait]` | `scrape_docs`; with `--wait`, then `wait` on the returned job id |
| `refresh <library> [--version V] [--wait]` | `refresh_version` |
| `remove <library> [--version V] --yes` | `remove_docs`; refuses without `--yes` |
| `jobs [--status S]` | `list_jobs` |
| `job <id>` | `get_job_info` |
| `wait <id> [--timeout SECONDS] [--interval SECONDS]` | polls `get_job_info` until completed, failed or cancelled |
| `cancel <id>` | `cancel_job` |
| `fetch <url>` | `fetch_url` |

**Exit codes**: 0 success; 1 the tool reported an error (`isError`) or a
waited job failed/was cancelled; 2 usage error or missing endpoint; 3
connection, TLS or protocol error; 4 `wait` timed out. Errors go to stderr.

The job id is parsed from the `scrape_docs`/`refresh_version` text
(`... job started with ID: <uuid>`); if the format changes, `--wait` fails with
exit 3 and prints the raw text.

### 3. Skill `skills/shared-docs/SKILL.md`

Model-invocable (description triggers on looking up library documentation,
indexing or refreshing docs, or managing the shared docs index). Original text,
modelled on the upstream `docs-search`, `docs-manage` and `fetch-url` skills
(MIT, credited in the README), adapted to a remote shared server:

- **Search first**: `list_libraries` / `find_version` before indexing; always
  pass `library` to `search_docs`; one query per library.
- **Indexing etiquette for a shared index**: lower-case kebab library names
  with a team or area prefix; version labels when the source is versioned;
  bound every scrape (`scope`, `includePatterns`/`excludePatterns`,
  `maxPages`, `maxDepth`); watch the job (`list_jobs`/`get_job_info`) before
  searching; prefer `refresh_version` over a new scrape; never `remove_docs`
  unless the user asked for that exact library/version.
- **Server semantics to respect**: a scrape replaces the whole library
  version; the server fetches URLs itself, so private files need a URL the
  server can reach, served with the exact `Content-Type`; `file://` means the
  server's disk.
- **When to use `docs-mcp` instead of the MCP tools**: loops over many
  libraries or URLs, waiting for jobs, and scripts or other skills. Commands
  are written as `DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp …`,
  so the shell applies the same precedence as the MCP connection (the saved
  value is substituted into the skill text; the variable is resolved at run
  time).

### 4. Documentation and tooling

- `README.md`: purpose, install and configure, requirements (a reachable
  server, Python 3 for the CLI), MCP tool names, CLI reference, credits.
- `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`): development rules for the plugin.
- `mise.toml`: `python` and `ruff` pinned with `mise use` (latest at
  implementation: python 3.14.7, ruff 0.16.9), plus `task`.
- `Taskfile.yml`: `lint` (`ruff check` + `ruff format --check`), `test`
  (lint, then `python -m unittest`). The root `task test` picks it up.

## Error handling

- Missing or malformed endpoint, bad JSON arguments: exit 2 before any
  network call.
- Unreachable server, TLS failure, non-2xx HTTP, malformed JSON-RPC: exit 3
  with the URL and the underlying reason.
- JSON-RPC `error` objects and tool results with `isError`: exit 1 with the
  server's message.
- `remove` without `--yes`: exit 2, nothing sent.

## Testing

- **Unit tests** (`test/`, `unittest`): a fake MCP server built on
  `http.server` in a background thread that checks the handshake, requires the
  session id on later requests, and can answer in JSON or SSE. Cases: endpoint
  resolution order, including empty values being skipped; handshake and session header; JSON and SSE parsing; tool
  error, JSON-RPC error and HTTP error to exit codes; `--insecure` warning;
  `remove` refusal; `wait` success, failure and timeout; job id parsing for
  `scrape --wait`.
- **Manifest**: `task validate` (catalog, manifest, version agreement).
- **End to end, manual, on a machine with access to a real server**: install
  from the local marketplace clone into an isolated `CLAUDE_CONFIG_DIR`, set the
  URL, confirm `claude mcp list` shows the server connected; repeat once with
  the saved value empty and `DOCS_MCP_URL` set, and once with both set to
  different URLs (the variable must win). Then with the CLI:
  `libraries`, `scrape` a small public page into a throw-away `zz-` library
  with `--wait`, `search` it, `remove --yes` it.
- **Public-safety check** before publishing: `git grep` the plugin for
  organisation-specific identifiers (hostnames, account ids, internal library
  names); the list of patterns is kept out of the repository.

## Rollout

1. Implement on `feature/docs-mcp-server-plugin`, `task` green.
2. Release with `/release-plugin docs-mcp-server 0.1.0` (first tag
   `docs-mcp-server--v0.1.0`).
3. Install locally and enter the server URL (or set `DOCS_MCP_URL`). While a
   manually configured MCP entry with the same URL exists, Claude Code
   suppresses the plugin's server, so remove the manual entry
   (`claude mcp remove <name> -s user`), then verify the plugin's tools appear
   in a new session.
