# Parallel Plan Execution Plugin — Implementation Plan (1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `superpowers-parallel` Claude Code plugin: a skill plus a Workflow script that execute an approved Superpowers plan with parallel lane worktrees, a serialized merge queue, and planner-driven coordination.

**Architecture:** Deterministic helpers (`validate-graph.mjs`, `lanes`, `merge-queue`, `preflight`) do all git and file work and are unit-tested. `workflows/parallel-sdd.js` is a Claude Code Workflow script that schedules tasks from `plan-graph.json`, dispatches `sp-*` agents with structured-output schemas, and never touches the filesystem itself; it is tested in Node with stubbed `agent()`. The `parallel-plan-execution` skill runs in the main session: preflight, briefs, analyzer, graph approval, Workflow launch, report relay.

**Tech Stack:** Bash 5, git ≥ 2.40, jq, Node 24+ (no npm dependencies; `node:test`), bats-core, Taskfile, mise.

**Spec:** `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md`

Plan 2 (separate, later): the benchmark in spec §8 ("Benchmark"), which needs this plugin installed.

## Global Constraints

- All code, comments, docs and commit messages in English.
- No npm dependencies: Node scripts use only built-in modules; the Workflow script uses only the Workflow globals (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`) and plain JS — no `import`, no `Date.now()`, no `Math.random()`, no filesystem access.
- Tools are installed with `mise use <tool>@<version>` (never by hand-editing `mise.toml`), after checking `mise latest <tool>`. Tasks live in `Taskfile.yml`.
- Worktrees live under `<repo>/.worktrees/`; lanes are named `.worktrees/<plan-slug>-lane-<i>`.
- Branches: plan branch `plan/<plan-slug>`, task branches `plan/<plan-slug>--<task-id>`; task ids are `T<N>` (plan task N) and `N<k>` (tasks added at run time).
- Never push; never merge into the default branch; no `--force` except `git worktree remove --force` on the run's own lanes.
- Agent prompts must state: "Your Bash working directory resets between commands: always use absolute paths, `git -C <dir>` or `(cd <dir> && ...)`." (this machine sets `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`).
- The skill never passes `name` when dispatching from the main session (named subagents become Agent Teams teammates here).
- Default agent types: `sp-implementer-fast`, `sp-implementer`, `sp-reviewer`, `sp-final-reviewer`, `superpowers-parallel:sp-planner`; overridable via Workflow `args.agents`.
- Defaults: 3 lanes, merge batch 3 (never waits to fill), checkpoint every 3 merges, fix loop 5 rounds (rounds 4-5 on the escalation agent), new-task cap `min(3, ceil(0.3 × plan task count))`.

**Spec clarifications decided in this plan:**
- `plan-graph.json` gains `test_command` (required, non-empty) and `setup_command` (may be empty); the analyzer detects both and the user confirms them at graph approval.
- The merge queue merges task branches with `git merge --no-ff` directly instead of rebasing: task branches are checked out in lanes, so they cannot be rebased from the main checkout; conflict detection is identical.
- Spec §8 "`dryRun: true` in Workflow args" is realized as a Node harness that injects a stubbed `agent()`; it tests the same scheduling logic at zero token cost.
- New-task cap uses `ceil` so small plans still admit one new task.

## Review Focus

1. **Plan headings not in `### Task N:` form** → preflight must fail with a message naming the expected heading format, not produce an empty graph (Task 8).
2. **Repo with no detectable test command** → `validate-graph` must reject an empty `test_command`, so "no tests" is never treated as green (Task 1).
3. **Run interrupted mid-merge** (a `MERGE_HEAD` left in the plan checkout) → `merge-queue` aborts the stale merge and proceeds (Task 3).
4. **Resumed run whose task branch already exists**, possibly checked out in a different lane → `lanes checkout` keeps its commits and moves it (Task 2).
5. **Dirty main checkout or `.worktrees/` not git-ignored** → preflight refuses to start and says how to fix it (Task 8).

---

### Task 1: Plugin scaffold and graph validator

**Files:**
- Create: `.claude-plugin/plugin.json`, `Taskfile.yml`, `AGENTS.md`, `CLAUDE.md`, `mise.toml` (via `mise use`)
- Create: `scripts/validate-graph.mjs`
- Test: `test/validate-graph.test.mjs`

**Interfaces:**
- Produces: `validateGraph(graph) -> string[]` (empty = valid), exported from `scripts/validate-graph.mjs`; CLI `node scripts/validate-graph.mjs <graph.json>` prints `ok` (exit 0) or one error per line on stderr (exit 1).
- Graph shape: `{ plan, test_command, setup_command, tasks: [{ id, title, deps[], files[], risk: "low"|"high", tier: "fast"|"standard", rationale }], critical_path[], estimated_speedup, recommendation: "parallel"|"sequential-sdd" }`.

- [ ] **Step 1: Install tools**

Run `mise latest bats`, `mise latest node`, `mise latest task`, then in the repo root:
```bash
mise use bats@<latest> node@<latest> task@<latest>
```
Expected: `mise.toml` created with the three tools.

- [ ] **Step 2: Create scaffold files**

`.claude-plugin/plugin.json`:
```json
{
  "name": "superpowers-parallel",
  "description": "Execute approved Superpowers plans in parallel lane worktrees with a serialized merge queue.",
  "version": "0.1.0"
}
```

`Taskfile.yml`:
```yaml
version: '3'

tasks:
  test:
    desc: Run all tests
    cmds:
      - task: test:bash
      - task: test:node
  test:bash:
    desc: Run bats tests for the shell scripts
    cmds:
      - bats test/
  test:node:
    desc: Run node tests for the graph validator and the workflow
    cmds:
      - node --test "test/**/*.test.mjs"
```

`AGENTS.md`:
```markdown
# superpowers-parallel

Claude Code plugin that runs approved Superpowers plans in parallel.

- Spec: `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md`
- Run tests with `task test` (bats for `scripts/lanes`, `scripts/merge-queue`, `scripts/preflight`; `node:test` for everything else).
- `workflows/parallel-sdd.js` is a Claude Code Workflow script: plain JS, no imports, no filesystem, no `Date.now()`/`Math.random()`. Test it through `test/harness.mjs`.
- Shell scripts: `set -euo pipefail`, usage text in the header comment, exit 2 on bad usage, exit 3 on unsafe state.
```

`CLAUDE.md`:
```
@AGENTS.md
```

- [ ] **Step 3: Write the failing tests**

`test/validate-graph.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateGraph } from '../scripts/validate-graph.mjs'

const task = (id, over = {}) => ({ id, title: `Task ${id}`, deps: [], files: [`src/${id}.js`], risk: 'low', tier: 'standard', rationale: 'r', ...over })
const graph = (tasks, over = {}) => ({ plan: 'p.md', test_command: 'npm test', setup_command: '', tasks, critical_path: [], estimated_speedup: 1, recommendation: 'parallel', ...over })

test('accepts a valid graph', () => {
  assert.deepEqual(validateGraph(graph([task('T1'), task('T2', { deps: ['T1'] })])), [])
})

test('rejects an empty test_command', () => {
  assert.deepEqual(validateGraph(graph([task('T1')], { test_command: '  ' })), ['test_command must be a non-empty string'])
})

test('rejects missing tasks', () => {
  assert.deepEqual(validateGraph(graph([])), ['tasks must be a non-empty array'])
})

test('rejects bad ids, duplicates and bad enums', () => {
  const errors = validateGraph(graph([task('X1'), task('T2', { risk: 'mid' }), task('T2', { tier: 'slow' })]))
  assert.ok(errors.includes('invalid task id: "X1"'))
  assert.ok(errors.includes('T2: risk must be low|high'))
  assert.ok(errors.includes('duplicate task id: T2'))
  assert.ok(errors.includes('T2: tier must be fast|standard'))
})

test('rejects unknown dependencies', () => {
  assert.deepEqual(validateGraph(graph([task('T1', { deps: ['T9'] })])), ['T1: unknown dep T9'])
})

test('rejects cycles', () => {
  const errors = validateGraph(graph([task('T1', { deps: ['T3'] }), task('T2', { deps: ['T1'] }), task('T3', { deps: ['T2'] })]))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^dependency cycle: /)
})

test('rejects shared files between tasks with no dependency path', () => {
  const errors = validateGraph(graph([task('T1', { files: ['a.js'] }), task('T2', { files: ['a.js', 'b.js'] })]))
  assert.deepEqual(errors, ['T1 and T2 share a.js without a dependency path'])
})

test('accepts shared files when a transitive dependency path exists', () => {
  const tasks = [task('T1', { files: ['a.js'] }), task('T2', { deps: ['T1'], files: ['b.js'] }), task('T3', { deps: ['T2'], files: ['a.js'] })]
  assert.deepEqual(validateGraph(graph(tasks)), [])
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/validate-graph.test.mjs`
Expected: FAIL with "Cannot find module .../scripts/validate-graph.mjs"

- [ ] **Step 5: Implement the validator**

`scripts/validate-graph.mjs`:
```js
#!/usr/bin/env node
// Validate a plan-graph.json produced by the plan analyzer.
// Usage: node validate-graph.mjs <plan-graph.json>
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function validateGraph(g) {
  if (!g || !Array.isArray(g.tasks) || g.tasks.length === 0) return ['tasks must be a non-empty array']
  const errors = []
  if (typeof g.test_command !== 'string' || !g.test_command.trim()) errors.push('test_command must be a non-empty string')
  const ids = new Set()
  for (const t of g.tasks) {
    if (!/^(T|N)\d+$/.test(t.id ?? '')) errors.push(`invalid task id: ${JSON.stringify(t.id)}`)
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`)
    ids.add(t.id)
    if (!Array.isArray(t.deps)) errors.push(`${t.id}: deps must be an array`)
    if (!Array.isArray(t.files) || t.files.length === 0) errors.push(`${t.id}: files must be a non-empty array`)
    if (!['low', 'high'].includes(t.risk)) errors.push(`${t.id}: risk must be low|high`)
    if (!['fast', 'standard'].includes(t.tier)) errors.push(`${t.id}: tier must be fast|standard`)
  }
  if (errors.length) return errors

  for (const t of g.tasks) for (const d of t.deps) if (!ids.has(d)) errors.push(`${t.id}: unknown dep ${d}`)
  if (errors.length) return errors

  const byId = new Map(g.tasks.map(t => [t.id, t]))
  const cycle = findCycle(byId)
  if (cycle) return [`dependency cycle: ${cycle.join(' -> ')}`]

  const ancestors = new Map()
  const ancestorsOf = id => {
    if (!ancestors.has(id)) {
      const set = new Set()
      for (const d of byId.get(id).deps) { set.add(d); for (const a of ancestorsOf(d)) set.add(a) }
      ancestors.set(id, set)
    }
    return ancestors.get(id)
  }
  const tasks = g.tasks
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j]
      const shared = a.files.filter(f => b.files.includes(f))
      if (shared.length && !ancestorsOf(a.id).has(b.id) && !ancestorsOf(b.id).has(a.id)) {
        errors.push(`${a.id} and ${b.id} share ${shared.join(', ')} without a dependency path`)
      }
    }
  }
  return errors
}

