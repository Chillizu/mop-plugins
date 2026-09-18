import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const META = join(ROOT, 'packages', 'dsh-miopiik')

const RUNTIME_SUITE = [
  'dsh-miopiik-tool-recovery',
  'dsh-miopiik-executor',
  'dsh-miopiik-magic-keywords',
  'dsh-miopiik-model-auth',
  'dsh-miopiik-diagnostics',
  'dsh-miopiik-learn',
  'dsh-miopiik-recall',
]

// 0.2 transition: checkpoint remains an installed compatibility package for
// one migration window, but the default runtime no longer mounts its row.
const PACKAGE_DEPS = [
  ...RUNTIME_SUITE,
  'dsh-miopiik-checkpoint',
  'dsh-miopiik-capabilities',
  'dsh-miopiik-run-stats',
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

test('meta patch inserts exactly the seven 0.2 runtime rows', () => {
  const yaml = readFileSync(join(META, 'cordis.patch.yml'), 'utf8')
  for (const name of RUNTIME_SUITE) {
    assert.match(
      yaml,
      new RegExp(`- id: ${name}\\n\\s+name: ${name}`),
      `patch must insert row ${name}`,
    )
  }
  const inserted = [...yaml.matchAll(/- id:\s*(\S+)/g)].map((m) => m[1])
  assert.deepEqual(inserted.sort(), [...RUNTIME_SUITE].sort())
})

test('meta dependencies retain the 0.2 compatibility packages', () => {
  const pkg = JSON.parse(readFileSync(join(META, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies || {})
  assert.deepEqual(deps.sort(), [...PACKAGE_DEPS].sort())
  for (const name of PACKAGE_DEPS) {
    assert.equal(pkg.dependencies[name], `^${pkg.version}`)
  }
  // npx 按包名解析：必须存在与包同名的 bin，否则 `npx dsh-miopiik` 会 404。
  assert.ok(pkg.bin && typeof pkg.bin['dsh-miopiik'] === 'string')
})

test('0.2 preset mounts converged domains, not compatibility rows', () => {
  const yaml = readFileSync(join(META, 'preset', 'agent.cordis.yml'), 'utf8')
  assert.match(yaml, /- id: dsh-miopiik-tool-recovery\b/)
  assert.match(yaml, /- id: dsh-miopiik-diagnostics\b/)
  assert.doesNotMatch(yaml, /- id: dsh-miopiik-checkpoint\b/)
  assert.doesNotMatch(yaml, /- id: dsh-miopiik-capabilities\b/)
  assert.doesNotMatch(yaml, /- id: dsh-miopiik-run-stats\b/)
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
