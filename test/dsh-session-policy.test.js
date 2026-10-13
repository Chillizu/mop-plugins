// 真实行为覆盖：packages/dsh-session-policy/index.js（会话硬规则 + seam/统计诊断）。
//
// 断言自 task-4 的单包运行时测试原样搬运，仅随包拆分与工具重命名调整 import 与
// 工具名。presenceOnly 谓词回归必须保留：成对原语缺一即 present:false。
import assert from 'node:assert/strict'
import test from 'node:test'

import * as policy from '../packages/dsh-session-policy/index.js'
import {
  BUCKETS,
  CAPABILITIES_PATH,
  CWD,
  ZERO_BUCKETS,
  createHarnessFactory,
  flushAsync,
  promptDouble,
  rootAgent,
  runTool,
} from './harness-mocks.mjs'

const makeHarness = createHarnessFactory(policy.apply)

test('exports the session-policy runtime surface', () => {
  assert.equal(policy.name, 'dsh-session-policy')
  assert.deepEqual([...policy.inject].sort(), [
    'fs',
    'sandboxPolicy',
    'sessionPersistence',
    'sessions',
    'tools',
  ])
  assert.equal(typeof policy.apply, 'function')
  assert.equal(typeof policy.probe, 'function')
})

test('the runtime registers exactly its two model-visible tools', () => {
  const harness = makeHarness()
  harness.apply()
  assert.deepEqual(harness.names().sort(), ['session_doctor', 'session_rule'])
  for (const tool of harness.registered) {
    assert.equal(typeof tool.description, 'string', `${tool.name} description`)
    assert.ok(
      tool.description.length > 60,
      `${tool.name} needs a model-facing description, not a stub`,
    )
    assert.equal(
      tool.output.schema.type,
      'string',
      `${tool.name} output schema`,
    )
    assert.equal(typeof tool.output.render, 'function', `${tool.name} render`)
    assert.deepEqual(tool.output.render({}, 'value'), [
      { type: 'text', text: 'value' },
    ])
  }
})

test('session-policy tool parameter schemas match the frozen contract', () => {
  const harness = makeHarness()
  harness.apply()
  const parameters = (name) => harness.tool(name).parameters

  const rule = parameters('session_rule')
  assert.deepEqual(Object.keys(rule).sort(), ['action', 'text'])
  assert.equal(rule.action.required, true)
  assert.deepEqual(rule.action.enum, ['inject', 'show', 'clear'])
  assert.equal(rule.text.required ?? false, false)

  const doctor = parameters('session_doctor')
  assert.deepEqual(Object.keys(doctor).sort(), ['mode', 'sessionId'])
  assert.equal(doctor.mode.required, true)
  assert.deepEqual(doctor.mode.enum, ['seams', 'stats'])
  assert.equal(doctor.sessionId.required ?? false, false)
})

test('apply wires rule state and the startup probe, but no auto-checkpoint', () => {
  const harness = makeHarness()
  harness.apply()
  // 规则清理 + 启动探测是 dsh-session-policy 的职责。
  for (const event of ['agent/created', 'agent/disposed']) {
    assert.equal(harness.listenerCount(event), 1, `${event} listener`)
  }
  // auto-checkpoint 三个钩子归账本包：本包不得再注册。
  for (const event of [
    'agent/inbox/claimed',
    'agent/turn-stopping',
    'agent/error',
  ]) {
    assert.equal(
      harness.listenerCount(event),
      0,
      `${event} must not be wired here`,
    )
  }
  assert.equal(harness.effects.length, 1, 'one ctx.effect teardown')
})

// ── session_rule ────────────────────────────────────────────────────────────

test('session_rule inject/show/clear round-trip on the calling session scope', async () => {
  const harness = makeHarness()
  harness.apply()
  const prompt = promptDouble()
  const agent = rootAgent({ id: 'session-a', systemPrompt: prompt })

  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    '(no rule injected)',
  )
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'clear' }, { agent }),
    '(no rule injected)',
  )

  const injected = await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: '总是先跑测试' },
    { agent },
  )
  assert.equal(injected, 'rule injected: 总是先跑测试')
  assert.equal(prompt.sections.length, 1)
  assert.deepEqual(prompt.sections[0].options, {
    name: 'session:rules',
    order: 50,
    text: '会话硬规则（规则注入）：\n总是先跑测试',
  })

  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    '总是先跑测试',
  )
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'clear' }, { agent }),
    'rules cleared',
  )
  assert.equal(prompt.sections[0].disposed, 1)
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    '(no rule injected)',
  )
})

