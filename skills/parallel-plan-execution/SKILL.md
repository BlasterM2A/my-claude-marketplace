---
name: parallel-plan-execution
description: Use when executing an approved Superpowers implementation plan whose tasks are partly independent and wall-clock time matters - runs tasks in parallel lane worktrees with a serialized merge queue, instead of sequential subagent-driven development
---

# Parallel Plan Execution

Runs an approved plan with the `parallel-sdd` Workflow: tasks start as soon as their dependencies are merged, each in a persistent lane worktree, and a single merge queue integrates them with full-suite tests. The main session only approves the task graph and relays the final report.

**Announce:** "I'm using parallel-plan-execution to run this plan in parallel lanes."

`PLUGIN_DIR` below is two levels above this skill's base directory. Never pass `name` when dispatching a subagent from this session.

## 1. Preflight

Run `PLUGIN_DIR/scripts/preflight <repo root> <plan path>`.
- On errors, stop and show them. For ".worktrees/ is not git-ignored", offer to add `.worktrees/` to `.gitignore` and commit it.
- Keep `SP_SKILLS` and `TASKS` from its output.

## 2. Branch, workspace, briefs

- `BASE_BRANCH` = the current branch. `SLUG` = the plan file name without `.md`. `PLAN_BRANCH` = `plan/<SLUG>`.
- If `PLAN_BRANCH` exists, this is a resume: `git switch <PLAN_BRANCH>`. Otherwise `git switch -c <PLAN_BRANCH>`.
- `WS=$(SP_SKILLS/subagent-driven-development/scripts/sdd-workspace <plan>)`.
- If `WS/progress.md` does not exist, create it with the single line `# SDD ledger — plan: <plan path>`.
- For N in 1..TASKS: `SP_SKILLS/subagent-driven-development/scripts/task-brief <plan> <N>`.

## 3. Analyze the plan

Dispatch one read-only `general-purpose` subagent with `model: "sonnet"`, whose prompt is `analyzer-prompt.md` (this directory) with `{{PLAN}}`, `{{SPEC}}`, `{{REPO}}` and `{{OUT}}` (= `WS/plan-graph.json`) replaced. The spec path is the one named in the plan header.

Then run `node PLUGIN_DIR/scripts/validate-graph.mjs WS/plan-graph.json`. On errors, re-dispatch the analyzer once with the errors appended; if they persist, show them and stop.

## 4. Approve the graph (hard gate)

Show the user a table (id, title, deps, risk, tier, files), the critical path, the estimated speedup, the recommendation, `test_command` and `setup_command`. Ask them to approve or correct it; apply corrections to `plan-graph.json` and re-validate.

If the recommendation is `sequential-sdd`, say so and offer the normal route instead (one `sp-orchestrator` subagent running superpowers:subagent-driven-development). Do not start the Workflow without explicit approval.

## 5. Run the Workflow

Call the Workflow tool with `scriptPath: PLUGIN_DIR/workflows/parallel-sdd.js` and `args`:
```json
{
  "plan": "<absolute plan path>", "spec": "<absolute spec path>", "repo": "<absolute repo root>",
  "baseBranch": "<BASE_BRANCH>", "planBranch": "<PLAN_BRANCH>", "slug": "<SLUG>",
  "workspace": "<WS>", "pluginDir": "<PLUGIN_DIR>", "spSkills": "<SP_SKILLS>",
  "lanes": 3, "graph": <contents of plan-graph.json>
}
```
Tell the user they can follow it in `/workflows`. Keep the returned run id for resumes.

## 6. Report

When it completes, show:
1. A task table from `tasks` (id, state, rounds, reason).
2. "Rulings I made": every entry of `rulings`, verbatim, with its `by`.
3. `backlog` entries, and blocked/skipped tasks with their reasons.
4. The final review verdict and its Critical/Important findings.
5. `lanes_kept`, if any.

If tasks are blocked or skipped, ask the user how to resolve each (fix the plan, fix by hand in the kept lane, or drop the task). After their changes, resume with `Workflow({ scriptPath, resumeFromRunId, args })`, updating `args.graph` if the graph changed.

When everything is merged and the final review has no open Critical/Important findings, use superpowers:finishing-a-development-branch for `PLAN_BRANCH`.
