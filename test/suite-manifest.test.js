// 套件清单不变式：瘦身后 packages/ 只有两个包 —— dsh-session-policy（会话硬规则 +
// seam/统计诊断）与 dsh-agent-rewind（命名恢复账本）。
// preset/、bin/ 与全部历史兼容包都已退役，任何残留引用都会让 profile 启动时静默
// 降级（"1 entry did not activate"）。
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import * as policy from '../packages/dsh-session-policy/index.js'
import * as ledger from '../packages/dsh-agent-rewind/index.js'

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')
const META = join(PACKAGES, 'dsh-session-policy')
const LEDGER = join(PACKAGES, 'dsh-agent-rewind')
const RETAINED_DIRS = ['dsh-agent-rewind', 'dsh-session-policy']
const RETAINED_NAMES = ['dsh-agent-rewind', 'dsh-session-policy']
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function workspaceDirs() {
  return readdirSync(PACKAGES)
    .filter((name) => statSync(join(PACKAGES, name)).isDirectory())
    .sort()
}

/** `- id: X` + `  name: Y` 行对（bundle patch 的挂载契约）。 */
function patchRows(path) {
  return [
    ...readFileSync(path, 'utf8').matchAll(
      /- id:\s*(\S+)\s*\n\s+name:\s*'?([^'\n]+?)'?\s*\n/g,
    ),
  ].map((match) => ({ id: match[1], name: match[2] }))
}

function importSpecifiers(source) {
  return [...source.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)].map(
    (match) => match[1] ?? match[2],
  )
}

// 子路径导入（`pkg/sub`、`@scope/pkg/sub`）按**包名**判定：包名才是依赖声明单位。
// 不归一化会让 `@deepseek-ai/dsh-session/fork`、`dsh-agent-rewind/x`
// 这类导入绕过声明检查（曾真空通过）。
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

test('packages/ holds exactly the two retained workspace packages', () => {
  assert.deepEqual(workspaceDirs(), RETAINED_DIRS)
  const names = workspaceDirs().map(
    (dir) => readJson(join(PACKAGES, dir, 'package.json')).name,
  )
  assert.deepEqual(names.sort(), RETAINED_NAMES)
  for (const dir of RETAINED_DIRS) {
    assert.ok(existsSync(join(PACKAGES, dir, 'index.js')), `${dir}/index.js`)
  }
})

test('the suite patch mounts exactly the two retained rows', () => {
  assert.deepEqual(patchRows(join(META, 'cordis.patch.yml')), [
    { id: 'dsh-session-policy', name: 'dsh-session-policy' },
    { id: 'dsh-agent-rewind', name: 'dsh-agent-rewind' },
  ])
  assert.deepEqual(patchRows(join(LEDGER, 'cordis.patch.yml')), [
    { id: 'dsh-agent-rewind', name: 'dsh-agent-rewind' },
  ])
})

test('no retained manifest depends on a non-retained internal package', () => {
  // 允许清单式判据（而不是枚举历史包名）：除 @deepseek-ai/* 官方宿主包外，任何
  // 内部依赖都必须是两个保留包之一。历史 MiOpIIk 兼容包与 policy 包一旦残留即被
  // 抓住，不必把旧包名再写进测试。
  for (const dir of RETAINED_DIRS) {
    const pkg = readJson(join(PACKAGES, dir, 'package.json'))
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(pkg[section] ?? {})) {
        if (dependency.startsWith('@deepseek-ai/')) continue
        assert.ok(
          RETAINED_NAMES.includes(dependency),
          `${pkg.name} still lists non-retained internal ${dependency} in ${section}`,
        )
      }
    }
  }
})

