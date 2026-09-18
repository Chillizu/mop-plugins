import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply, formatCheckpointLine, parseCheckpointLine, lastTurnEndSeq } =
  await import('../packages/dsh-miopiik-tool-recovery/index.js')

function makeCtx(overrides = {}) {
  const registered = []
  const writes = []
  const creates = []
  const listeners = {}
  const teardowns = []
  const ctx = {
    on: (event, fn) => {
      listeners[event] = fn
    },
    // fiber 生命周期：记录 apply 注册的 teardown disposer，测试可手动触发
    // 模拟插件 stop/update。
    effect: (setup) => {
      const disposer = setup()
      if (typeof disposer === 'function') teardowns.push(disposer)
      return disposer
    },
    tools: {
      register: (tool) => {
        registered.push(tool)
      },
    },
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () => '',
      writeText: async (_t, content) => {
        writes.push(content)
      },
    },
    systemPrompt: { section: () => () => {} },
    sandboxPolicy: { resolve: () => ({}) },
    sessions: {
      get: () => undefined,
      fork: () => ({ id: 'child-hot' }),
      create: (_id, opts) => {
        creates.push(opts)
        return { id: 'child-cold' }
      },
    },
    sessionPersistence: {
      readFrom: async () => ({ meta: {}, events: [] }),
    },
    ...overrides,
  }
  return { ctx, registered, writes, creates, listeners, teardowns }
}

function agent(id) {
  return {
    session: { id, header: { cwd: '/tmp' }, events: [] },
    ctx: {
      get: (name) =>
        name === 'systemPrompt' ? { section: () => () => {} } : undefined,
    },
  }
}

test('apply registers the seven recovery tools', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  assert.deepEqual(registered.map((t) => t.name).sort(), [
    'mop_checkpoint',
    'mop_checkpoint_list',
    'mop_checkpoint_prune',
    'mop_rewind',
    'mop_rule_clear',
    'mop_rule_inject',
    'mop_rule_show',
  ])
})

function makeAutoCheckpointCtx() {
  const state = { content: '', version: 0, writeCalls: 0 }
  const fs = {
    resolve: async () => ({ key: 'cp' }),
    stat: async () =>
      state.version === 0 ? undefined : { version: state.version },
    readText: async () => state.content,
    writeText: async (_target, content) => {
      state.content = content
      state.version += 1
      state.writeCalls += 1
    },
  }
  const base = makeCtx({ fs })
  apply(base.ctx)
  return { ...base, state }
}

function claimed(agentValue, turn, text) {
  return {
    agent: agentValue,
    turn,
    message: text ? { content: [{ type: 'text', text }] } : { content: [] },
  }
}

test('recovery auto-checkpoint writes one auto-turn for a root turn', async () => {
  const { listeners, state } = makeAutoCheckpointCtx()
  const root = agent('session-root')
  listeners['agent/inbox/claimed'](claimed(root, 3, 'implement phase A'))
  await listeners['agent/turn-stopping']({ agent: root, turn: 3 })

  assert.equal(state.writeCalls, 1)
  assert.match(state.content, /auto-turn/)
  assert.match(state.content, /session=session-root/)
  assert.match(state.content, /turn=3/)
  assert.match(state.content, /user: implement phase A/)
})

test('recovery auto-checkpoint deduplicates repeated turn-stopping', async () => {
  const { listeners, state } = makeAutoCheckpointCtx()
  const root = agent('session-root')
  await listeners['agent/turn-stopping']({ agent: root, turn: 4 })
  await listeners['agent/turn-stopping']({ agent: root, turn: 4 })

  assert.equal(state.writeCalls, 1)
  assert.match(state.content, /user: \(no user text\)/)
})

test('recovery auto-checkpoint dedupe is session-scoped', async () => {
  const { listeners, state } = makeAutoCheckpointCtx()
  const a = agent('session-a')
  const b = agent('session-b')
  await listeners['agent/turn-stopping']({ agent: a, turn: 1 })
  await listeners['agent/turn-stopping']({ agent: b, turn: 1 })

  assert.equal(state.writeCalls, 2)
  assert.match(state.content, /session=session-a/)
  assert.match(state.content, /session=session-b/)
})