test('session_rule keeps rule state isolated per session', async () => {
  const harness = makeHarness()
  harness.apply()
  const promptA = promptDouble()
  const promptB = promptDouble()
  const agentA = rootAgent({ id: 'session-a', systemPrompt: promptA })
  const agentB = rootAgent({ id: 'session-b', systemPrompt: promptB })

  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'A 的规则' },
    { agent: agentA },
  )
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'B 的规则' },
    { agent: agentB },
  )
  assert.equal(
    await runTool(
      harness,
      'session_rule',
      { action: 'show' },
      { agent: agentB },
    ),
    'B 的规则',
  )

  await runTool(harness, 'session_rule', { action: 'clear' }, { agent: agentA })
  assert.equal(
    await runTool(
      harness,
      'session_rule',
      { action: 'show' },
      { agent: agentA },
    ),
    '(no rule injected)',
  )
  assert.equal(
    await runTool(
      harness,
      'session_rule',
      { action: 'show' },
      { agent: agentB },
    ),
    'B 的规则',
  )
  assert.equal(promptB.sections[0].disposed, 0)
})

test('session_rule replaces the previous section when re-injected', async () => {
  const harness = makeHarness()
  harness.apply()
  const prompt = promptDouble()
  const agent = rootAgent({ id: 'session-a', systemPrompt: prompt })
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'v1' },
    { agent },
  )
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'v2' },
    { agent },
  )
  assert.equal(prompt.sections.length, 2)
  assert.equal(
    prompt.sections[0].disposed,
    1,
    'previous section must be disposed',
  )
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    'v2',
  )
})

test('session_rule refuses to fall back to a process-global section', async () => {
  const globalPrompt = promptDouble()
  const harness = makeHarness({ services: { systemPrompt: globalPrompt } })
  harness.apply()
  const agent = rootAgent({ id: 'session-a' }) // agent.ctx.get('systemPrompt') → undefined
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_rule',
        { action: 'inject', text: 'x' },
        { agent },
      ),
    /session_rule: session-scoped systemPrompt unavailable — refusing to fall back to a process-global rule/,
  )
  assert.equal(
    globalPrompt.sections.length,
    0,
    'the standing scope must stay untouched',
  )
})

test('session_rule refuses to act without a calling session', async () => {
  const harness = makeHarness()
  harness.apply()
  const anonymous = { session: { id: '', header: { cwd: CWD }, events: [] } }
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_rule',
        { action: 'show' },
        { agent: anonymous },
      ),
    /session_rule: no calling session — refusing to touch process-global rule state/,
  )
})

test('session_rule validates text and action', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent({ id: 'session-a', systemPrompt: promptDouble() })
  for (const args of [
    { action: 'inject' },
    { action: 'inject', text: '   ' },
    { action: 'inject', text: 42 },
  ]) {
    await assert.rejects(
      () => runTool(harness, 'session_rule', args, { agent }),
      /session_rule: text required \(non-empty\) for action "inject"/,
      `args=${JSON.stringify(args)} must be refused`,
    )
  }
  await assert.rejects(
    () => runTool(harness, 'session_rule', { action: 'bogus' }, { agent }),
    /session_rule: unknown action "bogus" \(expected inject\|show\|clear\)/,
  )
})

test('session_rule truncates the echoed inject result to 120 chars', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent({ id: 'session-a', systemPrompt: promptDouble() })
  const long = 'r'.repeat(300)
  const out = await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: long },
    { agent },
  )
  assert.equal(out, `rule injected: ${long.slice(0, 120)}`)
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    long,
  )
})

test('agent/disposed drops that session rule and disposes its section', async () => {
  const harness = makeHarness()
  harness.apply()
  const prompt = promptDouble()
  const agent = rootAgent({ id: 'session-a', systemPrompt: prompt })
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'x' },
    { agent },
  )

  await harness.emitAsync('agent/disposed', { agent })
  assert.equal(prompt.sections[0].disposed, 1)
  assert.equal(
    await runTool(harness, 'session_rule', { action: 'show' }, { agent }),
    '(no rule injected)',
  )

  // 未知会话 / 无 payload 的 disposed 是安全 no-op。
  await harness.emitAsync('agent/disposed', {
    agent: rootAgent({ id: 'other' }),
  })
  await harness.emitAsync('agent/disposed', {})
})

