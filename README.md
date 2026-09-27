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
| [superpowers-parallel](plugins/superpowers-parallel) | 0.2.0 | Execute approved [Superpowers](https://github.com/obra/superpowers) plans in parallel lane worktrees with a serialized merge queue. |

### superpowers-parallel

Installing it also installs its dependency, [Superpowers](https://github.com/obra/superpowers) (`superpowers@claude-plugins-official`); this marketplace allows that cross-marketplace dependency. It bundles the `sp-*` subagents it uses; an agent with the same name in your `~/.claude/agents/` or project `.claude/agents/` replaces the bundled copy. It also needs git, jq, Node 24+, and Workflows enabled in Claude Code. See the [plugin README](plugins/superpowers-parallel/README.md).
