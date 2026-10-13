import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')
// 保留包的**发布名**：两个包都不是 scoped，但旧实现按包名前缀正则过滤仍会在改名
// 期间静默漏包，断言随之失去对象（真空通过）。
const RETAINED_NAMES = ['dsh-agent-rewind', 'dsh-session-policy']
const LOCKSTEP_ROOTS = ['dsh-agent-rewind', 'dsh-session-policy']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 按 **workspace 目录** 枚举 packages/*，而不是按包名前缀正则过滤：包名可随时
 * 改名/加 scope，目录才是 workspace 的稳定身份；旧实现在改名窗口里返回空集，
 * 断言全部真空通过。
 */
function publicWorkspaceManifests() {
  return readdirSync(PACKAGES)
    .filter((dir) => statSync(join(PACKAGES, dir)).isDirectory())
    .map((dir) => ({
      dir,
      path: join(PACKAGES, dir, 'package.json'),
      pkg: readJson(join(PACKAGES, dir, 'package.json')),
    }))
    .filter(({ pkg }) => LOCKSTEP_ROOTS.includes(pkg.name))
}

test('release train keeps both public workspaces lockstep', () => {
  const manifests = publicWorkspaceManifests()
  // 反向自检：filter 结果必须恰是 2 个包。数量断言让「filter 漏包」这类真空通过
  // 立刻现形，而不是安安静静地少测一个包。
  assert.equal(
    manifests.length,
    2,
    `workspace filter must not silently drop packages (got: ${manifests
      .map(({ pkg }) => pkg.name)
      .join(', ')})`,
  )
  const meta = manifests.find(({ pkg }) => pkg.name === 'dsh-session-policy')
  assert.ok(meta, 'dsh-session-policy meta package must exist')
  const version = meta.pkg.version
  assert.deepEqual(
    manifests.map(({ pkg }) => pkg.name).sort(),
    RETAINED_NAMES,
    'the split suite keeps exactly the policy package and the ledger',
  )

  for (const { path, pkg } of manifests) {
    assert.equal(
      pkg.version,
      version,
      `${path} must match suite version ${version}`,
    )
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (!LOCKSTEP_ROOTS.includes(name)) continue
      assert.equal(
        range,
        `^${version}`,
        `${pkg.name} -> ${name} must use the lockstep release range`,
      )
    }
  }
})

test('package-lock workspace versions and internal ranges match manifests', () => {
  const lock = readJson(join(ROOT, 'package-lock.json'))
  const manifests = publicWorkspaceManifests()

  for (const { dir, pkg } of manifests) {
    const rel = `packages/${dir}`
    const locked = lock.packages && lock.packages[rel]
    assert.ok(locked, `package-lock must contain workspace ${rel}`)
    assert.equal(locked.version, pkg.version, `${rel} lockfile version drifted`)

    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (!LOCKSTEP_ROOTS.includes(name)) continue
      assert.equal(
        locked.dependencies && locked.dependencies[name],
        range,
        `${rel} -> ${name} lockfile range drifted`,
      )
    }
  }
})

test('package-lock carries no stale workspace entry after the slimming', () => {
  const lock = readJson(join(ROOT, 'package-lock.json'))
  const onDisk = new Set(
    readdirSync(PACKAGES).filter((name) =>
      statSync(join(PACKAGES, name)).isDirectory(),
    ),
  )
  const stale = Object.keys(lock.packages || {})
    .filter((key) => key.startsWith('packages/'))
    .map((key) => key.slice('packages/'.length))
    .filter((rel) => !rel.includes('/') && !onDisk.has(rel))
  assert.deepEqual(
    stale,
    [],
    `stale workspaces still locked: ${stale.join(', ')}`,
  )
})