test('recovery auto-checkpoint ignores delegated child turns', async () => {
  const { listeners, state } = makeAutoCheckpointCtx()
  const child = agent('session-child')
  child.session.header.delegationDepth = 1
  listeners['agent/inbox/claimed'](claimed(child, 2, 'executor work'))
  await listeners['agent/turn-stopping']({ agent: child, turn: 2 })

  assert.equal(state.writeCalls, 0)
  assert.equal(state.content, '')
})

test('recovery auto-checkpoint records only the first error per turn', async () => {
  const { listeners, state } = makeAutoCheckpointCtx()
  const root = agent('session-root')
  await listeners['agent/error']({
    agent: root,
    turn: 7,
    error: new Error('first failure'),
  })
  await listeners['agent/error']({
    agent: root,
    turn: 7,
    error: new Error('second failure'),
  })

  assert.equal(state.writeCalls, 1)
  assert.match(state.content, /auto-error/)
  assert.match(state.content, /first failure/)
  assert.doesNotMatch(state.content, /second failure/)
})

test('rule state is session-scoped', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const inject = registered.find((t) => t.name === 'mop_rule_inject')
  const show = registered.find((t) => t.name === 'mop_rule_show')
  inject.execute({ text: 'rule for A' }, { agent: agent('session-a') })
  assert.equal(show.execute({}, { agent: agent('session-a') }), 'rule for A')
  assert.equal(
    show.execute({}, { agent: agent('session-b') }),
    '(no rule injected)',
  )
})

test('mop_rule_clear revokes the injected rule', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const inject = registered.find((t) => t.name === 'mop_rule_inject')
  const clear = registered.find((t) => t.name === 'mop_rule_clear')
  const show = registered.find((t) => t.name === 'mop_rule_show')
  inject.execute({ text: 'rule for A' }, { agent: agent('session-a') })
  assert.equal(show.execute({}, { agent: agent('session-a') }), 'rule for A')
  clear.execute({}, { agent: agent('session-a') })
  assert.equal(
    show.execute({}, { agent: agent('session-a') }),
    '(no rule injected)',
  )
})

test('mop_rule_inject throws when session systemPrompt is unavailable', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const inject = registered.find((t) => t.name === 'mop_rule_inject')
  // agent 无 ctx.get('systemPrompt') → 抛错，不退回 standing scope（P0-2）
  assert.throws(
    () => inject.execute({ text: 'x' }, { agent: { session: { id: 's' } } }),
    /session-scoped systemPrompt unavailable/,
  )
})

test('checkpoint line round-trips (golden fixture)', () => {
  const golden =
    '- [2026-01-01T00:00:00.000Z] milestone | session=sess-1 | seq=42 | git@abc1234'
  assert.deepEqual(parseCheckpointLine(golden), {
    label: 'milestone',
    session: 'sess-1',
    seq: 42,
    note: 'git@abc1234',
  })
  const line = formatCheckpointLine('milestone', 'sess-1', 42, 'git@abc1234')
  const parsed = parseCheckpointLine(line)
  assert.equal(parsed.label, 'milestone')
  assert.equal(parsed.session, 'sess-1')
  assert.equal(parsed.seq, 42)
  assert.equal(parsed.note, 'git@abc1234')
})

test('parseCheckpointLine does not substring-match labels', () => {
  const line = formatCheckpointLine('v1-final', 'sess-1', 1, undefined)
  assert.equal(parseCheckpointLine(line).label, 'v1-final')
  assert.notEqual(parseCheckpointLine(line).label, 'v1')
})

test('lastTurnEndSeq finds the last turn/end boundary', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { type: 'turn/end', seq: 3 },
    { type: 'turn/start', seq: 4 },
    { type: 'turn/end', seq: 7 },
  ]
  assert.equal(lastTurnEndSeq(events), 7)
  assert.equal(lastTurnEndSeq([]), 0)
})

