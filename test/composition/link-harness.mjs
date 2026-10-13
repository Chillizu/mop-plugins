// Idempotent symlink setup for the REAL-composition tests.
//
// The harness may come from two places, preferred in this order:
//
//   1. a built DSH source checkout (DSH_HARNESS_ROOT, default
//      /opt/deepseek-harness) — a pnpm workspace whose @deepseek-ai/dsh-*
//      packages are not consumable from a plain npm workspace by bare import
//      (npm cannot resolve the harness's `workspace:^` specs; see README.md);
//   2. the installed DSH distribution (`@deepseek-ai/dsh/node_modules/@deepseek-ai`,
//      located next to the running node or under ~/.npm-global; override with
//      DSH_INSTALL_MODULES) — same rc line, already built.
//
// Either way the real packages are linked into two node_modules locations:
//
//   1. test/composition/node_modules — the Loader resolves the fixture's bare
//      row names from the config directory (ctx.baseUrl), so every row package
//      must be reachable there.
//   2. mop-plugins/node_modules/@deepseek-ai — MiOpIIk plugin imports
//      (@deepseek-ai/dsh-tools, @deepseek-ai/schemastery) resolve from its real
//      path (workspace packages) by walking up the tree.
//
// Node resolves each symlink to the harness realpath, so transitive deps come
// from the harness's own node_modules — one shared @deepseek-ai/cordis instance
// across the whole tree.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARNESS_ROOT = resolve(
  process.env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness',
)

const here = dirname(fileURLToPath(import.meta.url))
const MOP_ROOT = resolve(here, '..', '..')
const SOURCE_BOOT_ENTRY = join(
  HARNESS_ROOT,
  'packages/boot/app-boot/lib/index.js',
)

/** 已安装 DSH 发行版的 @deepseek-ai 目录（含 dsh-app-boot）。 */
function installedModulesDir() {
  const candidates = [
    process.env.DSH_INSTALL_MODULES,
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
  ]
  return (
    candidates.find(
      (dir) => dir && existsSync(join(dir, 'dsh-app-boot/lib/index.js')),
    ) ?? null
  )
}

const installedModules = existsSync(SOURCE_BOOT_ENTRY)
  ? null
  : installedModulesDir()

/** 'source' | 'installed' | 'missing' */
export const HARNESS_MODE = existsSync(SOURCE_BOOT_ENTRY)
  ? 'source'
  : installedModules
    ? 'installed'
    : 'missing'

/** harness 的 boot() 入口（app-boot/lib/index.js）。 */
export function bootEntry() {
  if (HARNESS_MODE === 'source') return SOURCE_BOOT_ENTRY
  if (HARNESS_MODE === 'installed')
    return join(installedModules, 'dsh-app-boot/lib/index.js')
  throw new Error(
    `composition tests need a built DSH checkout at ${HARNESS_ROOT} ` +
      '(packages/boot/app-boot/lib/index.js) or an installed DSH distribution ' +
      '(set DSH_INSTALL_MODULES=/path/to/node_modules/@deepseek-ai)',
  )
}

// [name, path-under-source-checkout] — 已安装发行版按 name 直接取同名包。
const FIXTURE_LINKS = [
  ['dsh-tools', 'packages/core/tools'],
  ['dsh-system-prompt', 'packages/core/system-prompt'],
  ['dsh-session', 'packages/core/session'],
  ['dsh-session-projection', 'packages/session/session-projection'],
  ['dsh-sandbox-local', 'packages/sandbox/sandbox-local'],
  ['dsh-agent', 'packages/core/agent'],
  ['dsh-subagent', 'packages/subagent/subagent'],
  [
    'dsh-subagent-spawn-in-process',
    'packages/subagent/subagent-spawn-in-process',
  ],
  ['dsh-token-meter', 'packages/llm/token-meter'],
  ['dsh-fs-sandbox', 'packages/fs/fs-sandbox'],
  ['dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'],
  ['dsh-fs-observation-policy', 'packages/fs/fs-observation-policy'],
  [
    'dsh-session-persistence-jsonl',
    'packages/session/session-persistence-jsonl',
  ],
  ['dsh-session-query-sqlite', 'packages/session-query/session-query-sqlite'],
  ['dsh-tool-subagent', 'packages/subagent/tool-subagent'],
]

// [scope, name, path-under-source-checkout] — MiOpIIk plugin imports
const WORKSPACE_LINKS = [
  ['@deepseek-ai', 'dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai', 'dsh-llm', 'packages/llm/llm'],
  // dsh-agent-rewind/ledger.js 静态硬 import `@deepseek-ai/dsh-session/fork` 的
  // buildForkSeed。裸 import 从**包的 realpath** 向上解析，而不是从配置目录，所以
  // 必须挂在仓库根 node_modules/@deepseek-ai 下，否则该行会 "failed to import"。
  ['@deepseek-ai', 'dsh-session', 'packages/core/session'],
  ['@deepseek-ai', 'schemastery', 'vendor/schemastery'],
]

/** 一个 harness 包在两种模式下的真实路径。 */
function harnessPackagePath(name, sourceRel) {
  return HARNESS_MODE === 'source'
    ? join(HARNESS_ROOT, sourceRel)
    : join(installedModules, name)
}

function linkIfMissing(linkPath, source) {
  let stats
  try {
    stats = lstatSync(linkPath)
  } catch {
    stats = null
  }
  if (stats) {
    // 真实目录/文件不是我们的软链，绝不动它。
    if (!stats.isSymbolicLink()) return
    let current = null
    try {
      current = resolve(dirname(linkPath), readlinkSync(linkPath))
    } catch {
      current = null
    }
    if (current === resolve(source)) return
    // 指向别处（或悬空）的旧软链：先摘掉再重建。existsSync 会跟随软链，对
    // 悬空链返回 false，于是旧的 symlinkSync 直接 EEXIST——这正是本机
    // /opt/deepseek-harness 缺失时 5/5 失败的根因。
    rmSync(linkPath, { force: true })
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(source, linkPath, 'dir')
}

/** Create every symlink the composition tests need. Safe to call repeatedly. */
export function ensureLinks() {
  bootEntry() // harness 缺失时给出明确错误，而不是让 Loader 抛 ERR_MODULE_NOT_FOUND
  for (const [name, sourceRel] of FIXTURE_LINKS) {
    linkIfMissing(
      join(here, 'node_modules', '@deepseek-ai', name),
      harnessPackagePath(name, sourceRel),
    )
  }
  for (const [scope, name, sourceRel] of WORKSPACE_LINKS) {
    linkIfMissing(
      join(MOP_ROOT, 'node_modules', scope, name),
      harnessPackagePath(name, sourceRel),
    )
  }
  // The MiOpIIk packages the composition tests mount. Link them under their
  // **package names** (what the Loader resolves), not their directory names.
  for (const name of ['dsh-agent-rewind', 'dsh-session-policy', 'mop-probe']) {
    linkIfMissing(
      join(here, 'node_modules', name),
      join(MOP_ROOT, 'packages', name),
    )
  }
}