test('ctx.effect teardown recycles every injected rule', async () => {
  const harness = makeHarness()
  harness.apply()
  const promptA = promptDouble()
  const promptB = promptDouble()
  const agentA = rootAgent({ id: 'session-a', systemPrompt: promptA })
  const agentB = rootAgent({ id: 'session-b', systemPrompt: promptB })
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'A' },
    { agent: agentA },
  )
  await runTool(
    harness,
    'session_rule',
    { action: 'inject', text: 'B' },
    { agent: agentB },
  )

  const teardown = harness.effects[0]()
  assert.equal(
    typeof teardown,
    'function',
    'ctx.effect callback must return a disposer',
  )
  teardown()
  assert.equal(promptA.sections[0].disposed, 1)
  assert.equal(promptB.sections[0].disposed, 1)
  assert.equal(
    await runTool(
      harness,
      'session_rule',
      { action: 'show' },
      { agent: agentA },
    ),
    '(no rule injected)',
  )
})

// ── session_doctor(mode="seams") ────────────────────────────────────────────

test('session_doctor(seams) writes the two-column manifest and reports all seams OK', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'seams' },
    { agent },
  )
  assert.equal(
    out,
    `capabilities manifest written to ${CAPABILITIES_PATH} (all 8 seams OK)`,
  )

  const manifest = harness.disk.content(CAPABILITIES_PATH)
  assert.match(manifest, /\| seam \| 在场 \| 实调 \| 详情 \|/)
  assert.match(manifest, /在场 ≠ 可用/)
  assert.match(
    manifest,
    /sessions\.list` \| \[是\] \| \[ok\] \| 0 live sessions/,
  )
  assert.match(
    manifest,
    /sessions\.fork` \| \[是\] \| — \| primitive present \(not invoked: fork creates a real session\)/,
  )
  assert.match(manifest, /systemPrompt\.section` \| \[是\] \| — \|/)
  assert.match(manifest, /sandboxPolicy\.resolve` \| \[是\] \| — \|/)
  assert.match(manifest, /sessionQuery\.readSession` \| \[是\] \| — \|/)
  assert.match(manifest, /status：OK/)
  assert.match(manifest, /运行环境：node /)
  // 根会话 header 无 delegationDepth（absent = 0）→ 审查层。
  assert.match(manifest, /depth 0（审查层）/)

  const write = harness.disk.calls.writeText.at(-1)
  assert.equal(write.path, CAPABILITIES_PATH)
  assert.equal(write.intent.kind, 'createIfAbsent')
  assert.equal(write.policy.session, agent.session)
})

test('session_doctor(seams) replaces an existing manifest through CAS', async () => {
  const harness = makeHarness()
  harness.disk.set(CAPABILITIES_PATH, '# 旧清单\n')
  const version = harness.disk.version(CAPABILITIES_PATH)
  harness.apply()
  await runTool(
    harness,
    'session_doctor',
    { mode: 'seams' },
    { agent: rootAgent() },
  )
  const write = harness.disk.calls.writeText.at(-1)
  assert.equal(write.intent.kind, 'replaceIfVersion')
  assert.equal(write.intent.version, version)
})

test('session_doctor(seams) marks degraded seams while keeping the probe evidence', async () => {
  const harness = makeHarness({
    services: {
      sessionPersistence: {
        list: async () => {
          throw Object.assign(new Error('persistence disabled'), {
            code: 'PERSISTENCE_LIST_DISABLED',
          })
        },
        open: async (id) => ({
          header: { id },
          read: async () => ({ events: [] }),
          close: async () => {},
        }),
      },
    },
  })
  harness.apply()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'seams' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'capabilities manifest written (degraded: sessionPersistence.list)',
  )
  const manifest = harness.disk.content(CAPABILITIES_PATH)
  assert.match(
    manifest,
    /sessionPersistence\.list` \| \[是\] \| \[fail\] \| PERSISTENCE_LIST_DISABLED/,
  )
  assert.match(manifest, /status：DEGRADED/)
})

