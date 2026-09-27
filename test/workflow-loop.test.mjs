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
