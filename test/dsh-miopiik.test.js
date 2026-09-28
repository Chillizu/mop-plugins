import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const META = join(ROOT, 'packages', 'dsh-miopiik')
const HOST_ROWS = [
  'dsh-miopiik-tool-recovery',
  'dsh-miopiik-diagnostics',
  'dsh-tool-session-query',
]
const INTERNAL_PACKAGES = [
  'dsh-miopiik-capabilities',
  'dsh-miopiik-checkpoint',
  'dsh-miopiik-diagnostics',
  'dsh-miopiik-learn',
  'dsh-miopiik-magic-keywords',
  'dsh-miopiik-run-stats',
  'dsh-miopiik-tool-recovery',
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

test('suite patch mounts MiOpIIk extensions and the missing DSH session-query plugin', () => {
  const yaml = readFileSync(join(META, 'cordis.patch.yml'), 'utf8')
  for (const name of HOST_ROWS)
    assert.match(yaml, new RegExp(`- id: ${name}\\n\\s+name:`))
  const inserted = [...yaml.matchAll(/- id:\s*(\S+)/g)].map((m) => m[1])
  assert.deepEqual(inserted.sort(), [...HOST_ROWS].sort())
})

test('suite depends on every retained workspace and official native plugins', () => {
  const pkg = JSON.parse(readFileSync(join(META, 'package.json'), 'utf8'))
  const deps = pkg.dependencies || {}
  for (const name of INTERNAL_PACKAGES)
    assert.equal(deps[name], `^${pkg.version}`)
  assert.equal(deps['@deepseek-ai/dsh-tool-subagent'], '0.1.7-rc.2')
  assert.equal(deps['@deepseek-ai/dsh-tool-session-query'], '0.1.7-rc.2')
  assert.equal(deps['dsh-miopiik-executor'], undefined)
  assert.equal(deps['dsh-miopiik-model-auth'], undefined)
  assert.equal(deps['dsh-miopiik-recall'], undefined)
  assert.ok(pkg.bin && typeof pkg.bin['dsh-miopiik'] === 'string')
})

test('preset uses native subagent/session/skill APIs and keeps only MiOpIIk-specific host rows', () => {
  const yaml = readFileSync(join(META, 'preset', 'agent.cordis.yml'), 'utf8')
  assert.match(yaml, /toolName: subagent_plan\b/)
  assert.match(yaml, /toolName: subagent_supervise\b/)
  assert.match(yaml, /toolName: subagent_execute\b/)
  assert.match(yaml, /name: '@deepseek-ai\/dsh-tool-skill'/)
  assert.doesNotMatch(
    yaml,
    /mop_recall|mop_learn_list|mop_dispatch|mop_spawn_executor/,
  )
  assert.doesNotMatch(yaml, /dsh-miopiik-(executor|model-auth|recall)/)
})

test('bundled preset stays byte-identical to examples/miopiik', () => {
  const src = join(ROOT, 'examples', 'miopiik')
  const dst = join(META, 'preset')
  const relSrc = walk(src)
    .map((p) => p.slice(src.length + 1))
    .sort()
  const relDst = walk(dst)
    .map((p) => p.slice(dst.length + 1))
    .sort()
  assert.deepEqual(relDst, relSrc, 'preset file sets diverge')
  for (const rel of relSrc) {
    assert.equal(
      readFileSync(join(dst, rel), 'utf8'),
      readFileSync(join(src, rel), 'utf8'),
      `preset file drifted: ${rel}`,
    )
  }
})