function findCycle(byId) {
  const color = new Map()
  const stack = []
  const visit = id => {
    color.set(id, 'grey'); stack.push(id)
    for (const d of byId.get(id).deps) {
      if (color.get(d) === 'grey') return [...stack.slice(stack.indexOf(d)), d]
      if (!color.has(d)) { const c = visit(d); if (c) return c }
    }
    color.set(id, 'black'); stack.pop()
    return null
  }
  for (const id of byId.keys()) if (!color.has(id)) { const c = visit(id); if (c) return c }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('usage: validate-graph.mjs <plan-graph.json>'); process.exit(2) }
  const errors = validateGraph(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  if (errors.length) { for (const e of errors) console.error(e); process.exit(1) }
  console.log('ok')
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/validate-graph.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin Taskfile.yml AGENTS.md CLAUDE.md mise.toml scripts/validate-graph.mjs test/validate-graph.test.mjs
git commit -m "feat: add plugin scaffold and plan graph validator"
```

---

### Task 2: Lane worktree manager

**Files:**
- Create: `scripts/lanes`
- Create: `test/helpers.bash`
- Test: `test/lanes.bats`

**Interfaces:**
- Produces (CLI, used by Workflow agent prompts):
  - `lanes create REPO SLUG COUNT BASE_BRANCH` → prints one absolute lane path per line; idempotent; exit 2 if BASE_BRANCH is missing.
  - `lanes checkout LANE TASK_BRANCH BASE_BRANCH` → existing branch: keeps its commits (moving it out of another clean worktree if needed); new branch: created from BASE_BRANCH; exit 3 if LANE (or the worktree holding the branch) is dirty.
  - `lanes remove REPO SLUG [KEEP_LANE...]` → removes the run's lanes except KEEP_LANE paths.
- Produces `test/helpers.bash` → `make_repo` prints the path of a fresh repo on `main` with `.worktrees/` and `.superpowers/` git-ignored and one commit touching `file.txt`.

- [ ] **Step 1: Write the test helper and failing tests**

`test/helpers.bash`:
```bash
# Shared bats helpers.
make_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  printf '.worktrees/\n.superpowers/\n' >"$dir/.gitignore"
  echo base >"$dir/file.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  echo "$dir"
}
```

`test/lanes.bats`:
```bash
setup() {
  load helpers
  REPO=$(make_repo)
  git -C "$REPO" branch plan/p
  LANES="$BATS_TEST_DIRNAME/../scripts/lanes"
  L1="$REPO/.worktrees/p-lane-1"
  L2="$REPO/.worktrees/p-lane-2"
}

teardown() { rm -rf "$REPO"; }

@test "create makes N detached lanes and is idempotent" {
  run "$LANES" create "$REPO" p 2 plan/p
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "$L1" ]
  [ "${lines[1]}" = "$L2" ]
  run "$LANES" create "$REPO" p 2 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" worktree list | wc -l)" -eq 3 ]
}

@test "create fails on an unknown base branch" {
  run "$LANES" create "$REPO" p 1 nope
  [ "$status" -eq 2 ]
}

@test "checkout creates the task branch from the base branch" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L1" branch --show-current)" = plan/p--T1 ]
  [ "$(git -C "$L1" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse plan/p)" ]
}

@test "checkout keeps existing commits on a resumed task branch" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  "$LANES" checkout "$L1" plan/p--T1 plan/p
  echo work >"$L1/new.txt"
  git -C "$L1" add new.txt
  git -C "$L1" commit -qm "T1: work"
  sha=$(git -C "$L1" rev-parse HEAD)
  git -C "$L1" checkout -q --detach
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L1" rev-parse HEAD)" = "$sha" ]
}

@test "checkout moves a task branch out of another clean lane" {
  "$LANES" create "$REPO" p 2 plan/p >/dev/null
  "$LANES" checkout "$L1" plan/p--T1 plan/p
  run "$LANES" checkout "$L2" plan/p--T1 plan/p
  [ "$status" -eq 0 ]
  [ "$(git -C "$L2" branch --show-current)" = plan/p--T1 ]
  [ -z "$(git -C "$L1" branch --show-current)" ]
}

@test "checkout refuses a dirty lane" {
  "$LANES" create "$REPO" p 1 plan/p >/dev/null
  echo dirty >"$L1/file.txt"
  run "$LANES" checkout "$L1" plan/p--T1 plan/p
  [ "$status" -eq 3 ]
}

