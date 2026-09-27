# Parallel Plan Execution — Design

Date: 2026-09-27
Status: Draft for review

## 1. Intent

**Goal:** cut wall-clock time when executing Superpowers implementation plans, by running independent tasks in parallel, without degrading quality and without growing the controller session's context.

**Success is measured against today's sequential subagent-driven development (SDD)** on: wall-clock time, tokens per role, controller peak context, and output quality (see §8).

**Constraints (from the user):**
- Delivered as a personal plugin, `superpowers-parallel`, in its own repo (`~/Projects/superpowers-parallel`), registered in the local marketplace (`~/.claude/local-marketplace`). Superpowers itself is not forked or modified.
- Reuse Superpowers' SDD scripts and prompts from the installed version, so upstream updates flow in.
- Use the existing `sp-*` agents (`~/.claude/agents/`) for model/effort routing.
- Worktrees live under `.worktrees/` at the repo root (global convention).
- Never push, never merge into the default branch; integration into main stays with `superpowers:finishing-a-development-branch`.
- Agent Teams stays enabled on this machine (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). A subagent spawned *from the main conversation* with `name` launches as a teammate (inherits the lead's effort, runs in the main working directory). The skill therefore never passes `name` when dispatching from the main session; Workflow agents and subagents spawned by other subagents are unaffected.

**Out of scope (possible phase 2):** Paseo-based parallelism across whole plans or repos; Agent Teams as the execution backbone (it is measured as benchmark arm C, §8); contributing upstream (obra/superpowers #469, #1835).

## 2. Chosen approach

A skill (`parallel-plan-execution`) prepares the run and hands a dependency graph to a Claude Code **Workflow** script (`parallel-sdd.js`), which drives implementers and reviewers concurrently in **persistent lane worktrees** and integrates finished tasks through a **serialized merge queue**.

Rejected alternatives:
- *Parallel `Agent` calls from `sp-orchestrator`*: controller context grows with every report, no resume, parallelism depends on model discretion.
- *Agent Teams*: its docs state that for "sequential tasks, same-file edits, or work with many dependencies" subagents are more effective. Teammates run in the main working directory (per-call `isolation` turns the spawn into a plain subagent), inherit the lead's effort, report every final answer into the lead's (main session's) context, and in-process teammates are not restored on resume. Its strengths (native task dependencies, `TaskCompleted`/`TaskCreated` hooks, direct messaging) are covered here by the signal/planner design (§5.1) and measured in benchmark arm C.
- *Wave-based Workflow* (earlier draft): a wave barrier makes one slow task stall the next wave; per-agent ephemeral worktrees reinstall dependencies and fight `worktree.baseRef: "fresh"`.

## 3. Components

| Unit | Kind | Responsibility | Depends on |
|---|---|---|---|
| `skills/parallel-plan-execution/SKILL.md` | Skill (main session) | Preconditions, run analyzer, present graph for approval, launch Workflow, relay final report and "Rulings I made" verbatim | Superpowers ≥ 6.4.1, `sp-*` agents |
| Plan analyzer | Read-only subagent (sonnet, effort medium), prompt in `skills/parallel-plan-execution/analyzer-prompt.md` | Produce `plan-graph.json` and a speedup estimate | Plan file |
| `scripts/validate-graph` | Bash | Validate `plan-graph.json` (schema, acyclic, file-ownership overlap only between dependent tasks) | `jq` |
| `scripts/lanes` | Bash | `create N`, `reset <lane> <branch>`, `remove` for `.worktrees/<plan-slug>-lane-<i>` | git |
| `scripts/merge-queue` | Bash | Rebase task branch onto plan branch, `--no-ff` merge, batch merge, revert, bisect helper | git |
| `workflows/parallel-sdd.js` | Workflow script, shipped in the plugin's `workflows/` dir | Graph-scheduled pipeline, fix loop, merge queue, final review; returns compact report | all above |
| `agents/sp-planner.md` | Agent definition shipped by the plugin (opus, effort high) | Resolve signals (questions, gaps, interface changes, new tasks); append rulings to `decisions.md`; mutate the task graph | `plan-graph.json`, spec, plan |
| `bench/` | Fixtures + scripts | Two benchmark repos with plans, metrics extractor, report | §8 |

Superpowers assets are resolved at runtime from the installed plugin path (latest version directory under `~/.claude/plugins/cache/claude-plugins-official/superpowers/`): `scripts/sdd-workspace`, `scripts/task-brief`, `scripts/review-package`, `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`. The skill fails fast if any is missing.

## 4. Data model

### `plan-graph.json`
Written to `.superpowers/sdd/<plan-slug>/plan-graph.json`.

```json
{
  "plan": "docs/superpowers/plans/<plan>.md",
  "tasks": [
    {
      "id": "T3",
      "title": "…",
      "deps": ["T1"],
      "files": ["src/a.ts", "test/a.test.ts"],
      "risk": "low | high",
      "tier": "fast | standard",
      "rationale": "why these deps/files"
    }
  ],
  "critical_path": ["T1", "T3", "T6"],
  "estimated_speedup": 1.9,
  "recommendation": "parallel | sequential-sdd"
}
```

Rules the analyzer applies (conservative):
- Two tasks that own a common file, or where one's plan text references the other's output, get a dependency edge (earlier plan order → later).
- When unsure, add the edge.
- `risk: high` when a task touches more than 2 files, shared interfaces, concurrency, persistence schemas, or the plan gives prose instead of code.
- `tier: fast` only when the plan text contains the complete code for a 1-2 file task (maps to `sp-implementer-fast`); otherwise `standard` (`sp-implementer`).
- `recommendation: sequential-sdd` when `estimated_speedup < 1.3`.

### Ledger
Superpowers' `progress.md` stays the ledger. **Only the merge queue writes to it** (single writer). Per-task briefs and reports stay on disk in the SDD workspace, as in SDD.

### Branches
- Plan branch: `plan/<plan-slug>` (created by the skill from the current HEAD).
- Task branch: `plan/<plan-slug>--<task-id>`, created inside a lane from the current plan branch tip.

## 5. Data flow

1. **Prepare (main session, skill):**
   1. Check: git repo, clean working tree, plan file exists and was approved, Superpowers assets resolvable, `sp-*` agents present.
   2. Create plan branch; run `sdd-workspace`.
   3. Dispatch analyzer → `plan-graph.json`; run `validate-graph`.
   4. Present the graph (task table, critical path, speedup estimate, recommendation). **Wait for approval.** If the recommendation is `sequential-sdd`, offer the normal SDD via `sp-orchestrator` instead.
   5. Launch `parallel-sdd.js` with `args`: plan path, graph path, plan branch, Superpowers path, lane count (default 3), merge batch size (default 3).
2. **Setup (Workflow):** one agent runs `lanes create N` from the plan branch and installs dependencies once per lane (project's setup command, detected from the plan or repo; recorded in the report).
3. **Schedule (Workflow, deterministic JS):** each task gets a promise that awaits its dependencies' *merged* promises, then waits for a free lane (a JS semaphore of size N). No wave barrier: wall-clock approaches the critical path.
4. **Per task, in its lane (pipeline stages):**
   1. *Implement* — agent (`sp-implementer-fast` or `sp-implementer` by `tier`), cwd = lane path: `lanes reset` to the plan branch tip, create the task branch, `task-brief`, implement with TDD, run the task's tests, commit. Brief states the owned files; touching others ⇒ report BLOCKED. Returns `{branch, commit, files_touched, tests, status}`.
   2. *Review* — read-only, no worktree: `sp-reviewer` on the task branch diff via `review-package`; checks spec compliance and file-ownership scope. `risk: high` adds a second, integration-focused `sp-reviewer` in parallel. Returns `{verdict, findings[]}`.
   3. *Fix loop* — on findings, a fixer continues the same branch in the same lane, followed by a scoped re-review; up to 5 rounds, rounds 4-5 on `sp-final-reviewer`.
5. **Merge queue (single serialized JS promise chain):** approved tasks enqueue; the queue takes the tasks that are ready *now*, up to `batch` (it never waits to fill a batch), and for each rebases its branch onto the plan branch and merges `--no-ff`; then runs the full test suite once for the batch. Green ⇒ update ledger, resolve those tasks' merged promises, free dependants. Red ⇒ bisect the batch (revert, re-test) to find the culprit; see §6.
   **Integration checkpoints:** after every 3 merged tasks, a read-only `sp-reviewer` (label `checkpoint·<n>`) reviews the cumulative plan-branch diff since the previous checkpoint for cross-task coherence: duplicated helpers, inconsistent contracts between modules, drifting conventions. Findings become signals (§5.1). The Opus final review is unchanged.
6. **Finish:** `sp-final-reviewer` reviews the whole plan branch (`review-package` from merge base). Cleanup agent removes lanes (`lanes remove`), keeping lanes that hold a blocked task. Workflow returns the compact report.
7. **Report to the main session:** per task (status, rounds, reviewer tier), blocked/skipped list with reasons, merge-queue events, final review findings, "Rulings I made" verbatim, and timing/setup notes. Nothing else enters the controller's context.

### 5.1 Coordination: signals, planner, and new tasks

Agents never message each other: coordination goes through structured results and files on disk, so runs stay deterministic and resumable.

- **Signals.** Every implementer, fixer, reviewer and checkpoint result carries `signals[]`: `{type: question | gap | interface_change | new_task, affects: [task ids], detail}`.
- **Planner queue.** The script feeds signals, one at a time, to a serialized `sp-planner` queue (label `planner·S<n>`). The planner:
  - answers from the plan/spec when it can, recording a ruling in `.superpowers/sdd/<plan-slug>/decisions.md` (these join "Rulings I made");
  - for `interface_change`, either requires conformance to the plan's contract or accepts it and adds an adaptation task for affected tasks;
  - when the question needs the user (spec or scope change), blocks the task and its descendants; independent work continues and the question is reported at the end.
- **Propagation.** Every implementer, fixer and reviewer reads `decisions.md` at start. Tasks already running receive new rulings at their next fix round; if a ruling invalidates committed work, the planner schedules an extra fix round for that task.
- **New tasks.** `new_task` signals and checkpoint findings are classified by the planner:
  - *required for the plan to work* → added to the live graph with deps and owned files; ownership is re-validated, and an overlap with an active task becomes a dependency edge;
  - *improvement or out of scope* → appended to `backlog.md`, reported, not executed.
  - **Scope guard:** at most 3 new tasks per run, or 30% of the plan's task count, whichever is lower; beyond that, new tasks go to the backlog and the report flags the plan as likely incomplete.
- **Dispatch.** New tasks enter the same scheduler (deps merged + free lane). The agent is always fresh; the *lane* (worktree + installed dependencies) is what gets reused. Workflow agents are single-use, so, unlike SDD's resumed implementer for fix rounds 1-3, each fixer is a fresh agent given the brief, the previous report and the findings (extra tokens measured in §8).

### 5.2 Naming and observability

One naming scheme everywhere, so any message is attributable to the orchestrator or a specific agent:

- Agent labels: `T3·impl`, `T3·fix-r2`, `T3·review`, `T3·review-int`, `merge·b4`, `checkpoint·2`, `planner·S7`, `final-review`, `setup`.
- Progress groups (`phase`): one per task (`T3 — <title>`), plus `Merge queue`, `Planner`, `Final`.
- `log()` lines: `[orchestrator] …` or `[T3] …`.
- Commits `T3: <message>`; branches `plan/<slug>/T3`; ledger and log record lane occupancy (`lane-2 ⇐ T3`).
- Final report grouped by task, with each ruling attributed to its author (`planner·S7`, `T3·impl`).
- The main session only shows the graph approval and the final report.

## 6. Error handling

The Workflow cannot ask the user mid-run, so it never takes risky decisions itself: it isolates the failure, finishes whatever is independent, and returns.

| Failure | Handling |
|---|---|
| Implementer BLOCKED, fix loop exhausted (5 rounds), or agent returns `null` | Task → `blocked` (reason in ledger). Its descendants in the graph → `skipped`. Independent tasks continue. |
| Rebase conflict in merge queue | Sent back to the same task and lane as one extra fix round (resolve conflict on top of the current plan branch, re-review). Still failing ⇒ `blocked`. Logged as an analyzer miss. |
| Batch red after merge | Bisect by reverting merges in the batch; culprit task gets one extra fix round on the integrated code; still red ⇒ revert its merge, `blocked`. |
| Lane setup fails | Run aborts before any task starts, with the setup log path. |
| Session interruption / API error | Resume via `Workflow({scriptPath, resumeFromRunId})`; completed agents replay from cache; git branches and ledger are the source of truth. Every stage is idempotent: implement/fix check for an existing commit on the task branch; the queue skips tasks already merged. |

After a run with blocked/skipped tasks, the user decides (fix the plan, fix by hand, drop the task), then the run resumes.

Safety limits: default 3 lanes (configurable, capped by the Workflow concurrency limit); no push; no merge into the default branch; no `--force` except `git worktree remove --force` on the plugin's own lanes.

## 7. Cost and context expectations

- **Time:** approaches the critical-path duration plus fixed lane setup and merge-queue test runs.
- **Setup:** N dependency installs per run (not per agent).
- **Controller context:** graph approval + one compact report; independent of plan size.
- **Tokens:** roughly SDD's, plus the analyzer, second reviewers on high-risk tasks, and conflict/bisect retries.
- **Quality:** same implementer/reviewer prompts and fix loop as SDD; full suite still defines green, enforced at the merge queue; Opus final review unchanged.

## 8. Testing and benchmark

### Plugin tests
- `bats` tests over temporary git repos for `validate-graph` (cycles, overlapping ownership without edge), `lanes`, and `merge-queue` (rebase conflict, batch bisect).
- `dryRun: true` in Workflow `args` swaps `agent()` for canned results to test scheduling order, blocked→skipped propagation, and resume, at zero token cost.
- Analyzer fixtures: 3 plans with a known correct graph.

### Benchmark
- **A:** current SDD via `sp-orchestrator`. **B:** this mode. **C:** Agent Teams: lead + 3 teammates spawned from the `sp-implementer*` definitions, each told to work only in its assigned `.worktrees/` lane, task list loaded with `plan-graph.json` dependencies, and a `TaskCompleted` hook that rejects completion without green task tests and a reviewer verdict.
- **Fixtures (`bench/`):** a *wide* plan (~8 tasks, mostly independent) and a *narrow* control plan (~6 tasks, mostly chained).
- **Protocol:** 2 runs per plan per mode; same session model and `sp-*` agents.
- **Metrics** (extracted by `bench/metrics` from transcripts and ledger): wall-clock total, lane setup, merge-queue wait; tokens per role and estimated cost; controller peak context; tests green at end; final-review findings by severity; fix rounds; conflicts; blocked tasks.
- **Output:** Markdown report with a comparison table.
- **Success criteria:** on the wide plan, B ≥ 40% faster than A, tokens ≤ +20%, no new Critical/Important final-review findings. On the narrow plan, B does not regress, and the analyzer recommends sequential SDD.

## 9. Open risks

- Dependency setup time per lane may dominate on small plans (measured as its own metric).
- Analyzer false negatives (missed dependency) surface as conflicts; mitigated by ownership rules and the conflict fix round.
- Workflow runtime limits (concurrency cap ≈ CPUs − 2) bound the lane count on this machine. Runs above 25 agents or 1.5M projected tokens show a "Large workflow" warning; an 8-task plan with reviews and fix rounds can cross it.
- Fresh fixers (no implementer resume) may cost more tokens per fix round than SDD.
- Planner decisions are model judgment; every ruling is logged and surfaced verbatim for the user to audit.