test('cold rewind seeds through the inclusive boundary and passes meta', async () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { type: 'tool/call', seq: 1 },
    { type: 'tool/result', seq: 2 },
    { type: 'turn/end', seq: 3 },
    { type: 'turn/start', seq: 4 },
    { type: 'tool/call', seq: 5 },
    { type: 'tool/result', seq: 6 },
    { type: 'turn/end', seq: 7 },
  ]
  const { ctx, registered, creates } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () =>
        '- [2026-01-01T00:00:00.000Z] milestone | session=sess-cold | seq=7\n',
      writeText: async () => {},
    },
    sessionPersistence: {
      readFrom: async () => ({ meta: { cwd: '/proj' }, events }),
    },
  })
  apply(ctx)
  const rewind = registered.find((t) => t.name === 'mop_rewind')
  const result = await rewind.execute(
    { sessionId: 'sess-cold', label: 'milestone' },
    { agent: agent('session-a') },
  )
  assert.match(result, /cold/)
  assert.equal(creates.length, 1)
  assert.equal(creates[0].seed.length, 8) // events[0..7] inclusive
  assert.equal(creates[0].meta.parentSession, 'sess-cold')
  assert.equal(creates[0].meta.cwd, '/proj')
  assert.equal(creates[0].meta.seedLength, 8)
})

test('hot rewind uses sessions.fork', async () => {
  const forked = []
  const { ctx, registered } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () =>
        '- [2026-01-01T00:00:00.000Z] milestone | session=sess-hot | seq=3\n',
      writeText: async () => {},
    },
    sessions: {
      get: (id) => (id === 'sess-hot' ? { events: [] } : undefined),
      fork: (sid, seq) => {
        forked.push({ sid, seq })
        return { id: 'child-hot' }
      },
      create: () => ({ id: 'child-cold' }),
    },
  })
  apply(ctx)
  const rewind = registered.find((t) => t.name === 'mop_rewind')
  const result = await rewind.execute(
    { sessionId: 'sess-hot', label: 'milestone' },
    { agent: agent('session-a') },
  )
  assert.match(result, /hot/)
  assert.deepEqual(forked, [{ sid: 'sess-hot', seq: 3 }])
})

test('rewind takes the latest checkpoint for a duplicate label', async () => {
  const forked = []
  const { ctx, registered } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () =>
        '- [2026-01-01T00:00:00.000Z] milestone | session=sess-hot | seq=3\n' +
        '- [2026-01-02T00:00:00.000Z] milestone | session=sess-hot | seq=9\n',
      writeText: async () => {},
    },
    sessions: {
      get: (id) => (id === 'sess-hot' ? { events: [] } : undefined),
      fork: (sid, seq) => {
        forked.push({ sid, seq })
        return { id: 'child-hot' }
      },
      create: () => ({ id: 'child-cold' }),
    },
  })
  apply(ctx)
  const rewind = registered.find((t) => t.name === 'mop_rewind')
  await rewind.execute(
    { sessionId: 'sess-hot', label: 'milestone' },
    { agent: agent('session-a') },
  )
  assert.deepEqual(forked, [{ sid: 'sess-hot', seq: 9 }]) // 取最新，非最旧 seq=3
})

test('rewind rejects when checkpoint session does not match sessionId', async () => {
  const { ctx, registered } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () =>
        '- [2026-01-01T00:00:00.000Z] milestone | session=sess-a | seq=3\n',
      writeText: async () => {},
    },
  })
  apply(ctx)
  const rewind = registered.find((t) => t.name === 'mop_rewind')
  await assert.rejects(
    () =>
      rewind.execute(
        { sessionId: 'sess-b', label: 'milestone' },
        { agent: agent('session-x') },
      ),
    /belongs to session sess-a, not sess-b/,
  )
})