@test "remove deletes lanes except the kept ones" {
  "$LANES" create "$REPO" p 2 plan/p >/dev/null
  run "$LANES" remove "$REPO" p "$L2"
  [ "$status" -eq 0 ]
  [ ! -d "$L1" ]
  [ -d "$L2" ]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bats test/lanes.bats`
Expected: FAIL (7 tests, "scripts/lanes: No such file or directory")

- [ ] **Step 3: Implement `scripts/lanes`**

```bash
#!/usr/bin/env bash
# Manage the persistent lane worktrees of one parallel plan run.
#
# Usage:
#   lanes create REPO SLUG COUNT BASE_BRANCH     print one lane path per line
#   lanes checkout LANE TASK_BRANCH BASE_BRANCH  put TASK_BRANCH in LANE; an
#                                                existing branch keeps its commits
#   lanes remove REPO SLUG [KEEP_LANE...]        remove the lanes except KEEP_LANE
set -euo pipefail

usage() { sed -n '4,9p' "$0" >&2; exit 2; }

branch_exists() { git -C "$1" rev-parse --verify --quiet "refs/heads/$2" >/dev/null; }

# Print the path of the worktree that has BRANCH checked out, if any.
worktree_of() {
  git -C "$1" worktree list --porcelain |
    awk -v ref="branch refs/heads/$2" '/^worktree /{ path = substr($0, 10) } $0 == ref { print path }'
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  create)
    [ $# -eq 4 ] || usage
    repo=$(cd "$1" && pwd); slug=$2; count=$3; base=$4
    branch_exists "$repo" "$base" || { echo "no such branch: $base" >&2; exit 2; }
    mkdir -p "$repo/.worktrees"
    for i in $(seq 1 "$count"); do
      lane="$repo/.worktrees/$slug-lane-$i"
      [ -d "$lane" ] || git -C "$repo" worktree add --quiet --detach "$lane" "$base"
      echo "$lane"
    done
    ;;
  checkout)
    [ $# -eq 3 ] || usage
    lane=$(cd "$1" && pwd); branch=$2; base=$3
    [ -z "$(git -C "$lane" status --porcelain)" ] || { echo "lane not clean: $lane" >&2; exit 3; }
    if branch_exists "$lane" "$branch"; then
      holder=$(worktree_of "$lane" "$branch")
      if [ -n "$holder" ] && [ "$holder" != "$lane" ]; then
        [ -z "$(git -C "$holder" status --porcelain)" ] ||
          { echo "branch $branch is checked out in dirty worktree $holder" >&2; exit 3; }
        git -C "$holder" checkout --quiet --detach
      fi
      git -C "$lane" checkout --quiet "$branch"
    else
      git -C "$lane" checkout --quiet -b "$branch" "$base"
    fi
    ;;
  remove)
    [ $# -ge 2 ] || usage
    repo=$(cd "$1" && pwd); slug=$2; shift 2
    for lane in "$repo/.worktrees/$slug-lane-"*; do
      [ -d "$lane" ] || continue
      keep=no
      for k in "$@"; do [ "$k" = "$lane" ] && keep=yes; done
      [ "$keep" = yes ] || git -C "$repo" worktree remove --force "$lane"
    done
    git -C "$repo" worktree prune
    ;;
  *) usage ;;
esac
```
Then `chmod +x scripts/lanes`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bats test/lanes.bats`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lanes test/helpers.bash test/lanes.bats
git commit -m "feat: add lane worktree manager"
```

---

### Task 3: Merge queue

**Files:**
- Create: `scripts/merge-queue`
- Test: `test/merge-queue.bats`

**Interfaces:**
- Consumes: `test/helpers.bash` `make_repo` (Task 2).
- Produces (CLI): `merge-queue batch REPO PLAN_BRANCH LEDGER TEST_CMD TASK_ID=BRANCH...` → prints one JSON object `{"merged":[{"task":"T1","sha":"<full sha>"}],"conflicts":["T2"],"culprits":["T3"],"tests_passed":true,"test_log":"<path>"}`; appends `Task <N>: complete (merge <sha7>, <branch>)` to LEDGER once per merged task (`T3` → `Task 3`, `N1` → `Task N1`); exit 2 if REPO is not on PLAN_BRANCH or usage is wrong; exit 3 if the plan checkout has uncommitted tracked changes.

- [ ] **Step 1: Write the failing tests**

`test/merge-queue.bats`:
```bash
setup() {
  load helpers
  REPO=$(make_repo)
  git -C "$REPO" switch -q -c plan/p
  MQ="$BATS_TEST_DIRNAME/../scripts/merge-queue"
  LEDGER="$REPO/.superpowers/sdd/p/progress.md"
  mkdir -p "$(dirname "$LEDGER")"
  echo "# SDD ledger — plan: docs/p.md" >"$LEDGER"
  TEST_CMD='! grep -q BAD *.txt'
}

teardown() { rm -rf "$REPO"; }

# task_branch ID FILE CONTENT: commit FILE on plan/p--ID branched from plan/p.
task_branch() {
  git -C "$REPO" branch -q "plan/p--$1" plan/p
  local wt="$REPO/.worktrees/$1"
  git -C "$REPO" worktree add -q "$wt" "plan/p--$1"
  echo "$3" >"$wt/$2"
  git -C "$wt" add "$2"
  git -C "$wt" commit -qm "$1: change"
}

@test "merges clean branches, runs tests once and writes the ledger" {
  task_branch T1 a.txt one
  task_branch T2 b.txt two
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1","T2"]' ]
  [ "$(jq -r .tests_passed <<<"$output")" = true ]
  grep -q '^Task 1: complete (merge ' "$LEDGER"
  grep -q '^Task 2: complete (merge ' "$LEDGER"
}

@test "leaves a conflicting branch out" {
  task_branch T1 file.txt one
  task_branch T2 file.txt two
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1"]' ]
  [ "$(jq -c .conflicts <<<"$output")" = '["T2"]' ]
  [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]
}

@test "bisects a red batch and undoes the culprit" {
  task_branch T1 a.txt one
  task_branch T2 bad.txt BAD
  task_branch T3 c.txt three
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 T2=plan/p--T2 T3=plan/p--T3
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1","T3"]' ]
  [ "$(jq -c .culprits <<<"$output")" = '["T2"]' ]
  [ "$(jq -r .tests_passed <<<"$output")" = true ]
  [ ! -f "$REPO/bad.txt" ]
  ! grep -q '^Task 2:' "$LEDGER"
}

@test "aborts a merge left in progress by an interrupted run" {
  task_branch T1 file.txt one
  task_branch T2 file.txt two
  git -C "$REPO" merge -q --no-ff plan/p--T1 -m "Merge T1"
  git -C "$REPO" merge -q --no-ff plan/p--T2 -m "Merge T2" || true
  git -C "$REPO" rev-parse -q --verify MERGE_HEAD
  task_branch T3 c.txt three
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T3=plan/p--T3
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T3"]' ]
}

@test "refuses when the repo is not on the plan branch" {
  git -C "$REPO" switch -q main
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1
  [ "$status" -eq 2 ]
}

@test "re-running a merged batch does not duplicate ledger lines" {
  task_branch T1 a.txt one
  "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1 >/dev/null
  run "$MQ" batch "$REPO" plan/p "$LEDGER" "$TEST_CMD" T1=plan/p--T1
  [ "$status" -eq 0 ]
  [ "$(jq -c '[.merged[].task]' <<<"$output")" = '["T1"]' ]
  [ "$(grep -c '^Task 1:' "$LEDGER")" -eq 1 ]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bats test/merge-queue.bats`
Expected: FAIL (6 tests, "scripts/merge-queue: No such file or directory")

- [ ] **Step 3: Implement `scripts/merge-queue`**

```bash
#!/usr/bin/env bash
# Merge approved task branches into the plan branch as one batch, run the
# project's full test suite, and bisect the batch when it goes red. Only this
# script appends task completions to the SDD ledger (single writer).
#
# Usage: merge-queue batch REPO PLAN_BRANCH LEDGER TEST_CMD TASK_ID=BRANCH...
# Prints: {"merged":[{"task","sha"}],"conflicts":[ids],"culprits":[ids],
#          "tests_passed":bool,"test_log":path}
# A conflicting task is left out; a culprit is a task whose merge turns the
# suite red, and its merge is undone.
set -euo pipefail

if [ "${1:-}" != batch ] || [ $# -lt 6 ]; then sed -n '6,11p' "$0" >&2; exit 2; fi
repo=$2; plan_branch=$3; ledger=$4; test_cmd=$5
shift 5

cd "$repo"
[ "$(git branch --show-current)" = "$plan_branch" ] || { echo "repo is not on $plan_branch" >&2; exit 2; }
# An interrupted earlier run can leave a merge in progress.
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi
[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  { echo "plan checkout has uncommitted changes" >&2; exit 3; }

mkdir -p "$(dirname "$ledger")"
test_log="$(dirname "$ledger")/merge-$(git rev-parse --short HEAD).log"
conflicts=(); culprits=(); kept=()

merge_one() { # ID BRANCH -> 0 merged (or already merged), 1 conflict
  if git merge --no-ff --quiet -m "Merge $1 ($2)" "$2" >/dev/null 2>&1; then return 0; fi
  git merge --abort
  return 1
}
run_tests() { echo "== $(git rev-parse --short HEAD)" >>"$test_log"; bash -c "$test_cmd" >>"$test_log" 2>&1; }

pre=$(git rev-parse HEAD)
batch=()
for spec in "$@"; do
  if merge_one "${spec%%=*}" "${spec#*=}"; then batch+=("$spec"); else conflicts+=("${spec%%=*}"); fi
done

tests_passed=true
if [ ${#batch[@]} -gt 0 ]; then
  if run_tests; then
    kept=("${batch[@]}")
  else
    # Bisect: replay the batch one merge at a time, testing after each.
    git reset --quiet --hard "$pre"
    for spec in "${batch[@]}"; do
      merge_one "${spec%%=*}" "${spec#*=}" || { conflicts+=("${spec%%=*}"); continue; }
      if run_tests; then
        kept+=("$spec")
      else
        culprits+=("${spec%%=*}")
        git reset --quiet --hard HEAD^1
      fi
    done
  fi
fi

merged='[]'
for spec in "${kept[@]}"; do
  id=${spec%%=*}; branch=${spec#*=}
  sha=$(git log -1 --merges --format=%H --grep="^Merge $id (")
  n=${id#T}
  grep -q "^Task $n: complete" "$ledger" 2>/dev/null || echo "Task $n: complete (merge ${sha:0:7}, $branch)" >>"$ledger"
  merged=$(jq -c --arg t "$id" --arg s "$sha" '. + [{task: $t, sha: $s}]' <<<"$merged")
done

to_json() { if [ $# -eq 0 ]; then echo '[]'; else printf '%s\n' "$@" | jq -R . | jq -sc .; fi; }
jq -nc --argjson merged "$merged" --argjson conflicts "$(to_json "${conflicts[@]}")" \
  --argjson culprits "$(to_json "${culprits[@]}")" --argjson passed "$tests_passed" --arg log "$test_log" \
  '{merged: $merged, conflicts: $conflicts, culprits: $culprits, tests_passed: $passed, test_log: $log}'
```
Then `chmod +x scripts/merge-queue`.

Note: `tests_passed` stays `true` after a bisect because every kept merge was tested green; it is `false` only if a future change adds an untested path, so keep it in the output contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bats test/merge-queue.bats`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/merge-queue test/merge-queue.bats
git commit -m "feat: add serialized merge queue with batch bisect"
```

---

### Task 4: Workflow core — setup, scheduler, lanes, merge queue, report

**Files:**
- Create: `workflows/parallel-sdd.js`
- Create: `test/harness.mjs`, `test/fakes.mjs`
- Test: `test/workflow-core.test.mjs`

**Interfaces:**
- Consumes: CLIs `scripts/lanes` (Task 2), `scripts/merge-queue` (Task 3) — invoked by agents from prompts.
- Produces:
  - Workflow `args`: `{ plan, spec, repo, baseBranch, planBranch, slug, workspace, pluginDir, spSkills, lanes, batch?, checkpointEvery?, agents?, graph }` where `graph` is the parsed `plan-graph.json`.
  - Return value (report): `{ aborted, reason?, tasks: [{ id, title, state: "merged"|"blocked"|"skipped", reason, rounds, lane }], rulings: [{ by, text }], backlog: [], events: [], final_review, lanes_kept: [] }`.
  - Script-internal functions later tasks replace: `implementAndReview(t, lane)`, `reviewTask(t, tag, scoped)`, `mergeTask(t, lane)`, `collect(by, result)`, `onMerged(id)`.
  - Agent labels: `setup`, `<id>·impl`, `<id>·review`, `merge·b<n>`, `final-review`, `cleanup`; per-task phase `<id> — <title>`.
  - `test/harness.mjs`: `runWorkflow({ agent, args }) -> { result, calls, logs }`, `baseArgs(tasks, over)`, `task(id, over)`.
  - `test/fakes.mjs`: `fakeAgent(route?)` — `route(label, prompt, opts)` may return a value (or a promise) to override the default response for that call; `undefined` falls back to defaults.

- [ ] **Step 1: Write the harness and fakes**

`test/harness.mjs`:
```js
// Runs workflows/parallel-sdd.js in Node with stubbed Workflow globals.
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const SOURCE = readFileSync(new URL('../workflows/parallel-sdd.js', import.meta.url), 'utf8')
  .replace(/^export const meta/m, 'const meta')

export async function runWorkflow({ agent, args }) {
  const calls = []
  const logs = []
  const wrapped = async (prompt, opts = {}) => {
    calls.push({ prompt, ...opts })
    return agent(prompt, opts)
  }
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = () => { throw new Error('pipeline() is not used by parallel-sdd') }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', SOURCE)
  const result = await fn(wrapped, parallel, pipeline, () => {}, m => logs.push(m), args, budget)
  return { result, calls, logs }
}

export const task = (id, over = {}) => ({
  id, title: `Task ${id}`, deps: [], files: [`src/${id}.js`], risk: 'low', tier: 'standard', rationale: 'r', ...over,
})

export const baseArgs = (tasks, over = {}) => ({
  plan: '/repo/docs/plan.md', spec: '/repo/docs/spec.md', repo: '/repo', baseBranch: 'main',
  planBranch: 'plan/p', slug: 'p', workspace: '/repo/.superpowers/sdd/p', pluginDir: '/plugin',
  spSkills: '/sp/skills', lanes: 2,
  graph: { plan: 'docs/plan.md', test_command: 'npm test', setup_command: '', tasks },
  ...over,
})

export const labels = calls => calls.map(c => c.label)
```

`test/fakes.mjs`:
```js
// Stub agent() for workflow tests. Default responses make every task succeed.
export function fakeAgent(route = () => undefined) {
  return async (prompt, opts) => {
    const custom = await route(opts.label, prompt, opts)
    return custom !== undefined ? custom : defaults(opts.label, prompt)
  }
}

export const DONE = { status: 'DONE', branch: 'b', commit: 'c', files_touched: [], tests_passed: true, summary: 'ok', rulings: [], signals: [] }
export const APPROVED = { verdict: 'approved', findings: [], declined: [], signals: [] }
export const CHANGES = { verdict: 'changes_requested', findings: [{ severity: 'Important', detail: 'fix it' }], declined: [], signals: [] }

export function mergeAll(prompt) {
  const ids = [...prompt.matchAll(/\b([TN]\d+)=/g)].map(m => m[1])
  return { merged: ids.map(task => ({ task, sha: `sha-${task}` })), conflicts: [], culprits: [], tests_passed: true, test_log: '/ws/merge.log' }
}

function defaults(label, prompt) {
  if (label === 'setup') return { ok: true, lanes: ['/repo/.worktrees/p-lane-1', '/repo/.worktrees/p-lane-2'], error: '' }
  if (/·(impl|fix-.+)$/.test(label)) return DONE
  if (/·(review|review-int|re-review-.+)$/.test(label) || label.startsWith('checkpoint·') || label === 'final-review') return APPROVED
  if (label.startsWith('merge·')) return mergeAll(prompt)
  if (label.startsWith('planner·')) return { action: 'ruling', ruling: 'noted', affects: [], reason: 'r', rework: false, new_task: null }
  if (label === 'cleanup') return 'removed'
  throw new Error(`unexpected agent label: ${label}`)
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
```

- [ ] **Step 2: Write the failing tests**

`test/workflow-core.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, baseArgs, task, labels } from './harness.mjs'
import { fakeAgent, sleep, DONE } from './fakes.mjs'

test('independent tasks run in parallel up to the lane count', async () => {
  let active = 0, peak = 0
  const agent = fakeAgent(async label => {
    if (label.endsWith('·impl')) { active++; peak = Math.max(peak, active); await sleep(20); active-- }
  })
  const { result } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2'), task('T3')]) })
  assert.equal(peak, 2)
  assert.deepEqual(result.tasks.map(t => t.state), ['merged', 'merged', 'merged'])
})

test('a dependent task starts only after its dependency is merged', async () => {
  const { calls } = await runWorkflow({ agent: fakeAgent(), args: baseArgs([task('T1'), task('T2', { deps: ['T1'] })]) })
  const mergeT1 = calls.findIndex(c => c.label.startsWith('merge·') && c.prompt.includes('T1='))
  const implT2 = calls.findIndex(c => c.label === 'T2·impl')
  assert.ok(mergeT1 >= 0 && implT2 > mergeT1)
})

test('setup failure aborts before any task starts', async () => {
  const agent = fakeAgent(label => (label === 'setup' ? { ok: false, lanes: [], error: 'npm ci failed' } : undefined))
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.equal(result.aborted, true)
  assert.equal(result.reason, 'npm ci failed')
  assert.ok(!labels(calls).some(l => l.endsWith('·impl')))
})

test('uses the naming scheme, agent types and per-task phases', async () => {
  const { calls, logs } = await runWorkflow({ agent: fakeAgent(), args: baseArgs([task('T1', { tier: 'fast' })]) })
  assert.deepEqual(labels(calls), ['setup', 'T1·impl', 'T1·review', 'merge·b1', 'final-review', 'cleanup'])
  const impl = calls.find(c => c.label === 'T1·impl')
  assert.equal(impl.agentType, 'sp-implementer-fast')
  assert.equal(impl.phase, 'T1 — Task T1')
  assert.equal(calls.find(c => c.label === 'T1·review').agentType, 'sp-reviewer')
  assert.equal(calls.find(c => c.label === 'final-review').agentType, 'sp-final-reviewer')
  assert.ok(logs.includes('[orchestrator] lane-1 ⇐ T1'))
  assert.match(impl.prompt, /Bash working directory resets between commands/)
})

test('merge batches take whatever is ready without waiting', async () => {
  const agent = fakeAgent(async label => { if (label === 'T2·impl') await sleep(30) })
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2')]) })
  const merges = calls.filter(c => c.label.startsWith('merge·'))
  assert.equal(merges.length, 2)
  assert.ok(merges[0].prompt.includes('T1=') && !merges[0].prompt.includes('T2='))
})

test('no final review when nothing merged; blocked lanes are kept', async () => {
  const agent = fakeAgent(label => (label === 'T1·impl' ? { ...DONE, status: 'BLOCKED', summary: 'no access' } : undefined))
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.ok(!labels(calls).includes('final-review'))
  assert.equal(result.tasks[0].state, 'blocked')
  assert.equal(result.tasks[0].reason, 'implementer BLOCKED: no access')
  assert.deepEqual(result.lanes_kept, ['/repo/.worktrees/p-lane-1'])
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/workflow-core.test.mjs`
Expected: FAIL with "ENOENT ... workflows/parallel-sdd.js"

- [ ] **Step 4: Implement `workflows/parallel-sdd.js`**

```js
export const meta = {
  name: 'parallel-sdd',
  description: 'Run an approved Superpowers plan in parallel lane worktrees with a serialized merge queue',
  whenToUse: 'Launched by the superpowers-parallel:parallel-plan-execution skill with an approved plan graph',
  phases: [
    { title: 'Setup', detail: 'create lane worktrees and install dependencies' },
    { title: 'Merge queue', detail: 'serialized merges, full-suite tests, integration checkpoints' },
    { title: 'Planner', detail: 'signals, rulings and new tasks' },
    { title: 'Final', detail: 'whole-branch review and lane cleanup' },
  ],
}

// ---------- inputs ----------
const A = args
const AG = Object.assign({
  fast: 'sp-implementer-fast',
  standard: 'sp-implementer',
  reviewer: 'sp-reviewer',
  escalation: 'sp-final-reviewer',
  planner: 'superpowers-parallel:sp-planner',
}, A.agents || {})
const S = `${A.pluginDir}/scripts`
const SDD = `${A.spSkills}/subagent-driven-development`
const WS = A.workspace
const BATCH = A.batch || 3
const CHECKPOINT_EVERY = A.checkpointEvery || 3
const CWD_RULE = 'Your Bash working directory resets between commands: always use absolute paths, `git -C <dir>` or `(cd <dir> && ...)`.'

// ---------- schemas ----------
const SIGNALS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['question', 'gap', 'interface_change', 'new_task'] },
      affects: { type: 'array', items: { type: 'string' } },
      detail: { type: 'string' },
    },
    required: ['type', 'affects', 'detail'],
  },
}
const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'] },
    branch: { type: 'string' },
    commit: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' } },
    tests_passed: { type: 'boolean' },
    summary: { type: 'string' },
    rulings: { type: 'array', items: { type: 'string' } },
    signals: SIGNALS,
  },
  required: ['status', 'branch', 'commit', 'files_touched', 'tests_passed', 'summary', 'rulings', 'signals'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] },
          detail: { type: 'string' },
          file: { type: 'string' },
        },
        required: ['severity', 'detail'],
      },
    },
    declined: { type: 'array', items: { type: 'string' } },
    signals: SIGNALS,
  },
  required: ['verdict', 'findings', 'declined', 'signals'],
}
const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'object', properties: { task: { type: 'string' }, sha: { type: 'string' } }, required: ['task', 'sha'] } },
    conflicts: { type: 'array', items: { type: 'string' } },
    culprits: { type: 'array', items: { type: 'string' } },
    tests_passed: { type: 'boolean' },
    test_log: { type: 'string' },
  },
  required: ['merged', 'conflicts', 'culprits', 'tests_passed', 'test_log'],
}
const SETUP_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, lanes: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
  required: ['ok', 'lanes', 'error'],
}

