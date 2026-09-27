# superpowers-plus

Claude Code plugin that runs approved Superpowers plans in parallel.

- Spec: `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md` (the dated spec and plan predate the rename and still say `superpowers-parallel`; leave them as history).
- Run tests with `task test`: `task lint` (shellcheck), bats for `scripts/lanes`, `scripts/merge-queue`, `scripts/preflight`, and `node:test` for everything else.
- `workflows/parallel-sdd.js` is a Claude Code Workflow script: plain JS, no imports, no filesystem, no `Date.now()`/`Math.random()`. Test it through `test/harness.mjs`.
- Shell scripts: `set -euo pipefail`, usage text in the header comment, exit 2 on bad usage, exit 3 on unsafe state.

## How a run fits together

1. **Skill** `skills/parallel-plan-execution/SKILL.md` drives the main session: `scripts/preflight` → branch + SDD workspace → read-only analyzer subagent (`analyzer-prompt.md`) writes `plan-graph.json` → `scripts/validate-graph.mjs` → user approves the graph → Workflow tool runs `workflows/parallel-sdd.js` with `args` → report.
2. **preflight** is the contract between the plugin and its environment. It prints `SP_SKILLS` (the active Superpowers install, from `installed_plugins.json`, else the newest cached version; `CLAUDE_CONFIG_DIR`, `SP_ROOT` and `AGENTS_DIR` override paths in tests), `TASKS`, and `AGENTS`: a role → agent-type map that picks the user's or project's own `sp-*` agent when one with that `name` exists, else the bundled `superpowers-plus:sp-*`.
3. **The workflow** reuses Superpowers instead of copying it: implementer/reviewer prompts point agents at `${spSkills}/subagent-driven-development/*` (prompts, `review-package`, `task-brief`) and `requesting-code-review/code-reviewer.md`. A Superpowers release that moves those files breaks runs; preflight's file list is the guard.
4. **Agent roles** live in the workflow's `AG` map (`fast`, `standard`, `reviewer`, `escalation`, `planner`), defaulting to the bundled agents; the skill passes preflight's `AGENTS` as `args.agents` to override them. `sp-planner` is always the bundled one.
5. **Git side effects happen only in scripts**, which agents are told to run: `lanes` owns the persistent lane worktrees under `.worktrees/`, and `merge-queue` is the single writer of the plan branch and the SDD ledger (`progress.md`), merging batches, running the suite and bisecting culprits.

## Testing the workflow

`test/harness.mjs` evaluates the workflow source with stubbed `agent`/`parallel`/`log` globals and records every call. `test/fakes.mjs`'s `fakeAgent(route)` answers by call label (`T1·impl`, `T1·review`, `T1·fix-r1`, `merge·b1`, `planner·S1`, `final-review`, …): return a value from `route` to override one call, `undefined` for the success default. Assert on `calls` (labels, `agentType`, prompts) and on the returned `result`.
