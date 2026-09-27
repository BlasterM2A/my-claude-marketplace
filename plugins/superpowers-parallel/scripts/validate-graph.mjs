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