// ---------- state ----------
const tasks = new Map()     // id -> task
const order = []            // plan order, then added tasks
const state = {}            // id -> pending | running | merged | blocked | skipped
const reasons = {}
const rounds = {}
const laneOf = {}
const mergeSha = {}
const mergedSignal = {}     // id -> deferred resolving true when merged, false otherwise
const mergedOrder = []
const rulings = []
const backlog = []
const events = []
const runs = []
let plannerChain = Promise.resolve()

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function addTask(t) {
  tasks.set(t.id, { ...t, deps: [...t.deps] })
  order.push(t.id)
  state[t.id] = 'pending'
  mergedSignal[t.id] = deferred()
}

const phaseOf = t => `${t.id} — ${t.title}`
const branchOf = t => `${A.planBranch}--${t.id}`
const briefOf = t => t.brief || `${WS}/task-${t.id.slice(1)}-brief.md`
const implType = t => (t.tier === 'fast' ? AG.fast : AG.standard)
const laneName = lane => lane.split('/').pop().replace(`${A.slug}-`, '')

// ---------- lanes ----------
const freeLanes = []
const laneWaiters = []
function acquireLane() {
  if (freeLanes.length) return Promise.resolve(freeLanes.shift())
  const d = deferred()
  laneWaiters.push(d)
  return d.promise
}
function releaseLane(lane) {
  const waiter = laneWaiters.shift()
  if (waiter) waiter.resolve(lane)
  else freeLanes.push(lane)
}

// ---------- prompts ----------
function setupPrompt() {
  const setup = A.graph.setup_command
  return [
    `Prepare the lane worktrees for a parallel plan run. ${CWD_RULE}`,
    `1. Run: ${S}/lanes create ${A.repo} ${A.slug} ${A.lanes || 3} ${A.planBranch}`,
    setup
      ? `2. Run the project setup command \`${setup}\` once in ${A.repo} and once in each lane printed by step 1, as \`(cd <dir> && ${setup})\`.`
      : '2. There is no setup command; skip dependency installation.',
    'Return ok=true with the lane paths in printed order, or ok=false with the failing command and its last output lines in error.',
  ].join('\n')
}

function implementPrompt(t, lane) {
  return [
    `You implement task ${t.id} ("${t.title}") of the plan ${A.plan} (spec: ${A.spec}). ${CWD_RULE}`,
    `Lane (your git worktree): ${lane}. Task branch: ${branchOf(t)}. Workspace: ${WS}.`,
    `1. Run: ${S}/lanes checkout ${lane} ${branchOf(t)} ${A.planBranch}`,
    `2. Read your brief ${briefOf(t)} and ${WS}/decisions.md if it exists (rulings made during this run; they override the brief).`,
    `3. Work as ${SDD}/implementer-prompt.md describes (TDD, self-review, report), editing files only inside ${lane}. Write your report to ${WS}/${t.id}-report.md.`,
    `4. You own ONLY these files: ${t.files.join(', ')}. If you must change another file, return status BLOCKED with the reason, or emit a signal when another task should change it.`,
    `5. If ${branchOf(t)} already has commits for this task (a resumed run), verify them and continue instead of redoing the work.`,
    `6. Run the task's tests inside the lane. Commit with messages prefixed "${t.id}: ".`,
    'Return: status, branch, commit (task branch HEAD sha), files_touched, tests_passed, summary,',
    'rulings (decisions you made that the plan did not dictate), and signals: questions, gaps, interface changes or new tasks that affect OTHER tasks, as {type, affects (task ids), detail}.',
  ].join('\n')
}

function reviewPrompt(t, lens, tag, scoped) {
  const out = `${WS}/${t.id}-${tag}${lens === 'integration' ? '-int' : ''}.diff`
  return [
    `You review task ${t.id} ("${t.title}") of the plan ${A.plan} (spec: ${A.spec}). Read-only: do not edit files or commit. ${CWD_RULE}`,
    `1. Run: base=$(git -C ${A.repo} merge-base ${A.planBranch} ${branchOf(t)}); then ${SDD}/scripts/review-package ${A.plan} "$base" ${branchOf(t)} ${out} from ${A.repo}.`,
    `2. Read the brief ${briefOf(t)}, ${WS}/decisions.md if it exists, and the package ${out}.`,
    scoped
      ? `3. This is a scoped re-review of fixes: follow ${SDD}/re-review-prompt.md and judge only whether the previous findings are resolved without regressions.`
      : `3. Follow ${SDD}/task-reviewer-prompt.md.`,
    `4. Scope check: the task owns only ${t.files.join(', ')}; a change to any other file is an Important finding.`,
    lens === 'integration'
      ? '5. Integration lens: focus on contracts with other modules, shared interfaces, concurrency and persistence effects.'
      : '5. Judge behavior the spec does not mention by what a reasonable user would expect.',
    'Return verdict (approved only if no Critical or Important findings remain), findings, declined (what you declined to judge), and signals affecting OTHER tasks.',
  ].join('\n')
}

function mergePrompt(batch) {
  const specs = batch.map(t => `${t.id}=${branchOf(t)}`).join(' ')
  return [
    `Run exactly this command and return its JSON output as your structured result. Do not fix, retry or edit anything. ${CWD_RULE}`,
    `${S}/merge-queue batch ${A.repo} ${A.planBranch} ${WS}/progress.md '${A.graph.test_command.replace(/'/g, "'\\''")}' ${specs}`,
    'If the command exits non-zero, return merged=[], conflicts=[], culprits=[], tests_passed=false and put the error text in test_log.',
  ].join('\n')
}

function finalPrompt() {
  return [
    `You perform the final whole-branch review of the plan ${A.plan} (spec: ${A.spec}). Read-only. ${CWD_RULE}`,
    `1. Run: base=$(git -C ${A.repo} merge-base ${A.baseBranch} ${A.planBranch}); then ${SDD}/scripts/review-package ${A.plan} "$base" ${A.planBranch} ${WS}/final-review.diff from ${A.repo}.`,
    `2. Read the plan, the spec, ${WS}/decisions.md if it exists, and the package; follow ${A.spSkills}/requesting-code-review/code-reviewer.md.`,
    'Return verdict, findings, declined and signals.',
  ].join('\n')
}

function cleanupPrompt(keep) {
  return [
    `Remove the lane worktrees of this run. ${CWD_RULE}`,
    `Run: ${S}/lanes remove ${A.repo} ${A.slug}${keep.length ? ' ' + keep.join(' ') : ''}`,
    'Reply with the command output.',
  ].join('\n')
}

// ---------- task pipeline ----------
function collect(by, result) {
  for (const text of result.rulings || []) rulings.push({ by, text })
}

