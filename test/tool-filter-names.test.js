// 历史事故防线：bundle patch 的每个 `name:` 行都必须在部署时可解析。曾出现
// patch 引用了一个没人提供、也没声明的模块名，profile 启动时该行 import 失败
// （"dsh: warning: 1 entry did not activate" / "failed to import"），工具静默
// 从未挂载——插件代码本身全绿，模型却看不到工具。
//
// 判据（任一成立即可解析）：
//   1. 相对路径 → 文件/目录存在；
//   2. 本仓库 workspace 包（packages/<name>/package.json 的 name 匹配，且入口存在）；
//   3. 引用方 manifest 声明的依赖（dependencies / optionalDependencies / peerDependencies）；
//   4. 已安装 DSH 的 node_modules/@deepseek-ai/<leaf>（宿主自带的官方包）；
//   5. 本地 node_modules 能 require.resolve 到。
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')

/** 已安装 DSH 的 @deepseek-ai 目录（全局 npm 安装或本仓库依赖树）。 */
const DSH_POOLS = [
  process.env.DSH_NODE_MODULES,
  join(ROOT, 'node_modules', '@deepseek-ai'),
  join(
    homedir(),
    '.npm-global',
    'lib',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'node_modules',
    '@deepseek-ai',
  ),
  join(
    dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'node_modules',
    '@deepseek-ai',
  ),
]
  .filter(Boolean)
  .filter((pool) => existsSync(pool))

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function workspacePackages() {
  const found = new Map()
  for (const entry of readdirSync(PACKAGES)) {
    const dir = join(PACKAGES, entry)
    if (!statSync(dir).isDirectory()) continue
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = readJson(manifest)
    found.set(pkg.name, { dir, pkg })
  }
  return found
}

function resolveRowName(ownerDir, ownerPkg, name) {
  if (name.startsWith('.') || name.startsWith('/')) {
    const target = resolve(ownerDir, name)
    return existsSync(target) ? { kind: 'relative', target } : null
  }
  const declared = new Set([
    ...Object.keys(ownerPkg.dependencies ?? {}),
    ...Object.keys(ownerPkg.optionalDependencies ?? {}),
    ...Object.keys(ownerPkg.peerDependencies ?? {}),
  ])
  if (declared.has(name)) return { kind: 'declared-dependency', target: name }

  const workspace = workspacePackages().get(name)
  if (workspace) return { kind: 'workspace-package', target: workspace.dir }

  if (name.startsWith('@deepseek-ai/')) {
    const leaf = name.slice('@deepseek-ai/'.length)
    for (const pool of DSH_POOLS) {
      const candidate = join(pool, leaf)
      if (existsSync(candidate)) return { kind: 'dsh-host', target: candidate }
    }
  }

  try {
    const resolved = createRequire(join(ownerDir, 'package.json')).resolve(name)
    return { kind: 'require.resolve', target: resolved }
  } catch {
    return null
  }
}

function bundlePatches() {
  const patches = []
  for (const [name, { dir, pkg }] of workspacePackages()) {
    const patch = pkg.dsh?.bundle?.patch
    if (!patch) continue
    patches.push({ name, dir, pkg, patch, path: join(dir, patch) })
  }
  return patches
}

function patchRows(path) {
  return [
    ...readFileSync(path, 'utf8').matchAll(
      /- id:\s*(\S+)\s*\n\s+name:\s*'?([^'\n]+?)'?\s*\n/g,
    ),
  ].map((match) => ({ id: match[1], name: match[2] }))
}

test('every workspace package ships the bundle patch it declares', () => {
  const patches = bundlePatches()
  assert.ok(patches.length >= 1, 'at least one DSH bundle patch expected')
  for (const { name, pkg, patch, path } of patches) {
    assert.ok(existsSync(path), `${name}: ${patch} must exist`)
    const shipped = (pkg.files ?? []).map((file) => file.replace(/^\.\//, ''))
    assert.ok(
      shipped.includes(patch.replace(/^\.\//, '')),
      `${name}: ${patch} must be in files[] or the published package cannot mount`,
    )
  }
})

test('every module name referenced by a bundle patch resolves', () => {
  const problems = []
  for (const { name: owner, dir, pkg, path } of bundlePatches()) {
    for (const row of patchRows(path)) {
      const resolved = resolveRowName(dir, pkg, row.name)
      if (resolved === null)
        problems.push(`${owner}: id=${row.id} name=${row.name}`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `patch rows with no provider (add the dependency, fix the name, or mount the provider first):\n${problems.join('\n')}`,
  )
})

test('a workspace row resolves to a package entry that exists', () => {
  const workspaces = workspacePackages()
  for (const { dir, pkg, path } of bundlePatches()) {
    assert.equal(
      dirname(path),
      dir,
      `${pkg.name}: patch must live in the package`,
    )
    for (const row of patchRows(path)) {
      const workspace = workspaces.get(row.name)
      if (!workspace) continue
      const entry =
        workspace.pkg.exports?.['.'] ?? workspace.pkg.main ?? 'index.js'
      const entryPath = join(workspace.dir, entry.replace(/^\.\//, ''))
      assert.ok(
        existsSync(entryPath),
        `${pkg.name}: row ${row.id} → ${row.name} entry ${entry} is missing`,
      )
    }
  }
})

test('patch entry ids are unique inside each patch', () => {
  for (const { name, path } of bundlePatches()) {
    const ids = patchRows(path).map((row) => row.id)
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${name}: duplicate patch entry id in ${path}`,
    )
  }
})

test('the resolver actually rejects unknown names (not a vacuous check)', () => {
  const { dir, pkg } = workspacePackages().get('dsh-session-policy')
  assert.equal(
    resolveRowName(dir, pkg, '@deepseek-ai/dsh-plugin-that-does-not-exist-xyz'),
    null,
  )
  assert.equal(resolveRowName(dir, pkg, 'totally-unknown-package-xyz'), null)
  assert.equal(resolveRowName(dir, pkg, './no-such-relative-file.js'), null)
  // 反向锚：workspace 包与已声明依赖都必须解析成功。
  assert.equal(
    resolveRowName(dir, pkg, 'dsh-session-policy').kind,
    'workspace-package',
  )
  assert.equal(
    resolveRowName(dir, pkg, '@deepseek-ai/dsh-tools').kind,
    'declared-dependency',
  )
  assert.equal(
    resolveRowName(dir, pkg, '@deepseek-ai/dsh-session').kind,
    'declared-dependency',
  )
})