test('session_doctor(seams) renders a missing seam as [否] instead of crashing', async () => {
  const harness = makeHarness({ services: { sessionQuery: undefined } })
  harness.apply()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'seams' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'capabilities manifest written (degraded: sessionQuery.readSession, sessionQuery.filterSessions/filterEvents)',
  )
  assert.match(
    harness.disk.content(CAPABILITIES_PATH),
    /sessionQuery\.readSession` \| \[否\] \| — \| missing/,
  )
})

test('session_doctor(seams) refuses the paired filter row when one primitive is missing', async () => {
  // presenceOnly 收**谓词**而非预算好的布尔：该行名声明的是成对原语，只有
  // filterSessions 而没有 filterEvents 时必须 [否]——能力清单的价值是「靠证据
  // 说话」，报缺好过谎报。曾经只查 filterSessions，把缺一半的行报成 ok:true。
  const harness = makeHarness({
    services: { sessionQuery: { filterSessions: async () => [] } },
  })
  harness.apply()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'seams' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'capabilities manifest written (degraded: sessionQuery.readSession, sessionQuery.filterSessions/filterEvents)',
  )
  assert.match(
    harness.disk.content(CAPABILITIES_PATH),
    /sessionQuery\.filterSessions\/filterEvents` \| \[否\] \| — \| missing/,
  )
})

test('session_doctor refuses an unknown mode and a session without cwd', async () => {
  const harness = makeHarness()
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_doctor',
        { mode: 'bogus' },
        { agent: rootAgent() },
      ),
    /session_doctor: unknown mode "bogus" \(expected seams\|stats\)/,
  )
  const noCwd = rootAgent()
  delete noCwd.session.header.cwd
  await assert.rejects(
    () =>
      runTool(harness, 'session_doctor', { mode: 'seams' }, { agent: noCwd }),
    /session_doctor: session cwd unavailable/,
  )
})

// ── session_doctor(mode="stats") ────────────────────────────────────────────

test('session_doctor(stats) requires a non-empty sessionId', async () => {
  const harness = makeHarness()
  harness.apply()
  for (const args of [{ mode: 'stats' }, { mode: 'stats', sessionId: '   ' }]) {
    await assert.rejects(
      () => runTool(harness, 'session_doctor', args, { agent: rootAgent() }),
      /session_doctor: sessionId 必填/,
      `args=${JSON.stringify(args)} must be refused`,
    )
  }
})

test('session_doctor(stats) reads a live session projection', async () => {
  const live = { id: 'live-1' }
  const harness = makeHarness({
    services: {
      sessions: { get: (id) => (id === 'live-1' ? live : undefined) },
      sessionProjections: {
        snapshot: (session) => {
          assert.equal(session, live, 'snapshot must receive the live session')
          return { asOfSeq: 12, values: { tokenUsage: BUCKETS } }
        },
      },
    },
  })
  harness.apply()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'stats', sessionId: 'live-1' },
    { agent: rootAgent() },
  )
  assert.deepEqual(JSON.parse(out), {
    sessionId: 'live-1',
    asOfSeq: 12,
    uncachedInputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalInputTokens: 12,
    totalOutputTokens: 5,
  })
})

test('session_doctor(stats) does not fall back to cold when a live session lacks tokenUsage', async () => {
  let coldCalled = false
  const harness = makeHarness({
    services: {
      sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
      sessionProjections: { snapshot: () => ({ asOfSeq: 5, values: {} }) },
      sessionProjectionCache: {
        coldSnapshot: async () => {
          coldCalled = true
          throw new Error('should not be reached')
        },
      },
    },
  })
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_doctor',
        { mode: 'stats', sessionId: 'live-1' },
        { agent: rootAgent() },
      ),
    /session_doctor: tokenUsage 投影不可用（tokenMeter 未挂载）/,
  )
  assert.equal(
    coldCalled,
    false,
    'live sessions must never use the cold fallback',
  )
})

test('session_doctor(stats) reads a cold session through sessionProjectionCache', async () => {
  const seen = []
  const harness = makeHarness({
    services: {
      sessions: { get: () => undefined },
      sessionQuery: {
        readSession: async (id) => ({
          session: { id },
          inheritedEventCount: 3,
          events: [{ type: 'message', seq: 1 }],
        }),
      },
      sessionProjectionCache: {
        coldSnapshot: async (meta, inheritedEventCount, events) => {
          seen.push([meta, inheritedEventCount, events])
          return { asOfSeq: 3, values: { tokenUsage: BUCKETS } }
        },
      },
    },
  })
  harness.apply()
  const out = await runTool(
    harness,
    'session_doctor',
    { mode: 'stats', sessionId: 'cold-9' },
    { agent: rootAgent() },
  )
  assert.deepEqual(seen, [[{ id: 'cold-9' }, 3, [{ type: 'message', seq: 1 }]]])
  assert.equal(JSON.parse(out).totalInputTokens, 12)
  assert.equal(JSON.parse(out).asOfSeq, 3)
})