async function reviewTask(t, tag) {
  const review = await agent(reviewPrompt(t, 'spec', tag, false), {
    label: `${t.id}·${tag}`, phase: phaseOf(t), agentType: AG.reviewer, schema: REVIEW_SCHEMA,
  })
  if (review) collect(`${t.id}·${tag}`, review)
  return review
}

async function implementAndReview(t, lane) {
  const impl = await agent(implementPrompt(t, lane), {
    label: `${t.id}·impl`, phase: phaseOf(t), agentType: implType(t), schema: IMPL_SCHEMA,
  })
  if (!impl) return { ok: false, reason: 'implementer returned no result' }
  collect(`${t.id}·impl`, impl)
  if (impl.status === 'BLOCKED') return { ok: false, reason: `implementer BLOCKED: ${impl.summary}` }
  const review = await reviewTask(t, 'review')
  if (!review) return { ok: false, reason: 'reviewer returned no result' }
  if (review.verdict !== 'approved') return { ok: false, reason: 'review requested changes' }
  return { ok: true }
}

async function mergeTask(t) {
  return enqueueMerge(t, false)
}

async function depsMerged(t) {
  for (;;) {
    const waiting = t.deps.filter(d => state[d] !== 'merged')
    if (!waiting.length) return true
    const ok = await Promise.all(waiting.map(d => mergedSignal[d].promise))
    if (!ok.every(Boolean)) return false
  }
}

function finish(id, st, reason) {
  if (['merged', 'blocked', 'skipped'].includes(state[id])) return state[id]
  state[id] = st
  if (reason) reasons[id] = reason
  if (st !== 'merged') log(`[${id}] ${st}: ${reason}`)
  mergedSignal[id].resolve(st === 'merged')
  if (st === 'merged') onMerged(id)
  return st
}

function onMerged(id) {
  mergedOrder.push(id)
}

async function runTask(id) {
  const t = tasks.get(id)
  if (!(await depsMerged(t))) {
    return finish(id, 'skipped', `dependency not merged: ${t.deps.filter(d => state[d] !== 'merged').join(', ')}`)
  }
  if (state[id] !== 'pending') return state[id]
  const lane = await acquireLane()
  if (state[id] !== 'pending') { releaseLane(lane); return state[id] }
  state[id] = 'running'
  laneOf[id] = lane
  log(`[orchestrator] ${laneName(lane)} ⇐ ${id}`)
  try {
    const done = await implementAndReview(t, lane)
    if (!done.ok) return finish(id, 'blocked', done.reason)
    if (t.blockReason) return finish(id, 'blocked', t.blockReason)
    const merged = await mergeTask(t, lane)
    return merged.ok ? finish(id, 'merged') : finish(id, 'blocked', merged.reason)
  } finally {
    releaseLane(lane)
  }
}

// ---------- merge queue (single serialized consumer) ----------
const mergeQueue = []
let mergeBusy = false
let batchNo = 0

function enqueueMerge(t, isRetry) {
  const d = deferred()
  mergeQueue.push({ t, d, isRetry })
  pump()
  return d.promise
}

async function pump() {
  if (mergeBusy || !mergeQueue.length) return
  mergeBusy = true
  const batch = mergeQueue.splice(0, BATCH)
  const n = ++batchNo
  const res = await agent(mergePrompt(batch.map(b => b.t)), {
    label: `merge·b${n}`, phase: 'Merge queue', agentType: AG.fast, schema: MERGE_SCHEMA,
  })
  events.push({ batch: n, tasks: batch.map(b => b.t.id), result: res })
  for (const { t, d, isRetry } of batch) {
    const merged = res && res.merged.find(m => m.task === t.id)
    if (merged) {
      mergeSha[t.id] = merged.sha
      d.resolve({ ok: true })
    } else if (res && res.conflicts.includes(t.id)) {
      d.resolve({
        ok: false, retry: !isRetry, reason: 'merge conflict',
        findings: [{ severity: 'Important', detail: `Merge conflict with ${A.planBranch}: run \`git -C <lane> merge ${A.planBranch}\`, resolve the conflicts, re-run the task tests and commit.` }],
      })
    } else if (res && res.culprits.includes(t.id)) {
      d.resolve({
        ok: false, retry: !isRetry, reason: 'full test suite red after merge',
        findings: [{ severity: 'Critical', detail: `The full suite (\`${A.graph.test_command}\`) fails once this task is merged into ${A.planBranch}; see ${res.test_log}. Merge ${A.planBranch} into your branch, fix, and run the full suite in the lane.` }],
      })
    } else {
      d.resolve({ ok: false, retry: false, reason: res ? 'merge queue did not merge the task' : 'merge agent returned no result' })
    }
  }
  mergeBusy = false
  pump()
}

// ---------- run ----------
async function drain() {
  for (;;) {
    const n = runs.length
    await Promise.all(runs)
    await plannerChain
    if (runs.length === n) return
  }
}

function report(extra) {
  return Object.assign({
    tasks: order.map(id => ({
      id, title: tasks.get(id).title, state: state[id], reason: reasons[id] || null, rounds: rounds[id] || 0, lane: laneOf[id] || null,
    })),
    rulings, backlog, events,
  }, extra)
}

for (const t of A.graph.tasks) addTask(t)

phase('Setup')
const setup = await agent(setupPrompt(), { label: 'setup', phase: 'Setup', agentType: AG.fast, schema: SETUP_SCHEMA })
if (!setup || !setup.ok) return report({ aborted: true, reason: setup ? setup.error : 'setup agent returned no result' })
for (const lane of setup.lanes) freeLanes.push(lane)

for (const id of [...order]) runs.push(runTask(id))
await drain()

phase('Final')
const anyMerged = order.some(id => state[id] === 'merged')
const finalReview = anyMerged
  ? await agent(finalPrompt(), { label: 'final-review', phase: 'Final', agentType: AG.escalation, schema: REVIEW_SCHEMA })
  : null
const keep = [...new Set(order.filter(id => state[id] === 'blocked' && laneOf[id]).map(id => laneOf[id]))]
await agent(cleanupPrompt(keep), { label: 'cleanup', phase: 'Final', agentType: AG.fast })
return report({ aborted: false, final_review: finalReview, lanes_kept: keep })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/workflow-core.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add workflows/parallel-sdd.js test/harness.mjs test/fakes.mjs test/workflow-core.test.mjs
git commit -m "feat: add parallel-sdd workflow core with lane scheduler and merge queue"
```

---

### Task 5: Fix loop, risk-based review, merge retries, blocked propagation

**Files:**
- Modify: `workflows/parallel-sdd.js` (replace `reviewTask`, `implementAndReview`, `mergeTask`; add `fixPrompt`, `fixRound`)
- Test: `test/workflow-loop.test.mjs`

**Interfaces:**
- Consumes: Task 4 script internals and test harness/fakes.
- Produces: labels `<id>·fix-r<k>`, `<id>·re-review-r<k>`, `<id>·review-int`, `<id>·fix-merge`, `<id>·re-review-merge`; report `rounds` per task; `reviewTask(t, tag, scoped)` signature (3 args).

- [ ] **Step 1: Write the failing tests**

`test/workflow-loop.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, baseArgs, task, labels } from './harness.mjs'
import { fakeAgent, DONE, CHANGES, mergeAll } from './fakes.mjs'

const stateOf = (result, id) => result.tasks.find(t => t.id === id)

test('a blocked task skips its descendants but not independent tasks', async () => {
  const agent = fakeAgent(label => (label === 'T1·impl' ? { ...DONE, status: 'BLOCKED', summary: 'x' } : undefined))
  const tasks = [task('T1'), task('T2', { deps: ['T1'] }), task('T3', { deps: ['T2'] }), task('T4')]
  const { result } = await runWorkflow({ agent, args: baseArgs(tasks) })
  assert.deepEqual(result.tasks.map(t => t.state), ['blocked', 'skipped', 'skipped', 'merged'])
  assert.equal(stateOf(result, 'T2').reason, 'dependency not merged: T1')
})

test('fix rounds continue until the reviewer approves', async () => {
  let reviews = 0
  const agent = fakeAgent(label => (/^T1·(review|re-review-r\d)$/.test(label) && ++reviews <= 2 ? CHANGES : undefined))
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.deepEqual(labels(calls).filter(l => l.startsWith('T1·')),
    ['T1·impl', 'T1·review', 'T1·fix-r1', 'T1·re-review-r1', 'T1·fix-r2', 'T1·re-review-r2'])
  assert.equal(stateOf(result, 'T1').state, 'merged')
  assert.equal(stateOf(result, 'T1').rounds, 2)
})

test('rounds 4-5 escalate and a sixth round is never started', async () => {
  const agent = fakeAgent(label => (/^T1·(review|re-review-r\d)$/.test(label) ? CHANGES : undefined))
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  const fixes = calls.filter(c => c.label.startsWith('T1·fix-'))
  assert.deepEqual(fixes.map(c => c.agentType),
    ['sp-implementer', 'sp-implementer', 'sp-implementer', 'sp-final-reviewer', 'sp-final-reviewer'])
  assert.equal(stateOf(result, 'T1').state, 'blocked')
  assert.equal(stateOf(result, 'T1').reason, 'fix loop exhausted after 5 rounds')
})

test('high-risk tasks get an extra integration reviewer on the first review only', async () => {
  let reviews = 0
  const agent = fakeAgent(label => (label === 'T1·review' && ++reviews === 1 ? CHANGES : undefined))
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1', { risk: 'high' })]) })
  const l = labels(calls)
  assert.ok(l.includes('T1·review') && l.includes('T1·review-int'))
  assert.equal(l.filter(x => x === 'T1·review-int').length, 1)
  assert.ok(l.includes('T1·re-review-r1'))
})

test('a merge conflict gets one fix round and a retry', async () => {
  let merges = 0
  const agent = fakeAgent((label, prompt) => {
    if (!label.startsWith('merge·')) return undefined
    return ++merges === 1 ? { merged: [], conflicts: ['T1'], culprits: [], tests_passed: true, test_log: '/l' } : mergeAll(prompt)
  })
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.ok(labels(calls).includes('T1·fix-merge'))
  assert.ok(labels(calls).includes('T1·re-review-merge'))
  assert.equal(stateOf(result, 'T1').state, 'merged')
})

