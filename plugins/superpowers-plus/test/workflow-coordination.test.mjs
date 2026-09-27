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
  assert.equal(calls.find(c => c.label === 'planner·S1').agentType, 'superpowers-plus:sp-planner')
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