test('mop_checkpoint_list returns parsed entries', async () => {
  const { ctx, registered } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => ({}),
      readText: async () =>
        '- [2026-01-01T00:00:00.000Z] a | session=s1 | seq=1\n' +
        '- [2026-01-01T00:00:00.000Z] b | session=s2 | seq=2 | note2\n',
      writeText: async () => {},
    },
  })
  apply(ctx)
  const list = registered.find((t) => t.name === 'mop_checkpoint_list')
  const result = await list.execute({}, { agent: agent('session-a') })
  assert.match(result, /a \| session=s1 \| seq=1/)
  assert.match(result, /b \| session=s2 \| seq=2 \| note2/)
})

test('checkpoint write retries on concurrent version conflict', async () => {
  let statCalls = 0
  let writeCalls = 0
  const expected = []
  const { ctx, registered } = makeCtx({
    fs: {
      resolve: async () => ({}),
      stat: async () => {
        statCalls += 1
        return { version: statCalls }
      },
      readText: async () => '- [t] old | session=s | seq=0\n',
      writeText: async (_t, _content, exp) => {
        writeCalls += 1
        expected.push(exp)
        if (writeCalls === 1)
          throw Object.assign(new Error('changed'), {
            code: 'FS_STALE_VERSION',
          })
      },
    },
  })
  apply(ctx)
  const cp = registered.find((t) => t.name === 'mop_checkpoint')
  const result = await cp.execute({ label: 'x' }, { agent: agent('session-a') })
  assert.match(result, /checkpoint OK/)
  assert.equal(writeCalls, 2) // 第一次冲突，第二次成功
  assert.equal(expected[0].kind, 'replaceIfVersion')
  assert.equal(expected[0].version, 1)
  assert.equal(expected[1].version, 2)
})

test('mop_checkpoint rejects label containing newline or pipe', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const cp = registered.find((t) => t.name === 'mop_checkpoint')
  await assert.rejects(
    () => cp.execute({ label: 'bad\nlabel' }, { agent: agent('session-a') }),
    /label 不得包含/,
  )
  await assert.rejects(
    () => cp.execute({ label: 'bad|label' }, { agent: agent('session-a') }),
    /label 不得包含/,
  )
})

test('mop_checkpoint rejects note containing newline or pipe', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const cp = registered.find((t) => t.name === 'mop_checkpoint')
  await assert.rejects(
    () =>
      cp.execute(
        { label: 'ok', note: 'bad\nnote' },
        { agent: agent('session-a') },
      ),
    /note 不得包含/,
  )
  await assert.rejects(
    () =>
      cp.execute(
        { label: 'ok', note: 'bad|note' },
        { agent: agent('session-a') },
      ),
    /note 不得包含/,
  )
})

test('agent/disposed cleans up injected rule state', () => {
  const { ctx, registered, listeners } = makeCtx()
  apply(ctx)
  const inject = registered.find((t) => t.name === 'mop_rule_inject')
  const show = registered.find((t) => t.name === 'mop_rule_show')
  inject.execute({ text: 'rule for A' }, { agent: agent('session-a') })
  assert.equal(show.execute({}, { agent: agent('session-a') }), 'rule for A')
  listeners['agent/disposed']({ agent: agent('session-a') })
  assert.equal(
    show.execute({}, { agent: agent('session-a') }),
    '(no rule injected)',
  )
})

