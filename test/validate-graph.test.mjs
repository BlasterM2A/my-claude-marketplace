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
