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
  assert.equal(impl.agentType, 'superpowers-parallel:sp-implementer-fast')
  assert.equal(impl.phase, 'T1 — Task T1')
  assert.equal(calls.find(c => c.label === 'T1·review').agentType, 'superpowers-parallel:sp-reviewer')
  assert.equal(calls.find(c => c.label === 'final-review').agentType, 'superpowers-parallel:sp-final-reviewer')
  assert.ok(logs.includes('[orchestrator] lane-1 ⇐ T1'))
  assert.match(impl.prompt, /Bash working directory resets between commands/)
})

test('args.agents overrides the bundled agent types', async () => {
  const args = baseArgs([task('T1', { tier: 'fast' })], { agents: { fast: 'sp-implementer-fast', escalation: 'sp-final-reviewer' } })
  const { calls } = await runWorkflow({ agent: fakeAgent(), args })
  assert.equal(calls.find(c => c.label === 'T1·impl').agentType, 'sp-implementer-fast')
  assert.equal(calls.find(c => c.label === 'T1·review').agentType, 'superpowers-parallel:sp-reviewer')
  assert.equal(calls.find(c => c.label === 'final-review').agentType, 'sp-final-reviewer')
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

test('the final reviewer reads the spec and the package, not the plan', async () => {
  const { calls } = await runWorkflow({ agent: fakeAgent(), args: baseArgs([task('T1')]) })
  const final = calls.find(c => c.label === 'final-review').prompt
  assert.match(final, /review-package .+plan\.md/)
  assert.doesNotMatch(final, /Read the plan/)
  assert.match(final, /Read the spec/)
})
