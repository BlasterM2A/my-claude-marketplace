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
