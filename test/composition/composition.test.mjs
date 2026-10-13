// REAL-composition tests: mount the fixture through the harness's real Cordis
// Loader (boot from @deepseek-ai/dsh-app-boot) instead of the register-mocks
// stubs used by test/*.test.js. Run with: npm run test:composition
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureLinks, bootEntry, HARNESS_MODE } from './link-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(here, 'cordis.yml')
const CONFIG_WITH_RETAINED = join(here, 'cordis.with-agent-rewind.yml')
const CONFIG_EXAMPLE = join(here, 'cordis.agent-rewind-example.yml')

/**
 * The real boot entry: app-boot/lib/index.js — from a built DSH source checkout
 * when one is present, otherwise from the installed DSH distribution
 * (HARNESS_MODE 'source' | 'installed').
 */
let boot
let ctx

before(async () => {
  ensureLinks()
  boot = (await import(pathToFileURL(bootEntry()).href)).boot
  // boot(binName, absoluteConfigPath) mounts the leaf config through the real
  // Loader and settles the tree (app-boot/src/index.ts:757; template in
  // app-boot/tests/app-boot.spec.ts:548).
  ctx = await boot('agent-rewind-composition', CONFIG)
})

after(async () => {
  await ctx?.fiber.dispose()
})

test('harness source is either a built checkout or an installed distribution', () => {
  assert.ok(
    HARNESS_MODE === 'source' || HARNESS_MODE === 'installed',
    `composition tests need a harness (mode=${HARNESS_MODE})`,
  )
})

test('Loader coerces a Config schema default into apply(config)', () => {
  const entries = [...ctx.loader.entries()]
  const spawn = entries.find(
    (entry) => entry.options.id === 'subagent-spawn-in-process',
  )
  assert.ok(spawn, 'subagent-spawn-in-process entry must be mounted and active')
  // fiber.config is the schema-coerced config the Loader passes as apply's
  // second argument (cordis fiber.ts:655 resolveConfig applies Config defaults).
  // The fixture row carries no config, so providerName must come from the
  // schema default z.string().default('spawn')
  // (packages/subagent/subagent-spawn-in-process/src/index.ts Config).
  assert.equal(spawn.fiber.config.providerName, 'spawn')
  // The default must have reached apply: the provider registered under it.
  assert.ok(ctx.subagents.list().includes('spawn'))
})

test('real spawn driver throws TypeError when a start request lacks signal', async () => {
  // subagents.start('spawn', …) -> provider.start -> startInProcessRun
  // (packages/subagent/subagent-in-process-driver/src/index.ts:102); the driver
  // unconditionally dereferences request.signal.aborted at :107. maxDepth is
  // required by assertSubagentMaxDepth (:106), so it is present; signal is not.
  await assert.rejects(
    ctx.subagents.start('spawn', {
      label: 'composition-negative',
      prompt: [{ type: 'text', text: 'x' }],
      maxDepth: 1,
    }),
    (error) =>
      error instanceof TypeError &&
      /reading 'aborted'/.test(error.message) &&
      error.message.includes('undefined'),
    'missing signal must surface the driver TypeError, not a mock-friendly error',
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

test('MiOpIIk 层挂载 smoke：两包经真实 Loader 可挂载', async () => {
  // 证明瘦身后的 inject 联合（tools / fs / sandboxPolicy / sessions /
  // sessionPersistence）被真实 DSH 服务满足，且两个包经真实 Loader 整体挂载、
  // 五个工具全部在场。
  const ctx4 = await boot('agent-rewind-composition', CONFIG_EXAMPLE)
  try {
    const entries = [...ctx4.loader.entries()]
    for (const id of ['dsh-session-policy', 'dsh-agent-rewind']) {
      const entry = entries.find((candidate) => candidate.options.id === id)
      assert.ok(entry && entry.fiber, `${id} entry must be mounted and active`)
    }
    assert.ok(ctx4.tools.get('agent_checkpoint'))
    assert.ok(ctx4.tools.get('agent_rewind'))
    assert.ok(ctx4.tools.get('agent_checkpoint_list'))
    assert.ok(ctx4.tools.get('session_rule'))
    assert.ok(ctx4.tools.get('session_doctor'))
  } finally {
    await ctx4.fiber.dispose()
  }
})
