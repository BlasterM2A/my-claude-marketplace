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
const ATTEMPT = A.attempt || 1
const LONG_RULE = 'Run these commands with the Bash tool timeout of 600000 ms; if one could take longer, run it in the background and wait for it to finish.'
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
let signalNo = 0
let newTaskCount = 0
const newTaskCap = Math.min(3, Math.ceil(0.3 * A.graph.tasks.length))

function call(prompt, opts) {
  return agent(`${prompt}\nAttempt: ${ATTEMPT}.`, opts)
}

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
let liveLanes = 0
function acquireLane() {
  if (freeLanes.length) return Promise.resolve(freeLanes.shift())
  if (liveLanes === 0) return Promise.resolve(null)
  const d = deferred()
  laneWaiters.push(d)
  return d.promise
}
function releaseLane(lane) {
  const waiter = laneWaiters.shift()
  if (waiter) waiter.resolve(lane)
  else freeLanes.push(lane)
}
// A lane that held a blocked task is kept for inspection and never reused.
function retireLane(lane) {
  liveLanes--
  log(`[orchestrator] ${laneName(lane)} retired: it holds a blocked task`)
  if (liveLanes === 0) while (laneWaiters.length) laneWaiters.shift().resolve(null)
}

// ---------- prompts ----------
function setupPrompt() {
  const setup = A.graph.setup_command
  return [
    `Prepare the lane worktrees for a parallel plan run. ${CWD_RULE} ${LONG_RULE}`,
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

function reviewPrompt(t, lens, tag, scoped, findings, fixBase) {
  const out = `${WS}/${t.id}-${tag}${lens === 'integration' ? '-int' : ''}.diff`
  const base = fixBase || `"$(git merge-base ${A.planBranch} ${branchOf(t)})"`
  return [
    `You review task ${t.id} ("${t.title}") of the plan ${A.plan} (spec: ${A.spec}). Read-only: do not edit files or commit. ${CWD_RULE}`,
    `1. Run as ONE command: (cd ${A.repo} && ${SDD}/scripts/review-package ${A.plan} ${base} ${branchOf(t)} ${out})`,
    `2. Read the brief ${briefOf(t)}, the implementer report ${WS}/${t.id}-report.md (its test evidence), ${WS}/decisions.md if it exists, and the package ${out}.`,
    scoped
      ? [`3. This is a scoped re-review of a fix (the package covers only the fix commits): follow ${SDD}/re-review-prompt.md and judge only whether these findings are resolved without regressions:`,
        ...(findings || []).map((f, i) => `   ${i + 1}. [${f.severity}] ${f.detail}${f.file ? ` (${f.file})` : ''}`)].join('\n')
      : `3. Follow ${SDD}/task-reviewer-prompt.md.`,
    `4. Scope check: the task owns only ${t.files.join(', ')}; a change to any other file is an Important finding.`,
    lens === 'integration'
      ? '5. Integration lens: focus on contracts with other modules, shared interfaces, concurrency and persistence effects.'
      : '5. Judge behavior the spec does not mention by what a reasonable user would expect.',
    'Return verdict (approved only if no Critical or Important findings remain), findings, declined (what you declined to judge), and signals affecting OTHER tasks.',
  ].join('\n')
}

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

function mergePrompt(batch) {
  const specs = batch.map(t => `${t.id}=${branchOf(t)}`).join(' ')
  return [
    `Run exactly this command and return its JSON output as your structured result. Do not fix, retry or edit anything. ${CWD_RULE} ${LONG_RULE}`,
    `${S}/merge-queue batch ${A.repo} ${A.planBranch} ${WS}/progress.md '${A.graph.test_command.replace(/'/g, "'\\''")}' ${specs}`,
    'If the command exits non-zero, return merged=[], conflicts=[], culprits=[], tests_passed=false and put the error text in test_log.',
  ].join('\n')
}

function finalPrompt() {
  return [
    `You perform the final whole-branch review of the plan ${A.plan} (spec: ${A.spec}). Read-only. ${CWD_RULE}`,
    `1. Run as ONE command: (cd ${A.repo} && ${SDD}/scripts/review-package ${A.plan} "$(git merge-base ${A.baseBranch} ${A.planBranch})" ${A.planBranch} ${WS}/final-review.diff)`,
    `2. Read the spec, ${WS}/decisions.md if it exists, and the package; follow ${A.spSkills}/requesting-code-review/code-reviewer.md.`,
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

// ---------- task pipeline ----------
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
  const r = await call(checkpointPrompt(ids, n), {
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
  const d = await call(plannerPrompt(s, from, n), { label: by, phase: 'Planner', agentType: AG.planner, schema: PLANNER_SCHEMA })
  if (!d) { events.push({ signal: n, from, note: 'planner returned no result' }); return }
  events.push({ signal: n, from, action: d.action, reason: d.reason })
  if (d.ruling) rulings.push({ by, text: d.ruling })
  if (d.action === 'ruling' && d.rework) {
    for (const id of d.affects) {
      if (state[id] === 'running') tasks.get(id).rework = d.ruling
      else if (state[id] === 'merged') runs.push(lateRuling(id, d.ruling, by))
    }
  }
  if (d.action === 'block') for (const id of d.affects) blockTask(id, `needs user decision (${by}): ${d.reason}`)
  if ((d.action === 'add_task' || d.action === 'adapt') && d.new_task) addNewTask(d.new_task, by)
  if (d.action === 'backlog' && d.new_task) backlog.push({ from: by, title: d.new_task.title, reason: d.reason })
}

function lateRuling(id, ruling, by) {
  return planSignal({
    type: 'gap', affects: [id],
    detail: `Ruling "${ruling}" (${by}) arrived after ${id} was already merged; decide whether an adapt task is needed.`,
  }, 'orchestrator')
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

async function reviewTask(t, tag, scoped, findings, fixBase) {
  const lenses = !scoped && t.risk === 'high' ? ['spec', 'integration'] : ['spec']
  const labelOf = lens => `${t.id}·${lens === 'integration' ? 'review-int' : tag}`
  const results = await parallel(lenses.map(lens => () => call(reviewPrompt(t, lens, tag, scoped, findings, fixBase), {
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
  const fix = await call(fixPrompt(t, lane, findings, tag), {
    label: `${t.id}·fix-${tag}`, phase: phaseOf(t), agentType: round >= 4 ? AG.escalation : implType(t), schema: IMPL_SCHEMA,
  })
  if (!fix) return { ok: false, reason: `fixer ${tag} returned no result` }
  collect(`${t.id}·fix-${tag}`, fix)
  if (fix.status === 'BLOCKED') return { ok: false, reason: `fixer ${tag} BLOCKED: ${fix.summary}` }
  const fixBase = t.head
  t.head = fix.commit
  return { ok: true, fixBase }
}

async function implementAndReview(t, lane) {
  const impl = await call(implementPrompt(t, lane), {
    label: `${t.id}·impl`, phase: phaseOf(t), agentType: implType(t), schema: IMPL_SCHEMA,
  })
  if (!impl) return { ok: false, reason: 'implementer returned no result' }
  collect(`${t.id}·impl`, impl)
  if (impl.status === 'BLOCKED') return { ok: false, reason: `implementer BLOCKED: ${impl.summary}` }
  t.head = impl.commit
  let review = await reviewTask(t, 'review', false)
  for (let round = 1; review && review.verdict !== 'approved'; round++) {
    if (round > 5) return { ok: false, reason: 'fix loop exhausted after 5 rounds' }
    const findings = review.findings
    const fix = await fixRound(t, lane, findings, `r${round}`, round)
    if (!fix.ok) return fix
    review = await reviewTask(t, `re-review-r${round}`, true, findings, fix.fixBase)
  }
  if (!review) return { ok: false, reason: 'reviewer returned no result' }
  return { ok: true }
}

async function mergeTask(t, lane) {
  const first = await enqueueMerge(t, false)
  if (first.infra) {
    const again = await enqueueMerge(t, true)
    return again.ok ? again : { ok: false, reason: first.reason }
  }
  if (first.ok || !first.retry) return first
  const fix = await fixRound(t, lane, first.findings, 'merge', 1)
  if (!fix.ok) return fix
  const review = await reviewTask(t, 're-review-merge', true, first.findings, fix.fixBase)
  if (!review || review.verdict !== 'approved') return { ok: false, reason: `${first.reason}; the fix was not approved` }
  const second = await enqueueMerge(t, true)
  return second.ok ? second : { ok: false, reason: first.reason }
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

async function runTask(id) {
  const t = tasks.get(id)
  if (!(await depsMerged(t))) {
    return finish(id, 'skipped', `dependency not merged: ${t.deps.filter(d => state[d] !== 'merged').join(', ')}`)
  }
  if (state[id] !== 'pending') return state[id]
  const lane = await acquireLane()
  if (!lane) return finish(id, 'skipped', 'no lane left: every lane holds a blocked task')
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
      const findings = [{ severity: 'Important', detail: `Apply the planner ruling: ${ruling}` }]
      const fix = await fixRound(t, lane, findings, 'ruling', 1)
      if (!fix.ok) return finish(id, 'blocked', fix.reason)
      const review = await reviewTask(t, 're-review-ruling', true, findings, fix.fixBase)
      if (!review || review.verdict !== 'approved') return finish(id, 'blocked', 'fix for a planner ruling was not approved')
    }
    if (t.blockReason) return finish(id, 'blocked', t.blockReason)
    const merged = await mergeTask(t, lane)
    if (!merged.ok) return finish(id, 'blocked', merged.reason)
    finish(id, 'merged')
    if (t.rework) { runs.push(lateRuling(id, t.rework, 'planner')); t.rework = null }
    if (t.blockReason) events.push({ task: id, note: `block arrived after the merge: ${t.blockReason}` })
    return 'merged'
  } finally {
    if (state[id] === 'blocked') retireLane(lane)
    else releaseLane(lane)
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
  const res = await call(mergePrompt(batch.map(b => b.t)), {
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
      d.resolve({ ok: false, retry: false, infra: !isRetry, reason: res ? `merge queue error: ${res.test_log}` : 'merge agent returned no result' })
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
for (const id of A.merged || []) {
  if (!tasks.has(id)) continue
  state[id] = 'merged'
  mergedSignal[id].resolve(true)
}

phase('Setup')
const setup = await call(setupPrompt(), { label: 'setup', phase: 'Setup', agentType: AG.fast, schema: SETUP_SCHEMA })
if (!setup || !setup.ok) return report({ aborted: true, reason: setup ? setup.error : 'setup agent returned no result' })
for (const lane of setup.lanes) freeLanes.push(lane)
liveLanes = setup.lanes.length

for (const id of [...order]) if (state[id] === 'pending') runs.push(runTask(id))
await drain()

phase('Final')
const anyMerged = order.some(id => state[id] === 'merged')
const finalReview = anyMerged
  ? await call(finalPrompt(), { label: 'final-review', phase: 'Final', agentType: AG.escalation, schema: REVIEW_SCHEMA })
  : null
const keep = [...new Set(order.filter(id => state[id] === 'blocked' && laneOf[id]).map(id => laneOf[id]))]
await call(cleanupPrompt(keep), { label: 'cleanup', phase: 'Final', agentType: AG.fast })
return report({ aborted: false, final_review: finalReview, lanes_kept: keep })