test('the meta package depends on the ledger at the lockstep range', () => {
  const pkg = readJson(join(META, 'package.json'))
  const ledgerPkg = readJson(join(LEDGER, 'package.json'))
  // 断言的是**不变式**而不是某个具体版本号：两包同版本，且依赖范围是 `^<该版本>`。
  // 硬编码 `^0.5.0` 会在每次升版时无故变红（真实发生：0.5.1 发布时）。
  assert.equal(
    pkg.dependencies['dsh-agent-rewind'],
    `^${pkg.version}`,
    'meta 对账本的依赖必须是 lockstep 范围 ^<meta 版本>',
  )
  assert.equal(ledgerPkg.version, pkg.version, '两个包必须 lockstep 同版本')
  assert.equal(ledgerPkg.dependencies, undefined, 'ledger has no internal deps')
})

test('both manifests stay publishable DSH bundles', () => {
  for (const dir of RETAINED_DIRS) {
    const pkg = readJson(join(PACKAGES, dir, 'package.json'))
    assert.equal(pkg.type, 'module', `${pkg.name} type`)
    assert.equal(pkg.main, 'index.js', `${pkg.name} main`)
    assert.equal(pkg.exports['.'], './index.js', `${pkg.name} exports["."]`)
    assert.equal(
      pkg.exports['./cordis.patch.yml'],
      './cordis.patch.yml',
      `${pkg.name} exports patch`,
    )
    assert.equal(
      pkg.dsh.bundle.patch,
      './cordis.patch.yml',
      `${pkg.name} dsh.bundle.patch`,
    )
    for (const shipped of ['index.js', 'cordis.patch.yml']) {
      assert.ok(
        pkg.files.includes(shipped),
        `${pkg.name} files must ship ${shipped}`,
      )
    }
  }
})

test('presets, bin scripts and the example layer are gone', () => {
  for (const dir of RETAINED_DIRS) {
    const pkg = readJson(join(PACKAGES, dir, 'package.json'))
    assert.equal(pkg.bin, undefined, `${pkg.name} must not ship a bin script`)
    assert.equal(
      existsSync(join(PACKAGES, dir, 'preset')),
      false,
      `${pkg.name} must not bundle a preset layer`,
    )
  }
  // examples/ 里不得再有任何随包示例 preset（agent.cordis.yml / preset.yml），
  // 历史示例层已随瘦身删除——不再按旧目录名断言，避免把旧命名写回测试。
  const examples = join(ROOT, 'examples')
  const bundledPresets = existsSync(examples)
    ? readdirSync(examples).filter(
        (entry) =>
          statSync(join(examples, entry)).isDirectory() &&
          existsSync(join(examples, entry, 'agent.cordis.yml')),
      )
    : []
  assert.deepEqual(
    bundledPresets,
    [],
    'no bundled example preset layer may remain',
  )
})

test('both packages import only declared modules', () => {
  for (const dir of RETAINED_DIRS) {
    const pkg = readJson(join(PACKAGES, dir, 'package.json'))
    const declared = new Set(
      DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(pkg[section] ?? {})),
    )
    for (const file of readdirSync(join(PACKAGES, dir)).filter((name) =>
      name.endsWith('.js'),
    )) {
      for (const specifier of importSpecifiers(
        readFileSync(join(PACKAGES, dir, file), 'utf8'),
      )) {
        if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
        assert.ok(
          declared.has(packageNameOf(specifier)),
          `${pkg.name}/${file} imports undeclared ${specifier}`,
        )
      }
    }
  }
})

test('the exported runtime surfaces stay frozen', () => {
  for (const module of [policy, ledger]) {
    assert.deepEqual([...module.inject].sort(), [
      'fs',
      'sandboxPolicy',
      'sessionPersistence',
      'sessions',
      'tools',
    ])
    assert.equal(typeof module.apply, 'function')
  }
  assert.equal(policy.name, 'dsh-session-policy')
  assert.equal(typeof policy.probe, 'function')
  assert.equal(ledger.name, 'dsh-agent-rewind')
  assert.equal(ledger.DEFAULT_MAX_CHECKPOINTS, 200)
  for (const helper of [
    'parseCheckpointLine',
    'formatCheckpointLine',
    'lastTurnEndSeq',
    'normalizeSessionId',
    'computePrune',
  ]) {
    assert.equal(
      typeof ledger[helper],
      'function',
      `${helper} must be exported by the ledger`,
    )
  }
})
