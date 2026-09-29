# my-claude-marketplace

BlasterM2A's personal [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces).

## Install

```bash
claude plugin marketplace add BlasterM2A/my-claude-marketplace
claude plugin install <plugin>@blasterm2a
```

## Plugins

| Plugin | Version | Description |
|:---|:---|:---|
| [superpowers](https://github.com/obra/superpowers) | 6.4.2 | [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT), pinned to an upstream release. |
| [superpowers-plus](plugins/superpowers-plus) | 0.4.2 | Execute approved [Superpowers](https://github.com/obra/superpowers) plans in parallel lane worktrees with a serialized merge queue. |
| [docs-mcp-server](plugins/docs-mcp-server) | 0.1.0 | Connect Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) and drive it from the shell. |

### superpowers

[obra/superpowers](https://github.com/obra/superpowers) (MIT, by Jesse Vincent), not copied here: the catalog entry points at the upstream repository, pinned to a release tag and its commit, so new upstream releases can be adopted before the official Anthropic marketplace picks them up. Skills keep the `superpowers:` prefix. It cannot be installed next to `superpowers@claude-plugins-official` (same plugin name): uninstall that one first.

### superpowers-plus

Installing it also installs its dependency, the `superpowers` plugin from this marketplace. It bundles the `sp-*` subagents it uses; an agent with the same name in your `~/.claude/agents/` or project `.claude/agents/` replaces the bundled copy. It also needs git, jq, Node 24+, and Workflows enabled in Claude Code. See the [plugin README](plugins/superpowers-plus/README.md).

### docs-mcp-server

Connects Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) over MCP and adds the `docs-mcp` command and the `shared-docs` skill. On install it asks for the server's MCP URL; leave it empty to use `DOCS_MCP_URL` instead (the variable wins when both are set). The `docs-mcp` command needs Python 3.10+. See the [plugin README](plugins/docs-mcp-server/README.md).

## Development

Tools are pinned with [mise](https://mise.jdx.dev) and tasks run with [Task](https://taskfile.dev):

```bash
task validate   # validate the marketplace and every plugin manifest
task test       # run each plugin's test suite with its own mise tools
task            # both
```
