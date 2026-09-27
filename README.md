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
| [superpowers-parallel](plugins/superpowers-parallel) | 0.1.1 | Execute approved [Superpowers](https://github.com/obra/superpowers) plans in parallel lane worktrees with a serialized merge queue. |

### superpowers-parallel requirements

The plugin dispatches the `sp-*` subagents, which are **not** bundled with it. Define them yourself in `~/.claude/agents/` before use:

- `sp-implementer-fast`, `sp-implementer`, `sp-reviewer`, `sp-final-reviewer`

It also needs Superpowers ≥ 6.4.1, git, jq, Node 24+, and Workflows enabled in Claude Code. See the [plugin README](plugins/superpowers-parallel/README.md).