test('a second merge failure blocks the task', async () => {
  const agent = fakeAgent(label => (label.startsWith('merge·') ? { merged: [], conflicts: [], culprits: ['T1'], tests_passed: true, test_log: '/l' } : undefined))
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.equal(labels(calls).filter(l => l === 'T1·fix-merge').length, 1)
  assert.equal(stateOf(result, 'T1').state, 'blocked')
  assert.equal(stateOf(result, 'T1').reason, 'full test suite red after merge')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/workflow-loop.test.mjs`
Expected: FAIL (fix-round labels missing; high-risk and merge-retry assertions fail)

- [ ] **Step 3: Add `fixPrompt` after `reviewPrompt`**

```js
function fixPrompt(t, lane, findings, tag) {
  return [
    `You fix task ${t.id} ("${t.title}") of the plan ${A.plan} (spec: ${A.spec}), fix round ${tag}. ${CWD_RULE}`,
    `Lane: ${lane}. Task branch: ${branchOf(t)}. Workspace: ${WS}.`,
    `1. Run: ${S}/lanes checkout ${lane} ${branchOf(t)} ${A.planBranch}`,
    `2. Read the brief ${briefOf(t)}, the previous report ${WS}/${t.id}-report.md, and ${WS}/decisions.md if it exists.`,
    '3. Resolve every finding below, with a test for each behavior change:',
    ...findings.map((f, i) => `   ${i + 1}. [${f.severity}] ${f.detail}${f.file ? ` (${f.file})` : ''}`),
    `4. You own ONLY these files: ${t.files.join(', ')}. Run the task's tests in the lane, commit with the "${t.id}: " prefix, and append what you changed to ${WS}/${t.id}-report.md.`,
    'Return the same fields as the implementer: status, branch, commit, files_touched, tests_passed, summary, rulings, signals.',
  ].join('\n')
}
```

- [ ] **Step 4: Replace `reviewTask`, `implementAndReview` and `mergeTask`; add `fixRound`**

```js
async function reviewTask(t, tag, scoped) {
  const lenses = !scoped && t.risk === 'high' ? ['spec', 'integration'] : ['spec']
  const labelOf = lens => `${t.id}·${lens === 'integration' ? 'review-int' : tag}`
  const results = await parallel(lenses.map(lens => () => agent(reviewPrompt(t, lens, tag, scoped), {
    label: labelOf(lens), phase: phaseOf(t), agentType: AG.reviewer, schema: REVIEW_SCHEMA,
  })))
  if (results.some(r => !r)) return null
  results.forEach((r, i) => collect(labelOf(lenses[i]), r))
  return {
    verdict: results.every(r => r.verdict === 'approved') ? 'approved' : 'changes_requested',
    findings: results.flatMap(r => r.findings),
  }
}

async function fixRound(t, lane, findings, tag, round) {
  rounds[t.id] = (rounds[t.id] || 0) + 1
  const fix = await agent(fixPrompt(t, lane, findings, tag), {
    label: `${t.id}·fix-${tag}`, phase: phaseOf(t), agentType: round >= 4 ? AG.escalation : implType(t), schema: IMPL_SCHEMA,
  })
  if (!fix) return { ok: false, reason: `fixer ${tag} returned no result` }
  collect(`${t.id}·fix-${tag}`, fix)
  if (fix.status === 'BLOCKED') return { ok: false, reason: `fixer ${tag} BLOCKED: ${fix.summary}` }
  return { ok: true }
}

async function implementAndReview(t, lane) {
  const impl = await agent(implementPrompt(t, lane), {
    label: `${t.id}·impl`, phase: phaseOf(t), agentType: implType(t), schema: IMPL_SCHEMA,
  })
  if (!impl) return { ok: false, reason: 'implementer returned no result' }
  collect(`${t.id}·impl`, impl)
  if (impl.status === 'BLOCKED') return { ok: false, reason: `implementer BLOCKED: ${impl.summary}` }
  let review = await reviewTask(t, 'review', false)
  for (let round = 1; review && review.verdict !== 'approved'; round++) {
    if (round > 5) return { ok: false, reason: 'fix loop exhausted after 5 rounds' }
    const fix = await fixRound(t, lane, review.findings, `r${round}`, round)
    if (!fix.ok) return fix
    review = await reviewTask(t, `re-review-r${round}`, true)
  }
  if (!review) return { ok: false, reason: 'reviewer returned no result' }
  return { ok: true }
}

async function mergeTask(t, lane) {
  const first = await enqueueMerge(t, false)
  if (first.ok || !first.retry) return first
  const fix = await fixRound(t, lane, first.findings, 'merge', 1)
  if (!fix.ok) return fix
  const review = await reviewTask(t, 're-review-merge', true)
  if (!review || review.verdict !== 'approved') return { ok: false, reason: `${first.reason}; the fix was not approved` }
  const second = await enqueueMerge(t, true)
  return second.ok ? second : { ok: false, reason: first.reason }
}
```

- [ ] **Step 5: Run all workflow tests**

Run: `node --test "test/workflow-*.test.mjs"`
Expected: PASS (12 tests)

- [ ] **Step 6: Commit**

```bash
git add workflows/parallel-sdd.js test/workflow-loop.test.mjs
git commit -m "feat: add fix loop, risk-based review and merge retries to workflow"
```

---

### Task 6: Signals, planner, new tasks and integration checkpoints

**Files:**
- Modify: `workflows/parallel-sdd.js` (replace `collect`, `onMerged`, `runTask`; add planner schema, prompts and functions)
- Test: `test/workflow-coordination.test.mjs`

**Interfaces:**
- Consumes: Task 5 script (`fixRound`, `reviewTask(t, tag, scoped)`).
- Produces: labels `planner·S<n>`, `checkpoint·<n>`, `<id>·fix-ruling`, `<id>·re-review-ruling`; new task ids `N<k>` with briefs at `<workspace>/N<k>-brief.md` written by the planner; `backlog` entries `{ from, title, reason }`.
- Planner structured result: `{ action: "ruling"|"block"|"add_task"|"adapt"|"backlog", ruling, affects[], reason, rework: bool, new_task: null | { title, files[], deps[], risk, tier, brief_path } }`.

- [ ] **Step 1: Write the failing tests**

`test/workflow-coordination.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, baseArgs, task, labels } from './harness.mjs'
import { fakeAgent, DONE, sleep } from './fakes.mjs'

const signal = (type, affects, detail = 'd') => ({ ...DONE, signals: [{ type, affects, detail }] })
const newTask = (title, over = {}) => ({ title, files: [`src/${title}.js`], deps: [], risk: 'low', tier: 'fast', brief_path: `/ws/${title}.md`, ...over })
const planner = (action, over = {}) => ({ action, ruling: '', affects: [], reason: 'r', rework: false, new_task: null, ...over })
const find = (result, id) => result.tasks.find(t => t.id === id)

test('rulings are collected and attributed', async () => {
  const agent = fakeAgent(label => (label === 'T1·impl' ? { ...DONE, rulings: ['used UTC'] } : undefined))
  const { result } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.deepEqual(result.rulings, [{ by: 'T1·impl', text: 'used UTC' }])
})

test('a new_task signal adds and runs a task', async () => {
  const agent = fakeAgent(label => {
    if (label === 'T1·impl') return signal('new_task', [], 'need a helper')
    if (label === 'planner·S1') return planner('add_task', { new_task: newTask('helper') })
  })
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.equal(calls.find(c => c.label === 'planner·S1').agentType, 'superpowers-parallel:sp-planner')
  assert.equal(find(result, 'N1').state, 'merged')
  assert.match(calls.find(c => c.label === 'N1·impl').prompt, /\/ws\/helper\.md/)
})

test('a new task that overlaps an active task depends on it', async () => {
  const agent = fakeAgent(label => {
    if (label === 'T1·impl') return signal('new_task', [])
    if (label === 'planner·S1') return planner('add_task', { new_task: newTask('x', { files: ['src/T2.js'] }) })
  })
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2', { deps: ['T1'] })]) })
  const mergeT2 = calls.findIndex(c => c.label.startsWith('merge·') && c.prompt.includes('T2='))
  const implN1 = calls.findIndex(c => c.label === 'N1·impl')
  assert.ok(mergeT2 >= 0 && implN1 > mergeT2)
})

test('the new-task cap sends extra tasks to the backlog', async () => {
  let k = 0
  const agent = fakeAgent(label => {
    if (label === 'T1·impl') return { ...DONE, signals: [1, 2, 3].map(() => ({ type: 'new_task', affects: [], detail: 'd' })) }
    if (label.startsWith('planner·')) return planner('add_task', { new_task: newTask(`extra${++k}`) })
  })
  const tasks = [task('T1'), task('T2'), task('T3'), task('T4')]
  const { result } = await runWorkflow({ agent, args: baseArgs(tasks) })
  assert.ok(find(result, 'N1') && find(result, 'N2'))
  assert.equal(find(result, 'N3'), undefined)
  assert.deepEqual(result.backlog.map(b => b.reason), ['new-task cap reached'])
})

test('a planner block stops a pending task and skips its descendants', async () => {
  const agent = fakeAgent(label => {
    if (label === 'T1·impl') return signal('question', ['T2'], 'which API?')
    if (label === 'planner·S1') return planner('block', { affects: ['T2'], reason: 'needs the user' })
  })
  const tasks = [task('T1'), task('T2', { deps: ['T1'] }), task('T3', { deps: ['T2'] })]
  const { result } = await runWorkflow({ agent, args: baseArgs(tasks) })
  assert.equal(find(result, 'T2').state, 'blocked')
  assert.match(find(result, 'T2').reason, /needs user decision \(planner·S1\): needs the user/)
  assert.equal(find(result, 'T3').state, 'skipped')
})

test('a rework ruling adds a fix round to a running task', async () => {
  const agent = fakeAgent(async label => {
    if (label === 'T1·impl') return signal('interface_change', ['T2'], 'renamed parse()')
    if (label === 'T2·impl') { await sleep(30); return undefined }
    if (label === 'planner·S1') return planner('ruling', { ruling: 'use parseAll()', affects: ['T2'], rework: true })
  })
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2')]) })
  assert.ok(labels(calls).includes('T2·fix-ruling'))
  assert.ok(result.rulings.some(r => r.by === 'planner·S1' && r.text === 'use parseAll()'))
})

test('an integration checkpoint runs every 3 merges and feeds the planner', async () => {
  const agent = fakeAgent(label => {
    if (label === 'checkpoint·1') return { verdict: 'changes_requested', findings: [{ severity: 'Important', detail: 'duplicated helper' }], declined: [], signals: [] }
  })
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2'), task('T3')]) })
  const l = labels(calls)
  assert.ok(l.includes('checkpoint·1'))
  assert.match(calls.find(c => c.label === 'planner·S1').prompt, /duplicated helper/)
  assert.ok(l.indexOf('checkpoint·1') < l.indexOf('final-review'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/workflow-coordination.test.mjs`
Expected: FAIL (no `planner·S1` / `checkpoint·1` calls; `N1` missing)

- [ ] **Step 3: Add the planner schema after `SETUP_SCHEMA`**

```js
const NEW_TASK = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    deps: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['low', 'high'] },
    tier: { type: 'string', enum: ['fast', 'standard'] },
    brief_path: { type: 'string' },
  },
  required: ['title', 'files', 'deps', 'risk', 'tier', 'brief_path'],
}
const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ruling', 'block', 'add_task', 'adapt', 'backlog'] },
    ruling: { type: 'string' },
    affects: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    rework: { type: 'boolean' },
    new_task: { anyOf: [NEW_TASK, { type: 'null' }] },
  },
  required: ['action', 'ruling', 'affects', 'reason', 'rework', 'new_task'],
}
```

And add to the state block:
```js
let signalNo = 0
let newTaskCount = 0
const newTaskCap = Math.min(3, Math.ceil(0.3 * A.graph.tasks.length))
```

- [ ] **Step 4: Add the planner and checkpoint prompts after `cleanupPrompt`**

```js
function graphSummary() {
  return order.map(id => {
    const t = tasks.get(id)
    return `- ${id} [${state[id]}] "${t.title}" deps=[${t.deps.join(', ')}] files=[${t.files.join(', ')}]`
  }).join('\n')
}

