import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function publicWorkspaceManifests() {
  return readdirSync(PACKAGES)
    .map((name) => join(PACKAGES, name, 'package.json'))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path, pkg: readJson(path) }))
    .filter(({ pkg }) => /^dsh-miopiik(?:-|$)/.test(pkg.name))
}

test('release train keeps all public MiOpIIk workspaces lockstep', () => {
  const manifests = publicWorkspaceManifests()
  const meta = manifests.find(({ pkg }) => pkg.name === 'dsh-miopiik')
  assert.ok(meta, 'dsh-miopiik meta package must exist')

  const version = meta.pkg.version
  assert.equal(manifests.length, 11, 'expected 10 plugin/compat packages + 1 suite')

  for (const { path, pkg } of manifests) {
    assert.equal(pkg.version, version, `${path} must match suite version ${version}`)
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (!name.startsWith('dsh-miopiik')) continue
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

  for (const { path, pkg } of manifests) {
    const rel = path
      .slice(ROOT.length + 1)
      .replace(/\/package\.json$/, '')
      .replaceAll('\\\\', '/')
    const locked = lock.packages && lock.packages[rel]
    assert.ok(locked, `package-lock must contain workspace ${rel}`)
    assert.equal(locked.version, pkg.version, `${rel} lockfile version drifted`)

    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (!name.startsWith('dsh-miopiik')) continue
      assert.equal(
        locked.dependencies && locked.dependencies[name],
        range,
        `${rel} -> ${name} lockfile range drifted`,
      )
    }
  }
})
