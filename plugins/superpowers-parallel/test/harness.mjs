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