function plannerPrompt(s, from, n) {
  const nextId = `N${newTaskCount + 1}`
  return [
    `You are the planner of a parallel plan run (signal S${n}). Plan: ${A.plan}. Spec: ${A.spec}. Workspace: ${WS}. ${CWD_RULE}`,
    `Signal from ${from}: type=${s.type}, affects=[${s.affects.join(', ')}]`,
    `Detail: ${s.detail}`,
    'Current task graph:',
    graphSummary(),
    `Read ${WS}/decisions.md if it exists. Decide ONE action:`,
    '- ruling: answerable from the plan/spec. Set rework=true only if the ruling invalidates work already committed by a RUNNING task listed in affects.',
    '- block: needs the user (spec or scope change); affects = the pending/running tasks to stop.',
    `- add_task: a task required for the plan to work. Write its brief to ${WS}/${nextId}-brief.md in the plan's task format (files, interfaces, TDD steps) and set new_task.brief_path to it.`,
    `- adapt: an accepted interface change that already-merged tasks must follow; same as add_task (brief at ${WS}/${nextId}-brief.md).`,
    '- backlog: an improvement or out-of-scope work; fill new_task with a title and a one-line brief_path note, do not write a brief.',
    `Append your decision to ${WS}/decisions.md as a section "## S${n} (${from})" with the ruling and its reason. Never edit other files.`,
  ].join('\n')
}

function checkpointPrompt(ids, n) {
  const head = mergeSha[ids[ids.length - 1]]
  return [
    `You run integration checkpoint ${n} of a parallel plan run. Read-only. Plan: ${A.plan}. Spec: ${A.spec}. ${CWD_RULE}`,
    `1. Run from ${A.repo}: ${SDD}/scripts/review-package ${A.plan} ${mergeSha[ids[0]]}^1 ${head} ${WS}/checkpoint-${n}.diff`,
    `2. The range holds the merges of ${ids.join(', ')}. Read it with ${WS}/decisions.md if it exists.`,
    '3. Judge cross-task coherence only: duplicated helpers, inconsistent contracts between modules, drifting conventions. Per-task correctness was already reviewed.',
    'Return verdict, findings, declined and signals.',
  ].join('\n')
}
```

- [ ] **Step 5: Replace `collect` and `onMerged`; add planner functions**

```js
function collect(by, result) {
  for (const text of result.rulings || []) rulings.push({ by, text })
  for (const s of result.signals || []) runs.push(planSignal(s, by))
}

function onMerged(id) {
  mergedOrder.push(id)
  if (mergedOrder.length % CHECKPOINT_EVERY === 0) {
    runs.push(checkpoint(mergedOrder.slice(-CHECKPOINT_EVERY), mergedOrder.length / CHECKPOINT_EVERY))
  }
}

async function checkpoint(ids, n) {
  const r = await agent(checkpointPrompt(ids, n), {
    label: `checkpoint·${n}`, phase: 'Merge queue', agentType: AG.reviewer, schema: REVIEW_SCHEMA,
  })
  if (!r) { events.push({ checkpoint: n, note: 'checkpoint reviewer returned no result' }); return }
  events.push({ checkpoint: n, tasks: ids, verdict: r.verdict, findings: r.findings.length })
  collect(`checkpoint·${n}`, r)
  for (const f of r.findings.filter(f => f.severity !== 'Minor')) {
    runs.push(planSignal({ type: 'gap', affects: ids, detail: `${f.severity}: ${f.detail}${f.file ? ` (${f.file})` : ''}` }, `checkpoint·${n}`))
  }
}

function planSignal(s, from) {
  const n = ++signalNo
  const p = plannerChain.then(() => handleSignal(s, from, n))
  plannerChain = p.catch(() => {})
  return p
}

async function handleSignal(s, from, n) {
  const by = `planner·S${n}`
  const d = await agent(plannerPrompt(s, from, n), { label: by, phase: 'Planner', agentType: AG.planner, schema: PLANNER_SCHEMA })
  if (!d) { events.push({ signal: n, from, note: 'planner returned no result' }); return }
  events.push({ signal: n, from, action: d.action, reason: d.reason })
  if (d.ruling) rulings.push({ by, text: d.ruling })
  if (d.action === 'ruling' && d.rework) {
    for (const id of d.affects) if (state[id] === 'running') tasks.get(id).rework = d.ruling
  }
  if (d.action === 'block') for (const id of d.affects) blockTask(id, `needs user decision (${by}): ${d.reason}`)
  if ((d.action === 'add_task' || d.action === 'adapt') && d.new_task) addNewTask(d.new_task, by)
  if (d.action === 'backlog' && d.new_task) backlog.push({ from: by, title: d.new_task.title, reason: d.reason })
}

function blockTask(id, reason) {
  if (!tasks.has(id)) return
  if (state[id] === 'pending') finish(id, 'blocked', reason)
  else if (state[id] === 'running') tasks.get(id).blockReason = reason
  else events.push({ task: id, note: `block requested but the task is ${state[id]}: ${reason}` })
}

function addNewTask(nt, by) {
  if (newTaskCount >= newTaskCap) {
    backlog.push({ from: by, title: nt.title, reason: 'new-task cap reached' })
    log(`[orchestrator] new-task cap (${newTaskCap}) reached; "${nt.title}" → backlog`)
    return
  }
  const id = `N${++newTaskCount}`
  const deps = nt.deps.filter(d => tasks.has(d))
  for (const other of order) {
    const active = state[other] === 'pending' || state[other] === 'running'
    if (active && !deps.includes(other) && tasks.get(other).files.some(f => nt.files.includes(f))) deps.push(other)
  }
  addTask({ id, title: nt.title, deps, files: nt.files, risk: nt.risk, tier: nt.tier, rationale: `added by ${by}`, brief: nt.brief_path })
  log(`[orchestrator] ${by} added ${id} "${nt.title}" deps=[${deps.join(', ')}]`)
  runs.push(runTask(id))
}
```

- [ ] **Step 6: Replace `runTask` to apply rework rulings before merging**

```js
async function runTask(id) {
  const t = tasks.get(id)
  if (!(await depsMerged(t))) {
    return finish(id, 'skipped', `dependency not merged: ${t.deps.filter(d => state[d] !== 'merged').join(', ')}`)
  }
  if (state[id] !== 'pending') return state[id]
  const lane = await acquireLane()
  if (state[id] !== 'pending') { releaseLane(lane); return state[id] }
  state[id] = 'running'
  laneOf[id] = lane
  log(`[orchestrator] ${laneName(lane)} ⇐ ${id}`)
  try {
    const done = await implementAndReview(t, lane)
    if (!done.ok) return finish(id, 'blocked', done.reason)
    if (t.rework) {
      const ruling = t.rework
      t.rework = null
      const fix = await fixRound(t, lane, [{ severity: 'Important', detail: `Apply the planner ruling: ${ruling}` }], 'ruling', 1)
      if (!fix.ok) return finish(id, 'blocked', fix.reason)
      const review = await reviewTask(t, 're-review-ruling', true)
      if (!review || review.verdict !== 'approved') return finish(id, 'blocked', 'fix for a planner ruling was not approved')
    }
    if (t.blockReason) return finish(id, 'blocked', t.blockReason)
    const merged = await mergeTask(t, lane)
    return merged.ok ? finish(id, 'merged') : finish(id, 'blocked', merged.reason)
  } finally {
    releaseLane(lane)
  }
}
```

- [ ] **Step 7: Run all workflow tests**

Run: `node --test "test/workflow-*.test.mjs"`
Expected: PASS (19 tests)

- [ ] **Step 8: Commit**

```bash
git add workflows/parallel-sdd.js test/workflow-coordination.test.mjs
git commit -m "feat: add signals, planner, new tasks and integration checkpoints"
```

---

### Task 7: Planner agent and analyzer prompt

**Files:**
- Create: `agents/sp-planner.md`
- Create: `skills/parallel-plan-execution/analyzer-prompt.md`
- Test: `test/content.test.mjs`

**Interfaces:**
- Produces: agent `superpowers-parallel:sp-planner` (opus, effort high); analyzer prompt template with placeholders `{{PLAN}}`, `{{SPEC}}`, `{{REPO}}`, `{{OUT}}` that writes `plan-graph.json` in the Task 1 graph shape.

- [ ] **Step 1: Write the failing test**

`test/content.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const frontmatter = text => Object.fromEntries(
  text.split('---')[1].trim().split('\n').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))

test('sp-planner pins model and effort', () => {
  const fm = frontmatter(read('agents/sp-planner.md'))
  assert.equal(fm.name, 'sp-planner')
  assert.equal(fm.model, 'opus')
  assert.equal(fm.effort, 'high')
  assert.ok(fm.description.length > 20)
})

