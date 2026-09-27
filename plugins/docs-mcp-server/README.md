# docs-mcp-server

Connects Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) (Grounded Docs) so the whole team searches and maintains one documentation index, and adds the `docs-mcp` command for scripts and other skills.

## Install and configure

```bash
claude plugin install docs-mcp-server@blasterm2a
```

The plugin asks for the server's MCP endpoint (for example `https://docs.example.internal/mcp`); change it later in `/config`. Instead of a saved value you can set `DOCS_MCP_URL`; when both are set, the variable wins.

If you already configured the same server by hand (`claude mcp add …`), Claude Code ignores the plugin's copy as a duplicate: remove your manual entry (`claude mcp remove <name> -s user`) to switch to the plugin.

## Requirements

- A docs-mcp-server reachable from your machine (on its private network or VPN if it has one).
- Python 3.10+ for the `docs-mcp` command.
- For a server with a certificate from a private CA: `SSL_CERT_FILE` pointing to that CA bundle.

## What you get

- **MCP tools** `mcp__plugin_docs-mcp-server_docs-mcp-server__*`: `search_docs`, `list_libraries`, `find_version`, `scrape_docs`, `refresh_version`, `remove_docs`, `fetch_url`, `list_jobs`, `get_job_info`, `cancel_job`.
- **Skill** `docs-mcp-server:shared-docs`: search first, conventions for a shared index, and how the server fetches content.
- **Command** `docs-mcp` (on the `PATH` of Claude's shell while the plugin is enabled):

```bash
docs-mcp libraries
docs-mcp search react "useEffect cleanup" --version 19.x
docs-mcp scrape web-react https://react.dev/reference --version 19.0.0 --max-pages 300 --wait
docs-mcp wait <job-id> --timeout 600
docs-mcp remove web-react --version 18.3.1 --yes
docs-mcp --help
```

The endpoint is the first non-empty value of `--url`, `DOCS_MCP_URL` and `CLAUDE_PLUGIN_OPTION_URL`. Exit codes: 0 success, 1 server error or failed job, 2 usage error or no URL, 3 connection/TLS/protocol error, 4 timed out waiting.

## Things to know about the server

- It fetches every URL itself: `file://` means the server's disk, and private documents need a URL it can reach, served with their exact `Content-Type`.
- A scrape replaces the whole library version; separate scrapes into the same version overwrite each other.

## Development

`task test` runs ruff and the unit tests (no server needed). Design: `docs/superpowers/specs/2026-09-27-docs-mcp-server-plugin-design.md`.

## Credits

The skill is original text modelled on the `docs-search`, `docs-manage` and `fetch-url` skills of [arabold/docs-mcp-server](https://github.com/arabold/docs-mcp-server) (MIT).
