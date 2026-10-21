// REAL-composition tests: mount the fixture through the harness's real Cordis
// Loader (boot from @deepseek-ai/dsh-app-boot) instead of the register-mocks
// stubs used by test/*.test.js. Run with: npm run test:composition
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureLinks, bootEntry, HARNESS_MODE } from './link-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG_WITH_RETAINED = join(here, 'cordis.with-agent-rewind.yml')
const CONFIG_WITH_PROBE = join(here, 'cordis.with-mop-probe.yml')

/**
 * The real boot entry: app-boot/lib/index.js — from a built DSH source checkout
 * when one is present, otherwise from the installed DSH distribution
 * (HARNESS_MODE 'source' | 'installed').
 */
let boot

before(async () => {
  ensureLinks()
  boot = (await import(pathToFileURL(bootEntry()).href)).boot
  // boot(binName, absoluteConfigPath) mounts the leaf config through the real
  // Loader and settles the tree (app-boot/src/index.ts:757; template in
  // app-boot/tests/app-boot.spec.ts:548).
})

test('harness source is either a built checkout or an installed distribution', () => {
  assert.ok(
    HARNESS_MODE === 'source' || HARNESS_MODE === 'installed',
    `composition tests need a harness (mode=${HARNESS_MODE})`,
  )
})

test('real Loader mounts both retained MiOpIIk packages', async () => {
  const ctx2 = await boot('agent-rewind-composition', CONFIG_WITH_RETAINED)
  try {
    const entries = [...ctx2.loader.entries()]
    for (const id of ['dsh-session-policy', 'dsh-agent-rewind']) {
      const entry = entries.find((candidate) => candidate.options.id === id)
      assert.ok(entry && entry.fiber, `${id} entry must be mounted and active`)
    }
    // 五个工具经真实 ToolRuntime 注册（挂载 ≠ 工具在场，必须逐个查）。
    for (const toolName of [
      'agent_checkpoint',
      'agent_rewind',
      'agent_checkpoint_list',
      'session_rule',
      'session_doctor',
    ]) {
      assert.ok(ctx2.tools.get(toolName), `${toolName} must be registered`)
    }
  } finally {
    await ctx2.fiber.dispose()
  }
})

test('session_doctor(stats) 零桶锚：真实 token-meter 挂载后 tokenUsage 投影存在（零桶）', async () => {
  // 契约锚（原 run-stats 锚点，现服务 session_doctor mode="stats"）：tokenMeter 挂载后
  // tokenUsage 投影恒存在（零桶），undefined 只意味着 tokenMeter 未挂载 —— 这正是
  // 运行时 "live 会话无 tokenUsage 时不得转 cold 兜底" 判据的前提。
  const ctx3 = await boot('agent-rewind-composition', CONFIG_WITH_RETAINED)
  try {
    const session = ctx3.sessions.create('mop-doctor-empty')
    const snap = ctx3.sessionProjections.snapshot(session)
    assert.deepEqual(snap.values.tokenUsage, {
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  } finally {
    await ctx3.fiber.dispose()
  }
})

test('mop-probe mounts on the real Loader and its own tool schema satisfies the upstream contract', async () => {
  // 事故防线（2026-10-13：空 schema 让整轮会话被上游拒绝）的真实装载验证：
  //   1. 探针经真实 Loader 挂载（inject: ['tools'] 被真实 DSH 服务满足）；
  //   2. 它注册的工具确实在场 —— 挂载 ≠ 工具在场；
  //   3. 真实 ToolRuntime 投影出的 schema 是 object-root（不是 null/type:null）。
  // 第 3 条是关键：本仓库单元测试跑在 `defineTool` 替身上（原样返回扁平图），
  // 只有这里拿得到**真实** JSON Schema 投影。
  const ctx5 = await boot('agent-rewind-composition', CONFIG_WITH_PROBE)
  try {
    const entries = [...ctx5.loader.entries()]
    const entry = entries.find(
      (candidate) => candidate.options.id === 'mop-probe',
    )
    assert.ok(
      entry && entry.fiber,
      'mop-probe entry must be mounted and active',
    )
    const definition = ctx5.tools.get('mop_probe_env')
    assert.ok(
      definition,
      'mop_probe_env must be registered by the real ToolRuntime',
    )
    const schema = ctx5.tools
      .schemas()
      .find((item) => item.name === 'mop_probe_env')
    assert.ok(
      schema,
      'mop_probe_env must appear in the model-facing schema projection',
    )
    assert.equal(schema.parameters.type, 'object')
    assert.deepEqual(Object.keys(schema.parameters.properties), ['mode'])
    assert.deepEqual(schema.parameters.required, ['mode'])
    assert.deepEqual(schema.parameters.properties.mode.enum, [
      'env',
      'tools',
      'all',
    ])

    // 判据对**真实投影面**实跑：真实 ToolRuntime 里在场的每个工具都必须过审。
    // 这是本包存在意义的端到端锚点——审计器不能只在单元替身上绿。
    const probe = await import('../../packages/mop-probe/probe.js')
    const surface = probe.probeToolSurface({
      get: (name) => (name === 'tools' ? ctx5.tools : undefined),
    })
    assert.ok(
      surface.available,
      'tools service must be readable through ctx.get',
    )
    assert.ok(surface.total > 0, 'the fixture surface must expose tools')
    assert.deepEqual(
      surface.violations,
      [],
      `the real tool surface must satisfy the upstream contract:\n${surface.violations.join('\n')}`,
    )
  } finally {
    await ctx5.fiber.dispose()
  }
})