test('fiber teardown disposes every remaining rule section (plugin stop/update)', () => {
  const { ctx, registered, teardowns } = makeCtx()
  apply(ctx)
  const inject = registered.find((t) => t.name === 'mop_rule_inject')
  const show = registered.find((t) => t.name === 'mop_rule_show')

  // 可观测的 section disposer：验证 fiber teardown 真的调用了它。
  const disposed = []
  const spyAgent = (id) => ({
    session: { id, header: { cwd: '/tmp' } },
    ctx: {
      get: (name) =>
        name === 'systemPrompt'
          ? {
              section: () => () => {
                disposed.push(id)
              },
            }
          : undefined,
    },
  })

  inject.execute({ text: 'rule A' }, { agent: spyAgent('session-a') })
  inject.execute({ text: 'rule B' }, { agent: spyAgent('session-b') })
  assert.equal(teardowns.length, 1, 'apply registers exactly one effect')

  // 模拟插件 stop/update：fiber teardown 触发 effect disposer。
  for (const disposer of teardowns) disposer()

  assert.deepEqual(disposed.sort(), ['session-a', 'session-b'])
  assert.equal(
    show.execute({}, { agent: agent('session-a') }),
    '(no rule injected)',
  )
  assert.equal(
    show.execute({}, { agent: agent('session-b') }),
    '(no rule injected)',
  )

  // 幂等：二次 teardown 不抛错。
  for (const disposer of teardowns) disposer()
})

// ── mop_checkpoint_prune ──
const PRUNE_FIXTURE =
  '# header\n' +
  '\n' +
  'some prose line\n' +
  '- [2026-01-01T00:00:00.000Z] legacy-no-session | seq=1\n' +
  '- [2026-01-02T00:00:00.000Z] c1 | session=s1 | seq=1\n' +
  '- [2026-01-03T00:00:00.000Z] c2 | session=s2 | seq=2\n' +
  '- [2026-01-04T00:00:00.000Z] c3 | session=s3 | seq=3\n' +
  '- [2026-01-05T00:00:00.000Z] c4 | session=s4 | seq=4\n' +
  '- [2026-01-06T00:00:00.000Z] c5 | session=s5 | seq=5\n'

// content=null 表示文件不存在（stat → undefined）。
function pruneCtx(content = PRUNE_FIXTURE, opts = {}) {
  const state = { content, version: 1, statCalls: 0, writeCalls: 0 }
  const fs = {
    resolve: async () => ({ key: 'cp' }),
    stat: async () => {
      state.statCalls += 1
      if (state.content === null) return undefined
      return { version: state.version }
    },
    readText: async () => state.content,
    writeText: async (_t, newContent) => {
      state.writeCalls += 1
      if (opts.onWrite) {
        const r = opts.onWrite(state, newContent)
        if (r === 'skip') return
        if (r && r.error) throw r.error
      }
      state.content = newContent
      state.version += 1
    },
  }
  const { ctx, registered } = makeCtx({ fs })
  apply(ctx)
  return { registered, state }
}

test('prune: dry-run 只读不写', async () => {
  const { registered, state } = pruneCtx()
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await prune.execute({ keep: 3 }, { agent: agent('session-a') })
  assert.match(result, /dry-run: would prune 2 checkpoint\(s\)/)
  assert.match(result, /labels: c1, c2/)
  assert.equal(state.writeCalls, 0)
  assert.equal(state.content, PRUNE_FIXTURE)
})