test('analyzer prompt covers every graph field and placeholder', () => {
  const p = read('skills/parallel-plan-execution/analyzer-prompt.md')
  for (const key of ['test_command', 'setup_command', 'deps', 'files', 'risk', 'tier', 'rationale', 'critical_path', 'estimated_speedup', 'recommendation']) {
    assert.ok(p.includes(key), `missing ${key}`)
  }
  for (const ph of ['{{PLAN}}', '{{SPEC}}', '{{REPO}}', '{{OUT}}']) assert.ok(p.includes(ph), `missing ${ph}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/content.test.mjs`
Expected: FAIL with "ENOENT ... agents/sp-planner.md"

- [ ] **Step 3: Create `agents/sp-planner.md`**

```markdown
---
name: sp-planner
description: Planner for superpowers-parallel runs. Resolves one coordination signal (question, gap, interface change, new task) during a parallel plan execution and records the ruling.
model: opus
effort: high
---

You resolve one coordination signal raised while several agents implement tasks of the same plan in parallel. The prompt gives you the signal, the current task graph, and the plan, spec and workspace paths.

Rules:
- The plan and spec are the source of truth. Prefer the ruling that keeps already-merged work valid.
- Choose exactly one action: ruling, block, add_task, adapt or backlog, as the prompt defines them.
- Block only when the answer changes the spec or the scope: that decision belongs to the user.
- A new task must be required for the plan to work; improvements go to the backlog.
- Record every decision in the workspace's decisions.md exactly as the prompt specifies. Never edit source files or git state.
- Be specific: name files, functions and the tasks affected.
```

- [ ] **Step 4: Create `skills/parallel-plan-execution/analyzer-prompt.md`**

````markdown
You analyze an approved implementation plan to decide which tasks can run in parallel. Read-only: write only the output file.

Inputs: plan {{PLAN}}, spec {{SPEC}}, repository {{REPO}}. Output: {{OUT}}.
Your Bash working directory resets between commands: always use absolute paths, `git -C <dir>` or `(cd <dir> && ...)`.

1. Read the plan. Each `### Task N:` section is task `T<N>`; take its title from the heading and its owned files from its **Files:** block (Create, Modify and Test entries, repo-relative, without line ranges).
2. Dependencies (`deps`): add an edge from an earlier task to a later one when
   - they own a common file, or
   - the later task's text or **Interfaces → Consumes** block uses something the earlier one produces, or
   - the later task only makes sense after the earlier one (for example, it wires up a component the earlier one creates).
   When unsure, add the edge. Never add an edge from a later task to an earlier one.
3. `risk`: `high` when the task touches more than 2 files, shared interfaces, concurrency, persistence schemas, or the plan gives prose instead of complete code; otherwise `low`.
4. `tier`: `fast` only when the plan text contains the complete code for a task of 1-2 files; otherwise `standard`.
5. `test_command`: the project's full test command (from the plan's Global Constraints, Taskfile.yml, package.json, pom.xml, build.gradle, Makefile or mise.toml in {{REPO}}). `setup_command`: the dependency install command a fresh checkout needs, or "" if none.
6. `critical_path`: the longest dependency chain, as task ids. `estimated_speedup`: task count divided by the critical path length, rounded to one decimal. `recommendation`: "sequential-sdd" when estimated_speedup < 1.3, else "parallel".
7. `rationale` per task: one sentence explaining its deps and files.

Write {{OUT}} as JSON:
```json
{
  "plan": "<plan path relative to the repo>",
  "test_command": "…",
  "setup_command": "…",
  "tasks": [
    { "id": "T1", "title": "…", "deps": [], "files": ["…"], "risk": "low", "tier": "fast", "rationale": "…" }
  ],
  "critical_path": ["T1"],
  "estimated_speedup": 1.0,
  "recommendation": "parallel"
}
```
Then reply with one line: the task count, the critical path and the recommendation.
````

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/content.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add agents/sp-planner.md skills/parallel-plan-execution/analyzer-prompt.md test/content.test.mjs
git commit -m "feat: add planner agent and plan analyzer prompt"
```

---

### Task 8: Preflight checks and the orchestration skill

**Files:**
- Create: `scripts/preflight`
- Create: `skills/parallel-plan-execution/SKILL.md`
- Test: `test/preflight.bats`

**Interfaces:**
- Consumes: `test/helpers.bash` (Task 2); `scripts/validate-graph.mjs` (Task 1); `workflows/parallel-sdd.js` args/report (Task 4); analyzer prompt (Task 7).
- Produces: `preflight REPO PLAN` → on success prints `SP_SKILLS=<dir>` and `TASKS=<count>` lines (exit 0); on failure prints one `error: …` line per problem to stderr (exit 1). Env overrides for tests: `SP_ROOT` (default `~/.claude/plugins/cache/claude-plugins-official/superpowers`), `AGENTS_DIR` (default `~/.claude/agents`).

- [ ] **Step 1: Write the failing tests**

`test/preflight.bats`:
```bash
setup() {
  load helpers
  REPO=$(make_repo)
  PF="$BATS_TEST_DIRNAME/../scripts/preflight"
  export SP_ROOT=$(mktemp -d) AGENTS_DIR=$(mktemp -d)
  sdd="$SP_ROOT/6.4.1/skills/subagent-driven-development"
  mkdir -p "$sdd/scripts" "$SP_ROOT/6.4.1/skills/requesting-code-review" "$SP_ROOT/6.3.0/skills"
  for f in scripts/sdd-workspace scripts/task-brief scripts/review-package implementer-prompt.md task-reviewer-prompt.md re-review-prompt.md; do
    touch "$sdd/$f"
  done
  touch "$SP_ROOT/6.4.1/skills/requesting-code-review/code-reviewer.md"
  for a in sp-implementer-fast sp-implementer sp-reviewer sp-final-reviewer; do touch "$AGENTS_DIR/$a.md"; done
  mkdir -p "$REPO/docs"
  printf '# Plan\n\n### Task 1: A\n\n### Task 2: B\n' >"$REPO/docs/plan.md"
  git -C "$REPO" add docs && git -C "$REPO" commit -qm plan
}

teardown() { rm -rf "$REPO" "$SP_ROOT" "$AGENTS_DIR"; }

@test "passes and reports the newest superpowers version and task count" {
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "SP_SKILLS=$SP_ROOT/6.4.1/skills" ]
  [ "${lines[1]}" = "TASKS=2" ]
}

@test "refuses a dirty checkout" {
  echo change >>"$REPO/file.txt"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: uncommitted changes"* ]]
}

@test "refuses when .worktrees/ is not ignored" {
  printf '.superpowers/\n' >"$REPO/.gitignore"
  git -C "$REPO" commit -qam "unignore"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: .worktrees/ is not git-ignored; add it to .gitignore"* ]]
}

@test "refuses a plan without Task headings" {
  printf '# Plan\n\n## Step one\n' >"$REPO/docs/plan.md"
  git -C "$REPO" commit -qam "bad plan"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: no "### Task N:" headings in'* ]]
}

@test "reports missing superpowers files and agents" {
  rm "$SP_ROOT/6.4.1/skills/subagent-driven-development/scripts/task-brief" "$AGENTS_DIR/sp-reviewer.md"
  run "$PF" "$REPO" "$REPO/docs/plan.md"
  [ "$status" -eq 1 ]
  [[ "$output" == *"error: missing superpowers file"*"task-brief"* ]]
  [[ "$output" == *"error: missing agent sp-reviewer"* ]]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bats test/preflight.bats`
Expected: FAIL (5 tests, "scripts/preflight: No such file or directory")

- [ ] **Step 3: Implement `scripts/preflight`**

```bash
#!/usr/bin/env bash
# Check that a repository and plan are ready for a parallel plan run.
#
# Usage: preflight REPO PLAN
# Prints SP_SKILLS=<superpowers skills dir> and TASKS=<count> on success;
# one "error: ..." line per problem on stderr and exit 1 otherwise.
# Env: SP_ROOT (superpowers plugin cache dir), AGENTS_DIR (user agents dir).
set -euo pipefail

[ $# -eq 2 ] || { sed -n '4,8p' "$0" >&2; exit 2; }
repo=$1; plan=$2
sp_root=${SP_ROOT:-$HOME/.claude/plugins/cache/claude-plugins-official/superpowers}
agents_dir=${AGENTS_DIR:-$HOME/.claude/agents}
errors=()

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $repo is not a git repository" >&2; exit 1
fi
[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] ||
  errors+=("uncommitted changes in $repo; commit or stash them first")
git -C "$repo" check-ignore -q .worktrees/probe ||
  errors+=(".worktrees/ is not git-ignored; add it to .gitignore")

tasks=0
if [ -f "$plan" ]; then
  tasks=$(grep -cE '^### Task [0-9]+:' "$plan" || true)
  [ "$tasks" -gt 0 ] || errors+=("no \"### Task N:\" headings in $plan")
else
  errors+=("no such plan file: $plan")
fi

version=$(ls "$sp_root" 2>/dev/null | sort -V | tail -1 || true)
sp_skills="$sp_root/$version/skills"
if [ -z "$version" ]; then
  errors+=("superpowers is not installed under $sp_root")
else
  for f in subagent-driven-development/scripts/sdd-workspace subagent-driven-development/scripts/task-brief \
    subagent-driven-development/scripts/review-package subagent-driven-development/implementer-prompt.md \
    subagent-driven-development/task-reviewer-prompt.md subagent-driven-development/re-review-prompt.md \
    requesting-code-review/code-reviewer.md; do
    [ -e "$sp_skills/$f" ] || errors+=("missing superpowers file $sp_skills/$f")
  done
fi

for a in sp-implementer-fast sp-implementer sp-reviewer sp-final-reviewer; do
  [ -f "$agents_dir/$a.md" ] || errors+=("missing agent $a ($agents_dir/$a.md)")
done

if [ ${#errors[@]} -gt 0 ]; then
  printf 'error: %s\n' "${errors[@]}" >&2
  exit 1
fi
echo "SP_SKILLS=$sp_skills"
echo "TASKS=$tasks"
```
Then `chmod +x scripts/preflight`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bats test/preflight.bats`
Expected: PASS (5 tests)

- [ ] **Step 5: Create `skills/parallel-plan-execution/SKILL.md`**

````markdown
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
````

- [ ] **Step 6: Run the full suite**

Run: `task test`
Expected: PASS (all bats and node tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/preflight skills/parallel-plan-execution/SKILL.md test/preflight.bats
git commit -m "feat: add preflight checks and parallel-plan-execution skill"
```

---

### Task 9: Register, install and document the plugin

**Files:**
- Create: `README.md`
- Modify: `~/.claude/local-marketplace/.claude-plugin/marketplace.json` (outside this repo)
- Create: symlink `~/.claude/local-marketplace/plugins/superpowers-parallel` → this repo

**Interfaces:**
- Consumes: everything above.
- Produces: installed plugin `superpowers-parallel@local` exposing the skill `superpowers-parallel:parallel-plan-execution`, the agent `superpowers-parallel:sp-planner` and the workflow `parallel-sdd`.

- [ ] **Step 1: Write `README.md`**

```markdown
# superpowers-parallel

Runs an approved [Superpowers](https://github.com/obra/superpowers) implementation plan in parallel: tasks start as soon as their dependencies are merged, each in a persistent lane worktree under `.worktrees/`, and a single merge queue integrates them with full-suite tests. A planner agent resolves questions and gaps that agents raise, and an Opus reviewer checks the whole branch at the end.

## Requirements

- Superpowers ≥ 6.4.1 and the `sp-*` agents in `~/.claude/agents/` (`sp-implementer-fast`, `sp-implementer`, `sp-reviewer`, `sp-final-reviewer`)
- git, jq, Node 24+, Workflows enabled in Claude Code

## Usage

After writing and approving a plan with Superpowers, ask Claude to execute it with `superpowers-parallel:parallel-plan-execution`. You approve the task graph; everything else runs in the background (`/workflows` shows progress).

## Development

`task test` runs the bats and node suites. Design: `docs/superpowers/specs/2026-09-27-parallel-plan-execution-design.md`.
```

- [ ] **Step 2: Register the plugin in the local marketplace**

```bash
ln -s "$HOME/Projects/superpowers-parallel" "$HOME/.claude/local-marketplace/plugins/superpowers-parallel"
jq '.plugins += [{"name":"superpowers-parallel","source":"./plugins/superpowers-parallel","description":"Execute approved Superpowers plans in parallel lane worktrees with a serialized merge queue.","version":"0.1.0"}]' \
  "$HOME/.claude/local-marketplace/.claude-plugin/marketplace.json" > "${tmp:=$(mktemp)}"
mv "$tmp" "$HOME/.claude/local-marketplace/.claude-plugin/marketplace.json"
```
Expected: `jq '.plugins[].name' ~/.claude/local-marketplace/.claude-plugin/marketplace.json` lists `jdtls-lombok` and `superpowers-parallel`.

- [ ] **Step 3: Install and verify**

```bash
claude plugin marketplace update local
claude plugin install superpowers-parallel@local
claude plugin details superpowers-parallel@local
```
Expected: details list the skill `parallel-plan-execution`, the agent `sp-planner` and the workflow `parallel-sdd`. If the agent is listed under a different qualified name than `superpowers-parallel:sp-planner`, update the default `planner` agent type in `workflows/parallel-sdd.js` and the assertion in `test/workflow-coordination.test.mjs`, re-run `task test`, and reinstall.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README and local marketplace registration"
```
````
