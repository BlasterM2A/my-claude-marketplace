# superpowers-parallel

Runs an approved [Superpowers](https://github.com/obra/superpowers) implementation plan in parallel: tasks start as soon as their dependencies are merged, each in a persistent lane worktree under `.worktrees/`, and a single merge queue integrates them with full-suite tests. A planner agent resolves questions and gaps that agents raise, and an Opus reviewer checks the whole branch at the end.

## Requirements

- Superpowers ≥ 6.4.1. It is declared as a plugin dependency (`superpowers@claude-plugins-official`), so installing this plugin installs it too.
- git, jq, Node 24+, Workflows enabled in Claude Code

## Agents

The plugin bundles the subagents it dispatches: `sp-implementer-fast` (haiku/low), `sp-implementer` (sonnet/medium), `sp-reviewer` (sonnet/medium), `sp-final-reviewer` (opus/high) and `sp-planner` (opus/high). To tune one, define an agent with the same `name` in the project's `.claude/agents/` or in `~/.claude/agents/`: preflight detects it and the run uses yours instead of the bundled copy (`sp-planner` is always the bundled one).

## Usage

After writing and approving a plan with Superpowers, ask Claude to execute it with `superpowers-parallel:parallel-plan-execution`. You approve the task graph; everything else runs in the background (`/workflows` shows progress).

## Development

`task test` runs the bats and node suites. Design: `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md`.
