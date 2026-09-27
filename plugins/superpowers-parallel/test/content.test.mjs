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

const BUNDLED = {
  'sp-implementer-fast': ['haiku', 'low'],
  'sp-implementer': ['sonnet', 'medium'],
  'sp-reviewer': ['sonnet', 'medium'],
  'sp-final-reviewer': ['opus', 'high'],
}

test('bundled sp-* agents pin model and effort', () => {
  for (const [name, [model, effort]] of Object.entries(BUNDLED)) {
    const fm = frontmatter(read(`agents/${name}.md`))
    assert.equal(fm.name, name)
    assert.equal(fm.model, model, `${name} model`)
    assert.equal(fm.effort, effort, `${name} effort`)
    assert.ok(fm.description.length > 20, `${name} description`)
  }
})

test('the manifest declares the Superpowers dependency', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.deepEqual(manifest.dependencies, ['superpowers@claude-plugins-official'])
})

test('analyzer prompt covers every graph field and placeholder', () => {
  const p = read('skills/parallel-plan-execution/analyzer-prompt.md')
  for (const key of ['test_command', 'setup_command', 'deps', 'files', 'risk', 'tier', 'rationale', 'critical_path', 'estimated_speedup', 'recommendation']) {
    assert.ok(p.includes(key), `missing ${key}`)
  }
  for (const ph of ['{{PLAN}}', '{{SPEC}}', '{{REPO}}', '{{OUT}}']) assert.ok(p.includes(ph), `missing ${ph}`)
})