test('prune: confirm:true 正常裁剪并保留最新 keep 条', async () => {
  const { registered, state } = pruneCtx()
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await prune.execute(
    { keep: 3, confirm: true },
    { agent: agent('session-a') },
  )
  assert.match(result, /pruned 2 checkpoint\(s\), kept 3/)
  assert.equal(state.writeCalls, 1)
  const out = state.content
  // 最新 3 条现行行保留
  assert.match(out, /c3 \| session=s3/)
  assert.match(out, /c4 \| session=s4/)
  assert.match(out, /c5 \| session=s5/)
  // 最旧 2 条现行行被删
  assert.doesNotMatch(out, /c1 \| session=s1/)
  assert.doesNotMatch(out, /c2 \| session=s2/)
  // 注释/空行/prose/旧格式行原样保留
  assert.match(out, /# header/)
  assert.match(out, /some prose line/)
  assert.match(out, /legacy-no-session \| seq=1/)
})

test('prune: keep 缺失/负数/非整数/NaN 拒绝', async () => {
  const { registered } = pruneCtx()
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  for (const bad of [undefined, -1, 1.5, Number.NaN, '3']) {
    await assert.rejects(
      () => prune.execute({ keep: bad }, { agent: agent('session-a') }),
      /keep 必须为非负整数/,
    )
  }
})

test('prune: confirm 非布尔值拒绝', async () => {
  const { registered } = pruneCtx()
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  for (const bad of ['true', 1, null]) {
    await assert.rejects(
      () =>
        prune.execute({ keep: 3, confirm: bad }, { agent: agent('session-a') }),
      /confirm 必须为布尔值/,
    )
  }
})

test('prune: keep=0 需 confirm:true，且保留非现行行', async () => {
  const dry = pruneCtx()
  const dryRun = dry.registered.find((t) => t.name === 'mop_checkpoint_prune')
  const preview = await dryRun.execute(
    { keep: 0 },
    { agent: agent('session-a') },
  )
  assert.match(preview, /dry-run: would prune 5 checkpoint\(s\)/)
  assert.equal(dry.state.writeCalls, 0)

  const real = pruneCtx()
  const realRun = real.registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await realRun.execute(
    { keep: 0, confirm: true },
    { agent: agent('session-a') },
  )
  assert.match(result, /pruned 5 checkpoint\(s\), kept 0/)
  assert.doesNotMatch(real.state.content, /\| session=/)
  assert.match(real.state.content, /# header/)
  assert.match(real.state.content, /some prose line/)
  assert.match(real.state.content, /legacy-no-session \| seq=1/)
})

test('prune: 文件不存在无修改', async () => {
  const { registered, state } = pruneCtx(null)
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await prune.execute(
    { keep: 3, confirm: true },
    { agent: agent('session-a') },
  )
  assert.equal(result, '(no checkpoints)')
  assert.equal(state.writeCalls, 0)
})

test('prune: N <= keep 无修改（dry-run 与 confirm 都不写）', async () => {
  const dry = pruneCtx()
  const dryRun = dry.registered.find((t) => t.name === 'mop_checkpoint_prune')
  const preview = await dryRun.execute(
    { keep: 10 },
    { agent: agent('session-a') },
  )
  assert.match(preview, /nothing to prune \(5 checkpoints <= keep 10\)/)
  assert.equal(dry.state.writeCalls, 0)

  const real = pruneCtx()
  const realRun = real.registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await realRun.execute(
    { keep: 10, confirm: true },
    { agent: agent('session-a') },
  )
  assert.match(result, /nothing to prune \(5 checkpoints <= keep 10\)/)
  assert.equal(real.state.writeCalls, 0)
})

test('prune: CAS 版本冲突重试（重读重算）', async () => {
  const { registered, state } = pruneCtx(PRUNE_FIXTURE, {
    onWrite: (st) => {
      if (st.writeCalls === 1) {
        return {
          error: Object.assign(new Error('changed'), {
            code: 'FS_STALE_VERSION',
          }),
        }
      }
    },
  })
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  const result = await prune.execute(
    { keep: 3, confirm: true },
    { agent: agent('session-a') },
  )
  assert.match(result, /pruned 2 checkpoint\(s\), kept 3/)
  assert.equal(state.writeCalls, 2) // 第一次冲突，第二次成功
  assert.doesNotMatch(state.content, /c1 \| session=s1/)
  assert.match(state.content, /c5 \| session=s5/)
})

test('prune: 非重试写入失败不破坏原文件/版本', async () => {
  const { registered, state } = pruneCtx(PRUNE_FIXTURE, {
    onWrite: () => ({ error: new Error('io failure') }),
  })
  const prune = registered.find((t) => t.name === 'mop_checkpoint_prune')
  await assert.rejects(
    () =>
      prune.execute({ keep: 3, confirm: true }, { agent: agent('session-a') }),
    /io failure/,
  )
  assert.equal(state.writeCalls, 1)
  assert.equal(state.content, PRUNE_FIXTURE) // 原内容不变
  assert.equal(state.version, 1) // 版本不变
})
