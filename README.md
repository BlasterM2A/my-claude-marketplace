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
| [superpowers-plus](plugins/superpowers-plus) | 0.3.1 | Execute approved [Superpowers](https://github.com/obra/superpowers) plans in parallel lane worktrees with a serialized merge queue. |
| [docs-mcp-server](plugins/docs-mcp-server) | 0.1.0 | Connect Claude Code to a shared [docs-mcp-server](https://github.com/arabold/docs-mcp-server) and drive it from the shell. |

### superpowers-plus

Installing it also installs its dependency, [Superpowers](https://github.com/obra/superpowers) (`superpowers@claude-plugins-official`); this marketplace allows that cross-marketplace dependency. It bundles the `sp-*` subagents it uses; an agent with the same name in your `~/.claude/agents/` or project `.claude/agents/` replaces the bundled copy. It also needs git, jq, Node 24+, and Workflows enabled in Claude Code. See the [plugin README](plugins/superpowers-plus/README.md).

## Development

Tools are pinned with [mise](https://mise.jdx.dev) and tasks run with [Task](https://taskfile.dev):

```bash
task validate   # validate the marketplace and every plugin manifest
task test       # run each plugin's test suite with its own mise tools
task            # both
```
