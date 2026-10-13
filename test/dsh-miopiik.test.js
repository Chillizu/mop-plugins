import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const META = join(ROOT, 'packages', 'dsh-miopiik')
const HOST_ROWS = [
  'dsh-miopiik-tool-recovery',
  'dsh-miopiik-policy',
  'dsh-miopiik-diagnostics',
  'dsh-tool-session-query',
]
const INTERNAL_PACKAGES = [
  'dsh-miopiik-capabilities',
  'dsh-miopiik-checkpoint',
  'dsh-miopiik-diagnostics',
  'dsh-miopiik-learn',
  'dsh-miopiik-magic-keywords',
  'dsh-miopiik-policy',
  'dsh-miopiik-run-stats',
  'dsh-miopiik-tool-recovery',
]

// Official modules the DSH 0.2.0-rc.2 harness install ships. A row naming one of
// these resolves from the harness checkout. Any other `@deepseek-ai/*` row MUST be
// a declared suite dependency — otherwise the profile boots degraded with
// "dsh: warning: 1 entry did not activate" / "... failed to import", and the tool
// silently never mounts (regression fixed in 0.4.1).
const DSH_HOST_PROVIDED = new Set([
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-workflow-ptc',
])

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

test('every official row resolves from the DSH host bundle or a suite dependency', () => {
  const pkg = JSON.parse(readFileSync(join(META, 'package.json'), 'utf8'))
  const declared = new Set(Object.keys(pkg.dependencies || {}))
  const refs = [
    join(META, 'cordis.patch.yml'),
    join(META, 'preset', 'agent.cordis.yml'),
  ].flatMap((path) => [
    ...readFileSync(path, 'utf8').matchAll(/name:\s*'(@deepseek-ai\/[^']+)'/g),
  ])
  const unrouted = [...new Set(refs.map((m) => m[1]))].filter(
    (name) => !DSH_HOST_PROVIDED.has(name) && !declared.has(name),
  )
  assert.deepEqual(
    unrouted,
    [],
    `official rows with no provider (add the dependency or fix the row name): ${unrouted.join(', ')}`,
  )
})

test('preset mounts the DSH 0.2 workflow engine, not the retired worker-thread package', () => {
  const yaml = readFileSync(join(META, 'preset', 'agent.cordis.yml'), 'utf8')
  assert.match(
    yaml,
    /- id: workflow-ptc\n\s+name: '@deepseek-ai\/dsh-workflow-ptc'/,
  )
  assert.doesNotMatch(yaml, /dsh-workflow-worker-thread/)
})

test('suite depends on every retained workspace and official native plugins', () => {
  const pkg = JSON.parse(readFileSync(join(META, 'package.json'), 'utf8'))
  const deps = pkg.dependencies || {}
  for (const name of INTERNAL_PACKAGES)
    assert.equal(deps[name], `^${pkg.version}`)
  assert.equal(deps['@deepseek-ai/dsh-tool-subagent'], undefined)
  assert.equal(deps['@deepseek-ai/dsh-tool-session-query'], '^0.2.0-rc.2')
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
