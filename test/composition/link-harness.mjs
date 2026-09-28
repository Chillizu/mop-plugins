// Idempotent symlink setup for the REAL-composition tests.
//
// The DSH harness checkout (default /opt/deepseek-harness) is a pnpm workspace
// whose @deepseek-ai/dsh-* packages (0.1.0-rc.x) are not consumable from a
// plain npm workspace by bare import: npm install cannot resolve the harness's
// `workspace:^` dependency specs (see composition/README.md). Instead this
// helper links the real packages into two node_modules locations:
//
//   1. test/composition/node_modules — the Loader resolves the fixture's bare
//      row names from the config directory (ctx.baseUrl), so every row package
//      must be reachable there.
//   2. mop-plugins/node_modules/@deepseek-ai — MiOpIIk plugin imports
//      (@deepseek-ai/dsh-tools, @deepseek-ai/schemastery) resolve from its real
//      path (workspace packages) by walking up the tree.
//
// Node resolves each symlink to the harness realpath, so transitive deps come
// from the harness's own pnpm-installed node_modules — one shared
// @deepseek-ai/cordis instance across the whole tree.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARNESS_ROOT = resolve(
  process.env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness',
)

const here = dirname(fileURLToPath(import.meta.url))
const MOP_ROOT = resolve(here, '..', '..')

// [scope, name, target-under-harness] — bare row names in cordis.yml
const FIXTURE_LINKS = [
  ['@deepseek-ai', 'dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai', 'dsh-system-prompt', 'packages/core/system-prompt'],
  ['@deepseek-ai', 'dsh-session', 'packages/core/session'],
  ['@deepseek-ai', 'dsh-agent', 'packages/core/agent'],
  ['@deepseek-ai', 'dsh-subagent', 'packages/subagent/subagent'],
  [
    '@deepseek-ai',
    'dsh-subagent-spawn-in-process',
    'packages/subagent/subagent-spawn-in-process',
  ],
  [
    '@deepseek-ai',
    'dsh-session-projection',
    'packages/session/session-projection',
  ],
  ['@deepseek-ai', 'dsh-token-meter', 'packages/llm/token-meter'],
  ['@deepseek-ai', 'dsh-fs-sandbox', 'packages/fs/fs-sandbox'],
  ['@deepseek-ai', 'dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'],
  [
    '@deepseek-ai',
    'dsh-fs-observation-policy',
    'packages/fs/fs-observation-policy',
  ],
  [
    '@deepseek-ai',
    'dsh-session-persistence-jsonl',
    'packages/session/session-persistence-jsonl',
  ],
  [
    '@deepseek-ai',
    'dsh-session-query-sqlite',
    'packages/session-query/session-query-sqlite',
  ],
  ['@deepseek-ai', 'dsh-tool-subagent', 'packages/subagent/tool-subagent'],
  [
    '@deepseek-ai',
    'dsh-tool-session-query',
    'packages/session-query/tool-session-query',
  ],
]

// [scope, name, target-under-harness] — MiOpIIk plugin imports
const WORKSPACE_LINKS = [
  ['@deepseek-ai', 'dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai', 'dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai', 'schemastery', 'vendor/schemastery'],
]

function linkIfMissing(linkPath, source) {
  if (existsSync(linkPath)) return
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(source, linkPath, 'dir')
}

/** Create every symlink the composition tests need. Safe to call repeatedly. */
export function ensureLinks() {
  for (const [scope, name, rel] of FIXTURE_LINKS) {
    linkIfMissing(
      join(here, 'node_modules', scope, name),
      join(HARNESS_ROOT, rel),
    )
  }
  for (const [scope, name, rel] of WORKSPACE_LINKS) {
    linkIfMissing(
      join(MOP_ROOT, 'node_modules', scope, name),
      join(HARNESS_ROOT, rel),
    )
  }
  // The Config-schema mop packages the composition tests mount.
  for (const name of [
    'dsh-miopiik-tool-recovery',
    'dsh-miopiik-magic-keywords',
    'dsh-miopiik-learn',
    'dsh-miopiik-run-stats',
    'dsh-miopiik-diagnostics',
  ]) {
    linkIfMissing(
      join(here, 'node_modules', name),
      join(MOP_ROOT, 'packages', name),
    )
  }
}
