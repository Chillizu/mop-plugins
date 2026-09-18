// REAL-composition tests: mount the fixture through the harness's real Cordis
// Loader (boot from @deepseek-ai/dsh-app-boot) instead of the register-mocks
// stubs used by test/*.test.js. Run with: npm run test:composition
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureLinks, HARNESS_ROOT } from './link-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(here, 'cordis.yml')
const CONFIG_WITH_MOP = join(here, 'cordis.with-mop.yml')
const CONFIG_WITH_RUN_STATS = join(here, 'cordis.with-run-stats.yml')
const CONFIG_MIOPIIK = join(here, 'cordis.miopiik-example.yml')

/** The real boot entry: packages/boot/app-boot/src/index.ts:757 (built lib). */
let boot
let ctx

before(async () => {
  ensureLinks()
  boot = (
    await import(
      pathToFileURL(join(HARNESS_ROOT, 'packages/boot/app-boot/lib/index.js'))
        .href
    )
  ).boot
  // boot(binName, absoluteConfigPath) mounts the leaf config through the real
  // Loader and settles the tree (app-boot/src/index.ts:757; template in
  // app-boot/tests/app-boot.spec.ts:548).
  ctx = await boot('mop-composition', CONFIG)
})

after(async () => {
  await ctx?.fiber.dispose()
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

test('real Loader coerces all three mop Config schemas into apply(config)', async () => {
  // Regressions: dsh-miopiik-executor used z.number().int() and dsh-miopiik-model-auth used
  // z.string().optional(), both absent from real schemastery; the mock stub hid
  // them. This boots all three Config-schema packages through the real Loader,
  // so any future bogus schema method fails at boot rather than at a preset
  // switch.
  const ctx2 = await boot('mop-composition', CONFIG_WITH_MOP)
  try {
    const entries = [...ctx2.loader.entries()]
    const exec = entries.find(
      (entry) => entry.options.id === 'dsh-miopiik-executor',
    )
    assert.ok(exec, 'dsh-miopiik-executor entry must be mounted and active')
    assert.equal(exec.fiber.config.maxOutputChars, 4000)
    assert.equal(exec.fiber.config.strict, false)
    // Zero-default model contract (0.1.7+): provider/model are deliberately
    // absent from Config. The caller must pass both explicitly per execution.
    assert.equal(exec.fiber.config.provider, undefined)
    assert.equal(exec.fiber.config.model, undefined)

    const kw = entries.find(
      (entry) => entry.options.id === 'dsh-miopiik-magic-keywords',
    )
    assert.ok(kw, 'dsh-miopiik-magic-keywords entry must be mounted and active')
    assert.ok(
      kw.fiber.config.notices.ultrathink,
      'notices.ultrathink default must be present',
    )
    assert.ok(
      kw.fiber.config.notices.workflowz,
      'notices.workflowz default must be present',
    )

    const auth = entries.find(
      (entry) => entry.options.id === 'dsh-miopiik-model-auth',
    )
    assert.ok(auth, 'dsh-miopiik-model-auth entry must be mounted and active')
    // allowlistPath is optional (no .default), so the Loader leaves it undefined.
    assert.equal(auth.fiber.config.allowlistPath, undefined)
  } finally {
    await ctx2.fiber.dispose()
  }
})

test('run-stats: real Loader 挂载 + tokenUsage 投影零桶锚', async () => {
  // 契约锚：dsh-miopiik-run-stats 依赖「tokenMeter 挂载后 tokenUsage 投影恒存在（零桶），
  // undefined 只 = tokenMeter 未挂载」。此处用真实 token-meter + session-projection
  // 证明 Config z.object({}) 过真实 Loader、dsh-miopiik-run-stats 硬 inject tools、
  // 且空 session 的 snapshot 里 tokenUsage 键确实注册为零桶（非 undefined）。
  const ctx3 = await boot('mop-composition', CONFIG_WITH_RUN_STATS)
  try {
    const entries = [...ctx3.loader.entries()]
    const rs = entries.find(
      (entry) => entry.options.id === 'dsh-miopiik-run-stats',
    )
    assert.ok(rs, 'dsh-miopiik-run-stats entry must be mounted and active')
    assert.deepEqual(
      rs.fiber.config,
      {},
      'Config z.object({}) 经 Loader 得空对象',
    )

    const session = ctx3.sessions.create('run-stats-empty')
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

test('MiOpIIk 层挂载 smoke：0.2 default domains + planner/supervisor delegation 经真实 Loader 可挂载', async () => {
  // 证明 MiOpIIk 0.2 默认层（收敛域 + planner/supervisor 层派发行）的 inject 联合被
  // 真实 DSH 服务满足、可整体挂载——而不只是各自 mock register。persona 行不在本
  // fixture（需 agent-scoped context），由真实 dsh 会话的 standingKeyFor 验证。
  const ctx4 = await boot('mop-composition', CONFIG_MIOPIIK)
  try {
    const entries = [...ctx4.loader.entries()]
    for (const id of [
      'dsh-miopiik-tool-recovery',
      'dsh-miopiik-diagnostics',
      'dsh-miopiik-executor',
      'dsh-miopiik-model-auth',
      'dsh-miopiik-recall',
      'tool-subagent-planner',
      'tool-subagent-supervisor',
    ]) {
      const entry = entries.find((e) => e.options.id === id)
      assert.ok(entry && entry.fiber, `${id} entry must be mounted and active`)
    }
    const executor = ctx4.tools.get('mop_spawn_executor')
    assert.ok(
      executor,
      'mop_spawn_executor must be visible after real Loader mount',
    )
    await assert.rejects(
      executor.execute(
        { prompt: 'composition policy probe' },
        { signal: new AbortController().signal },
      ),
      /未指定执行层模型/,
      'real Loader mount must preserve MiOpIIk zero-default fail-closed routing',
    )
  } finally {
    await ctx4.fiber.dispose()
  }
})
