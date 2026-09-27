---
name: shared-docs
description: Search, index and maintain library documentation on the team's shared docs-mcp-server. Use when looking up a library's API or documentation, when documentation should be indexed or refreshed, or when managing the shared index (libraries, versions, indexing jobs).
---

# Shared docs

The `docs-mcp-server` tools (`mcp__plugin_docs-mcp-server_docs-mcp-server__*`) work on one documentation index shared by the whole team. What you index, refresh or remove changes it for everyone.

## Search

1. If you are not sure a library is indexed, call `list_libraries` (or `find_version` for a version range) first.
2. Call `search_docs` with an explicit `library`, and with `version` when the project pins one. Ask one question per call; for several libraries, make one call per library.
3. If the library is not indexed, say so and offer to index it (below) instead of answering from memory.

## Index and refresh

- **Names**: lower-case kebab-case, prefixed with the team or area that owns the docs (`<area>-<name>`). Reuse an existing library name exactly (check `list_libraries`). Set a version label when the source is versioned.
- **Bound every scrape**: point at the documentation subtree (e.g. `/docs/`, `/reference/`) rather than a whole site, keep `scope` at `subpages` unless the docs span the host, and set `maxPages`, `maxDepth`, `includePatterns` or `excludePatterns` to skip changelogs, blogs and other languages.
- **A scrape replaces the whole library version.** Separate scrapes into the same library and version overwrite each other; to index several documents in one library, they must all be reachable from one root URL (for example an index page that links them).
- **Scrapes run as jobs.** `scrape_docs` returns a job id; check `get_job_info` (or `list_jobs`) until the job is `completed` before searching, and report the error of a `failed` job.
- Prefer `refresh_version` over a new scrape to pick up changes: it skips unchanged pages.
- **The server fetches every URL itself.** `file://` paths refer to the server's own disk, not yours. Private documents need a URL the server can reach, served with their exact `Content-Type` (a `.docx` needs `application/vnd.openxmlformats-officedocument.wordprocessingml.document`); `application/octet-stream` is rejected even when the URL ends in `.docx`, and remote `.zip` archives are not indexed.
- Never call `remove_docs` (or `docs-mcp remove`) unless the user asked to delete that exact library or version; confirm the name and version with them first.

## The `docs-mcp` command

For a single lookup use the MCP tools. Use the `docs-mcp` command (on the `PATH` while this plugin is enabled) for loops over many libraries or URLs, for waiting on jobs, and from scripts or other skills. Always run it in this form, so a `DOCS_MCP_URL` set in the environment wins over the URL saved in the plugin's settings, exactly as for the MCP connection:

```bash
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp libraries
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp search web-react "useEffect cleanup" --version 19.x
DOCS_MCP_URL="${DOCS_MCP_URL:-${user_config.url}}" docs-mcp scrape web-react https://react.dev/reference --version 19.0.0 --max-pages 300 --wait
```

| Command | Does |
|---|---|
| `libraries` | list indexed libraries |
| `versions <library> [--target V]` | best matching version |
| `search <library> <query> [--version V] [--limit N]` | search one library |
| `scrape <library> <url> [--version V] [--max-pages N] [--max-depth N] [--scope S] [--include P]… [--exclude P]… [--wait]` | index a URL (replaces the version) |
| `refresh <library> [--version V] [--wait]` | re-scrape changed pages |
| `jobs [--status S]`, `job <id>`, `wait <id> [--timeout S]`, `cancel <id>` | indexing jobs |
| `fetch <url>` | read one page as Markdown without indexing |
| `remove <library> [--version V] --yes` | delete (only when the user asked) |
| `tools`, `call <tool> [JSON]` | list or call any server tool |

Add `--json` for the raw result. Exit codes: 0 success, 1 server error or failed job, 2 usage error or no URL, 3 connection, TLS or protocol error, 4 timed out waiting. For a server with a private CA, set `SSL_CERT_FILE`; use `--insecure` only if the user agrees.