test('session_doctor(stats) reports zero buckets as INCONCLUSIVE, not PASS', async () => {
  const harness = makeHarness({
    services: {
      sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
      sessionProjections: {
        snapshot: () => ({ asOfSeq: -1, values: { tokenUsage: ZERO_BUCKETS } }),
      },
    },
  })
  harness.apply()
  const out = JSON.parse(
    await runTool(
      harness,
      'session_doctor',
      { mode: 'stats', sessionId: 'live-1' },
      { agent: rootAgent() },
    ),
  )
  assert.equal(out.allZero, true)
  assert.match(out.note, /INCONCLUSIVE/)
  assert.match(out.note, /而非 PASS/)
  assert.equal(out.totalInputTokens, 0)
  assert.equal(out.totalOutputTokens, 0)
})

test('session_doctor(stats) omits the allZero marker when usage is non-zero', async () => {
  const harness = makeHarness({
    services: {
      sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
      sessionProjections: {
        snapshot: () => ({ asOfSeq: 1, values: { tokenUsage: BUCKETS } }),
      },
    },
  })
  harness.apply()
  const out = JSON.parse(
    await runTool(
      harness,
      'session_doctor',
      { mode: 'stats', sessionId: 'live-1' },
      { agent: rootAgent() },
    ),
  )
  assert.equal('allZero' in out, false)
  assert.equal('note' in out, false)
})

test('session_doctor(stats) refuses non-finite or negative buckets', async () => {
  for (const bad of [Number.NaN, -1, '100']) {
    const harness = makeHarness({
      services: {
        sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
        sessionProjections: {
          snapshot: () => ({
            asOfSeq: 1,
            values: { tokenUsage: { ...BUCKETS, outputTokens: bad } },
          }),
        },
      },
    })
    harness.apply()
    await assert.rejects(
      () =>
        runTool(
          harness,
          'session_doctor',
          { mode: 'stats', sessionId: 'live-1' },
          { agent: rootAgent() },
        ),
      /session_doctor: tokenUsage\.outputTokens 非有限非负数值/,
      `bucket=${String(bad)} must be refused`,
    )
  }
})

test('session_doctor(stats) reports an unavailable cold projection seam', async () => {
  const harness = makeHarness({
    services: { sessions: { get: () => undefined } },
  })
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_doctor',
        { mode: 'stats', sessionId: 'cold-1' },
        { agent: rootAgent() },
      ),
    /session_doctor: session cold-1 tokenUsage 投影不可用（tokenMeter 未挂载）/,
  )
})

test('session_doctor(stats) reports a missing persisted session distinctly', async () => {
  const harness = makeHarness({
    services: {
      sessions: { get: () => undefined },
      sessionQuery: {
        readSession: async () => {
          throw new Error('SESSION_NOT_FOUND')
        },
      },
      sessionProjectionCache: { coldSnapshot: async () => ({ values: {} }) },
    },
  })
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'session_doctor',
        { mode: 'stats', sessionId: 'gone' },
        { agent: rootAgent() },
      ),
    /session_doctor: session gone 不存在或未持久化/,
  )
})

test('agent/created auto-probes seams for a root session', async () => {
  const harness = makeHarness()
  harness.apply()
  harness.emit('agent/created', { agent: rootAgent({ id: 'root-1' }) })
  await flushAsync()
  assert.equal(harness.disk.has(CAPABILITIES_PATH), true)
  assert.match(harness.disk.content(CAPABILITIES_PATH), /# DSH Capabilities/)
})

test('agent/created skips delegated sessions', async () => {
  const harness = makeHarness()
  harness.apply()
  harness.emit('agent/created', { agent: rootAgent({ id: 'sub-1', depth: 1 }) })
  await flushAsync()
  assert.equal(harness.disk.has(CAPABILITIES_PATH), false)
})

test('a failed startup probe only logs an error', async (t) => {
  const error = t.mock.method(console, 'error', () => {})
  const harness = makeHarness()
  harness.apply()
  harness.fs.resolve = async () => {
    throw new Error('sandbox denied')
  }
  harness.emit('agent/created', { agent: rootAgent() })
  await flushAsync()
  assert.equal(error.mock.callCount(), 1)
  assert.match(
    String(error.mock.calls[0].arguments[0]),
    /dsh-session-policy: startup probe failed/,
  )
})
