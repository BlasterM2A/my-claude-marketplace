import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, baseArgs, task, labels } from './harness.mjs'
import { fakeAgent, DONE, CHANGES, mergeAll, sleep } from './fakes.mjs'

const find = (result, id) => result.tasks.find(t => t.id === id)
const BLOCKED = { ...DONE, status: 'BLOCKED', summary: 'x' }

test('a blocked task retires its lane instead of returning it to the pool', async () => {
  const agent = fakeAgent(label => (label === 'T1·impl' ? BLOCKED : undefined))
  const { result } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2'), task('T3')]) })
  const blockedLane = find(result, 'T1').lane
  assert.ok(result.tasks.filter(t => t.id !== 'T1').every(t => t.state === 'merged' && t.lane !== blockedLane))
  assert.deepEqual(result.lanes_kept, [blockedLane])
})

test('when every lane is retired, remaining tasks are skipped instead of hanging', async () => {
  const agent = fakeAgent(label => {
    if (label === 'setup') return { ok: true, lanes: ['/repo/.worktrees/p-lane-1'], error: '' }
    if (label === 'T1·impl') return BLOCKED
  })
  const { result } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2')]) })
  assert.equal(find(result, 'T2').state, 'skipped')
  assert.match(find(result, 'T2').reason, /no lane left/)
})

test('tasks listed in args.merged are not re-run and unblock their dependants', async () => {
  const args = baseArgs([task('T1'), task('T2', { deps: ['T1'] })], { merged: ['T1'], attempt: 2 })
  const { result, calls } = await runWorkflow({ agent: fakeAgent(), args })
  assert.ok(!labels(calls).some(l => l.startsWith('T1·')))
  assert.equal(find(result, 'T1').state, 'merged')
  assert.equal(find(result, 'T2').state, 'merged')
  assert.ok(calls.every(c => c.prompt.includes('Attempt: 2.')))
})

test('merge and setup agents are told to use a long timeout', async () => {
  const { calls } = await runWorkflow({ agent: fakeAgent(), args: baseArgs([task('T1')]) })
  for (const l of ['setup', 'merge·b1']) assert.match(calls.find(c => c.label === l).prompt, /timeout of 600000 ms/)
})

test('a merge-queue error is retried once without a fix round', async () => {
  let n = 0
  const agent = fakeAgent((label, prompt) => {
    if (!label.startsWith('merge·')) return undefined
    return ++n === 1
      ? { merged: [], conflicts: [], culprits: [], tests_passed: false, test_log: 'exit 3: plan checkout has uncommitted changes' }
      : mergeAll(prompt)
  })
  const { result, calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  assert.equal(find(result, 'T1').state, 'merged')
  assert.ok(!labels(calls).some(l => l.includes('fix-')))
  assert.equal(labels(calls).filter(l => l.startsWith('merge·')).length, 2)
})

test('reviews get the implementer report; re-reviews get the findings and the fix range', async () => {
  let reviews = 0
  const agent = fakeAgent(label => {
    if (label === 'T1·impl') return { ...DONE, commit: 'c1' }
    if (label === 'T1·fix-r1') return { ...DONE, commit: 'c2' }
    if (label === 'T1·review' && ++reviews === 1) return CHANGES
  })
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1')]) })
  const review = calls.find(c => c.label === 'T1·review').prompt
  const rereview = calls.find(c => c.label === 'T1·re-review-r1').prompt
  for (const p of [review, rereview]) assert.match(p, /\/repo\/\.superpowers\/sdd\/p\/T1-report\.md/)
  assert.match(rereview, /fix it/)
  assert.match(rereview, /review-package \/repo\/docs\/plan\.md c1 plan\/p--T1 /)
})

test('review commands compute the base inside a single shell command', async () => {
  const { calls } = await runWorkflow({ agent: fakeAgent(), args: baseArgs([task('T1')]) })
  for (const l of ['T1·review', 'final-review']) {
    assert.match(calls.find(c => c.label === l).prompt, /\(cd \/repo && \S+review-package \/repo\/docs\/plan\.md "\$\(git merge-base /)
  }
})

test('a rework ruling that arrives while the task waits to merge becomes a planner gap', async () => {
  const agent = fakeAgent(async label => {
    if (label === 'merge·b1') { await sleep(30); return undefined }
    if (label === 'T2·impl') { await sleep(10); return { ...DONE, signals: [{ type: 'interface_change', affects: ['T1'], detail: 'renamed' }] } }
    if (label === 'planner·S1') return { action: 'ruling', ruling: 'use parseAll()', affects: ['T1'], reason: 'r', rework: true, new_task: null }
  })
  const { calls } = await runWorkflow({ agent, args: baseArgs([task('T1'), task('T2')]) })
  const s2 = calls.find(c => c.label === 'planner·S2')
  assert.ok(s2, 'expected a second planner call')
  assert.match(s2.prompt, /already merged/)
})
