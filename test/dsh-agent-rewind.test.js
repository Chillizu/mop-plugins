// 真实行为覆盖：packages/dsh-agent-rewind/index.js（账本运行时 —— 命名检查点 /
// 无损回退 / 检查点列表 / auto-checkpoint 事件面 / 纯 helper）。
//
// 断言自 task-4 的单包运行时测试原样搬运，仅随包拆分与工具重命名调整 import 与
// 工具名。两条冷路径回归必须保留：buildForkSeed 补闭合事件 + inheritedEventCount
// 只算继承前缀。
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import * as ledger from '../packages/dsh-agent-rewind/index.js'
import {
  CHECKPOINTS_PATH,
  CWD,
  EVENTS,
  cpLine,
  createHarnessFactory,
  fsError,
  makeNodeDisk,
  rootAgent,
  runTool,
} from './harness-mocks.mjs'

const makeHarness = createHarnessFactory(
  ledger.apply,
  ledger.parseCheckpointLine,
)

test('exports the ledger runtime surface', () => {
  assert.equal(ledger.name, 'dsh-agent-rewind')
  assert.deepEqual([...ledger.inject].sort(), [
    'fs',
    'sandboxPolicy',
    'sessionPersistence',
    'sessions',
    'tools',
  ])
  assert.equal(ledger.DEFAULT_MAX_CHECKPOINTS, 200)
  assert.equal(typeof ledger.apply, 'function')
  for (const helper of [
    'parseCheckpointLine',
    'formatCheckpointLine',
    'lastTurnEndSeq',
    'normalizeSessionId',
    'computePrune',
  ]) {
    assert.equal(
      typeof ledger[helper],
      'function',
      `${helper} must be exported`,
    )
  }
})

test('the ledger registers exactly its three model-visible tools', () => {
  const harness = makeHarness()
  harness.apply()
  assert.deepEqual(harness.names().sort(), [
    'agent_checkpoint',
    'agent_checkpoint_list',
    'agent_rewind',
  ])
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

test('ledger tool parameter schemas match the frozen contract', () => {
  const harness = makeHarness()
  harness.apply()
  const parameters = (name) => harness.tool(name).parameters

  const checkpoint = parameters('agent_checkpoint')
  assert.deepEqual(Object.keys(checkpoint).sort(), [
    'label',
    'note',
    'sessionId',
  ])
  assert.equal(checkpoint.label.required, true)
  assert.equal(checkpoint.label.type, 'string')
  assert.equal(checkpoint.note.required ?? false, false)
  assert.equal(checkpoint.sessionId.required ?? false, false)

  const rewind = parameters('agent_rewind')
  assert.deepEqual(Object.keys(rewind).sort(), ['label', 'sessionId'])
  assert.equal(rewind.sessionId.required, true)
  assert.equal(rewind.label.required, true)

  assert.deepEqual(parameters('agent_checkpoint_list'), {})
})

test('ledger apply rejects a non-positive-integer maxCheckpoints and accepts 1', () => {
  for (const bad of [0, -1, 1.5, '3', null]) {
    const harness = makeHarness()
    assert.throws(
      () => harness.apply({ maxCheckpoints: bad }),
      /maxCheckpoints must be a positive integer/,
      `maxCheckpoints=${String(bad)} must be refused`,
    )
  }
  const harness = makeHarness()
  harness.apply({ maxCheckpoints: 1 })
  assert.equal(harness.names().length, 3)
})

test('the ledger wires the auto-checkpoint hooks and no rule state', () => {
  const harness = makeHarness()
  harness.apply()
  for (const event of [
    'agent/inbox/claimed',
    'agent/turn-stopping',
    'agent/error',
  ]) {
    assert.equal(harness.listenerCount(event), 1, `${event} listener`)
  }
  // 规则状态与启动探测归 dsh-session-policy：账本包不得再注册这两条。
  assert.equal(harness.listenerCount('agent/disposed'), 0)
  assert.equal(harness.listenerCount('agent/created'), 0)
})

// ── 纯 helper ───────────────────────────────────────────────────────────

test('formatCheckpointLine/parseCheckpointLine round-trip, with and without note', () => {
  const withNote = ledger.formatCheckpointLine(
    'deploy-green',
    'session-abc',
    7,
    'git deadbeef',
  )
  assert.match(
    withNote,
    /^- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] deploy-green \| session=session-abc \| seq=7 \| git deadbeef\n$/,
  )
  assert.deepEqual(ledger.parseCheckpointLine(withNote), {
    label: 'deploy-green',
    session: 'session-abc',
    seq: 7,
    note: 'git deadbeef',
  })

  const plain = ledger.formatCheckpointLine('plain label', 'session-abc', 0)
  assert.deepEqual(ledger.parseCheckpointLine(plain), {
    label: 'plain label',
    session: 'session-abc',
    seq: 0,
    note: undefined,
  })
})

test('parseCheckpointLine accepts only the current shape', () => {
  const parse = ledger.parseCheckpointLine
  assert.equal(parse(''), null)
  assert.equal(parse('# checkpoint 注释'), null)
  // auto 行（auto-turn / auto-error）不是命名检查点：列表、裁剪、rewind 都必须无视。
  assert.equal(
    parse(
      '- [2024-01-01T00:00:00.000Z] auto-turn | session=s | turn=3 | user: hi',
    ),
    null,
  )
  assert.equal(
    parse(
      '- [2024-01-01T00:00:00.000Z] auto-error | session=s | turn=3 | boom',
    ),
    null,
  )
  // 旧格式（0.1.x 的 `@ seq` / 无 session 字段）不解析。
  assert.equal(parse('- 2024-01-01 legacy | session=s @ seq 4'), null)
  assert.equal(parse('- [2024-01-01T00:00:00.000Z] no session | seq=4'), null)
  assert.equal(parse('散文 session=s | seq=4'), null)
  assert.deepEqual(
    parse('- [2024-01-01T00:00:00.000Z] ok | session=s | seq=0'),
    {
      label: 'ok',
      session: 's',
      seq: 0,
      note: undefined,
    },
  )
})

test('label matching is exact, never a substring match', () => {
  const entries = [
    cpLine('alpha', 'session-s', 1),
    cpLine('alpha-2', 'session-s', 2),
  ]
    .map((line) => ledger.parseCheckpointLine(line))
    .filter((entry) => entry !== null)
  const exact = entries.filter((entry) => entry.label === 'alpha')
  assert.equal(exact.length, 1)
  assert.equal(exact[0].seq, 1)
})

test('lastTurnEndSeq takes the last turn/end and 0 when absent', () => {
  assert.equal(ledger.lastTurnEndSeq(EVENTS), 6)
  assert.equal(
    ledger.lastTurnEndSeq([
      { type: 'turn/end', seq: 1 },
      { type: 'turn/end', seq: 5 },
      { type: 'message', seq: 9 },
    ]),
    5,
  )
  assert.equal(ledger.lastTurnEndSeq([{ type: 'turn/start', seq: 4 }]), 0)
  assert.equal(ledger.lastTurnEndSeq([]), 0)
  assert.equal(ledger.lastTurnEndSeq(undefined), 0)
})

test('normalizeSessionId tolerates the session- prefix in both directions', () => {
  const prefixed = { get: (id) => (id === 'session-abc' ? { id } : undefined) }
  assert.equal(ledger.normalizeSessionId(prefixed, 'abc'), 'session-abc')
  assert.equal(
    ledger.normalizeSessionId(prefixed, 'session-abc'),
    'session-abc',
  )

  const bare = { get: (id) => (id === 'abc' ? { id } : undefined) }
  assert.equal(ledger.normalizeSessionId(bare, 'session-abc'), 'abc')
  assert.equal(ledger.normalizeSessionId(bare, 'abc'), 'abc')

  // 注册表里都没有 → 原样返回（冷会话路径不能瞎猜前缀）。
  assert.equal(ledger.normalizeSessionId(bare, 'session-zzz'), 'session-zzz')
  assert.equal(ledger.normalizeSessionId(undefined, 'abc'), 'abc')
})

test('computePrune deletes only current-format lines and never comments or prose', () => {
  const content = [
    '# 人工检查点（永不裁剪）',
    '',
    '- [2024-01-01T00:00:00.000Z] oldest | session=s | seq=1',
    '- 2024-01-01 legacy line @ session s',
    '散文：session=x | seq=9',
    '- [2024-01-01T00:00:00.000Z] auto-turn | session=s | turn=1 | user: hi',
    '- [2024-01-01T00:00:00.000Z] middle | session=s | seq=2',
    '- [2024-01-01T00:00:00.000Z] newest | session=s | seq=3',
    '',
  ].join('\n')

  const pruned = ledger.computePrune(content, 2)
  assert.equal(pruned.N, 3)
  assert.equal(pruned.keep, 2)
  assert.equal(pruned.removeCount, 1)
  assert.deepEqual(pruned.prunedLabels, ['oldest'])
  const kept = pruned.kept.join('\n')
  assert.ok(!kept.includes('│oldest') && !kept.includes('oldest |'))
  for (const survivor of [
    '# 人工检查点（永不裁剪）',
    '- 2024-01-01 legacy line @ session s',
    '散文：session=x | seq=9',
    'auto-turn',
    'middle',
    'newest',
  ]) {
    assert.ok(kept.includes(survivor), `${survivor} must survive pruning`)
  }

  // keep >= N：零删除，且不产出重写内容（调用方据此跳过写盘）。
  for (const keep of [3, 4, 99]) {
    const noop = ledger.computePrune(content, keep)
    assert.equal(noop.N, 3)
    assert.equal(noop.removeCount, 0)
    assert.deepEqual(noop.prunedLabels, [])
    assert.equal(noop.kept, null)
  }
})

// ── agent_checkpoint ──────────────────────────────────────────────────────

test('agent_checkpoint appends the last completed turn boundary of the calling session', async () => {
  const harness = makeHarness()
  harness.apply()
  const signal = { aborted: false }
  const agent = rootAgent({ id: 'session-alpha', events: EVENTS })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'milestone-1' },
    { agent, signal },
  )
  assert.equal(out, 'checkpoint OK: milestone-1 @ session session-alpha seq 6')

  const resolved = harness.disk.calls.resolve[0]
  assert.deepEqual(resolved, {
    rel: '.dsh/memory/checkpoints.md',
    cwd: CWD,
    path: CHECKPOINTS_PATH,
  })
  const raw = harness.disk.content(CHECKPOINTS_PATH)
  assert.ok(raw.endsWith('\n'))
  assert.deepEqual(ledger.parseCheckpointLine(raw.split('\n')[0]), {
    label: 'milestone-1',
    session: 'session-alpha',
    seq: 6,
    note: undefined,
  })

  const write = harness.disk.calls.writeText.at(-1)
  assert.equal(write.intent.kind, 'createIfAbsent')
  assert.equal(write.signal, signal, 'exec.signal must reach the write path')
  assert.equal(write.policy.session, agent.session)
})

test('agent_checkpoint trims the note and omits an empty one', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent({ events: EVENTS })
  await runTool(
    harness,
    'agent_checkpoint',
    { label: 'n1', note: '  git abc  ' },
    { agent },
  )
  await runTool(
    harness,
    'agent_checkpoint',
    { label: 'n2', note: '   ' },
    { agent },
  )
  const lines = harness.disk.content(CHECKPOINTS_PATH).split('\n')
  assert.equal(ledger.parseCheckpointLine(lines[0]).note, 'git abc')
  assert.equal(ledger.parseCheckpointLine(lines[1]).note, undefined)
})

test('agent_checkpoint refuses empty labels, separators and newlines', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent()
  for (const label of ['', '   ', 'a\nb', 'a\rb', 'a|b']) {
    await assert.rejects(
      () => runTool(harness, 'agent_checkpoint', { label }, { agent }),
      /agent_checkpoint: (label required|label must not contain newlines or "\|")/,
      `label=${JSON.stringify(label)} must be refused`,
    )
  }
  await assert.rejects(
    () => runTool(harness, 'agent_checkpoint', {}, { agent }),
    /agent_checkpoint: label required/,
  )
  for (const note of ['a\nb', 'a\rb', 'a|b']) {
    await assert.rejects(
      () =>
        runTool(harness, 'agent_checkpoint', { label: 'ok', note }, { agent }),
      /agent_checkpoint: note must not contain newlines or "\|"/,
      `note=${JSON.stringify(note)} must be refused`,
    )
  }
  assert.equal(
    harness.disk.has(CHECKPOINTS_PATH),
    false,
    'refused calls must not write',
  )
})

test('agent_checkpoint with an explicit sessionId reads that session, not the caller', async () => {
  const harness = makeHarness({
    services: {
      sessionQuery: {
        readSession: async (id) => ({
          session: { id },
          inheritedEventCount: 0,
          events: [{ type: 'turn/end', seq: 11 }],
        }),
      },
    },
  })
  harness.apply()
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'other', sessionId: 'session-bravo' },
    { agent: rootAgent({ id: 'session-alpha', events: EVENTS }) },
  )
  assert.equal(out, 'checkpoint OK: other @ session session-bravo seq 11')
})

test('agent_checkpoint refuses a blank or unreadable explicit sessionId', async () => {
  const harness = makeHarness({
    services: { sessionPersistence: {}, sessionQuery: undefined },
  })
  harness.apply()
  const agent = rootAgent()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x', sessionId: '  ' },
        { agent },
      ),
    /sessionId must be non-empty when provided/,
  )
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x', sessionId: 'session-cold' },
        { agent },
      ),
    /not live and neither sessionQuery\.readSession nor a sessionPersistence read seam is available/,
  )
})

test('agent_checkpoint reads a live session only through snapshotEvents()', async () => {
  // 回归锚（真实事故）：DSH 的 `Session` **没有** 公开的 `.events` 属性，事件只能经
  // `snapshotEvents()` 取得。旧实现读 `agent.session.events` → undefined →
  // 误报 "event stream ... unavailable"，checkpoint 在真实部署里 100% 失败。
  // 契约由 test/session-contract.mjs 对真实 Session 类实测（快照存在、.events 缺位）。
  const events = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 0 } },
    { seq: 1, type: 'turn/end', time: 2, data: { turn: 0 } },
    { seq: 2, type: 'turn/start', time: 3, data: { turn: 1 } },
    { seq: 3, type: 'turn/end', time: 4, data: { turn: 1 } },
  ]
  const agent = rootAgent({ events })
  // 前置断言：这个替身不得像旧 fixture 那样偷偷提供 `.events`。
  assert.equal(
    agent.session.events,
    undefined,
    '替身不得暴露 .events（真实 Session 没有）',
  )
  const harness = makeHarness()
  harness.apply()
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'live-snapshot' },
    { agent },
  )
  // 边界必须来自 snapshotEvents() 读到的事件流（最后一个 turn/end 的 seq = 3）。
  assert.equal(out, 'checkpoint OK: live-snapshot @ session session-root seq 3')
  assert.match(
    harness.disk.content(CHECKPOINTS_PATH),
    /live-snapshot \| session=session-root \| seq=3/,
  )
})

test('agent_checkpoint refuses a session without cwd, id or event stream', async () => {
  const harness = makeHarness()
  harness.apply()

  const noCwd = rootAgent()
  delete noCwd.session.header.cwd
  await assert.rejects(
    () =>
      runTool(harness, 'agent_checkpoint', { label: 'x' }, { agent: noCwd }),
    /agent_checkpoint: session cwd unavailable/,
  )

  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x' },
        { agent: rootAgent({ id: '' }) },
      ),
    /agent_checkpoint: target session id unavailable/,
  )

  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x' },
        {
          // 会话对象无法产出事件流：既没有 snapshotEvents() 也没有 .events。
          // 这正是「替身曾比现实更宽松」要防的形态——真实 Session 的公开面
          // 只有 snapshotEvents()，所以「读不出事件」必须报错而不是静默当空。
          agent: { session: { id: 'session-root', header: { cwd: CWD } } },
        },
      ),
    /agent_checkpoint: event stream of session session-root unavailable/,
  )
})

test('agent_checkpoint retries after FS_STALE_VERSION and keeps the rival line', async () => {
  const harness = makeHarness()
  harness.disk.set(CHECKPOINTS_PATH, cpLine('preexisting', 'session-root', 1))
  harness.apply()
  let attempts = 0
  harness.disk.hooks.write.push(() => {
    attempts += 1
    if (attempts === 1) {
      // 并发写者在 stat 之后、writeText 之前推进了文件版本。
      harness.disk.set(
        CHECKPOINTS_PATH,
        cpLine('preexisting', 'session-root', 1) +
          cpLine('rival', 'session-root', 2),
      )
      throw fsError('FS_STALE_VERSION', 'moved')
    }
  })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'after-conflict' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(attempts, 2, 'exactly one retry must be attempted')
  assert.equal(
    out,
    'checkpoint OK: after-conflict @ session session-root seq 6',
  )
  const lines = harness.disk
    .content(CHECKPOINTS_PATH)
    .split('\n')
    .filter(Boolean)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((line) => ledger.parseCheckpointLine(line).label),
    ['preexisting', 'rival', 'after-conflict'],
  )
})

test('agent_checkpoint retries when a rival creates the file first (FS_NOT_OBSERVED)', async () => {
  const harness = makeHarness()
  harness.apply()
  let attempts = 0
  harness.disk.hooks.write.push(() => {
    attempts += 1
    if (attempts === 1) {
      harness.disk.set(CHECKPOINTS_PATH, cpLine('creator', 'session-root', 1))
      throw fsError('FS_NOT_OBSERVED', 'created concurrently')
    }
  })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'loser' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(attempts, 2)
  assert.equal(out, 'checkpoint OK: loser @ session session-root seq 6')
  assert.equal(harness.disk.parsedCount(CHECKPOINTS_PATH), 2)
})

test('agent_checkpoint gives up after persistent CAS conflicts and reports it', async () => {
  const harness = makeHarness()
  harness.disk.set(CHECKPOINTS_PATH, cpLine('base', 'session-root', 1))
  harness.apply()
  harness.disk.hooks.write.push(() => {
    throw fsError('FS_STALE_VERSION', 'always moving')
  })
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x' },
        { agent: rootAgent({ events: EVENTS }) },
      ),
    /agent_checkpoint: append failed after retries \(concurrent writes\)/,
  )
  assert.equal(
    harness.disk.calls.writeText.filter(
      (call) => call.path === CHECKPOINTS_PATH,
    ).length,
    3,
    'three attempts, then a clear failure',
  )
  assert.equal(
    harness.disk.content(CHECKPOINTS_PATH),
    cpLine('base', 'session-root', 1),
  )
})

test('agent_checkpoint surfaces a non-retryable write failure', async () => {
  const harness = makeHarness()
  harness.apply()
  harness.disk.hooks.write.push(() => {
    throw fsError('FS_PERMISSION_DENIED', 'read-only workspace')
  })
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_checkpoint',
        { label: 'x' },
        { agent: rootAgent({ events: EVENTS }) },
      ),
    /FS_PERMISSION_DENIED/,
  )
  assert.equal(harness.disk.has(CHECKPOINTS_PATH), false)
})

test('agent_checkpoint appends a parseable line to a file without a trailing newline', async () => {
  // 继承缺陷回归：历史文件（人工编辑 / 外部工具）末尾无换行时，旧实现把新行
  // 直接粘在旧行尾部 → 新 checkpoint 不可解析、静默丢失。
  const harness = makeHarness()
  const legacy = cpLine('legacy-tail', 'session-root', 4).trimEnd()
  harness.disk.set(CHECKPOINTS_PATH, legacy)
  harness.apply()
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'after-legacy' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(out, 'checkpoint OK: after-legacy @ session session-root seq 6')
  const raw = harness.disk.content(CHECKPOINTS_PATH)
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.deepEqual(ledger.parseCheckpointLine(lines[0]), {
    label: 'legacy-tail',
    session: 'session-root',
    seq: 4,
    note: undefined,
  })
  assert.ok(raw.startsWith(legacy + '\n'), '旧行必须原样保留并补上换行')
  assert.equal(ledger.parseCheckpointLine(lines[1]).label, 'after-legacy')
  assert.equal(harness.disk.parsedCount(CHECKPOINTS_PATH), 2)
  assert.doesNotMatch(raw, /seq=4- \[/)
})

test('agent_checkpoint auto-prunes the oldest current-format lines past the limit', async () => {
  const harness = makeHarness()
  harness.disk.set(
    CHECKPOINTS_PATH,
    [
      '# 人工检查点（永不裁剪）',
      cpLine('oldest', 'session-root', 1).trimEnd(),
      '散文：session=x | seq=9',
      cpLine('middle', 'session-root', 2).trimEnd(),
      '',
    ].join('\n'),
  )
  harness.apply({ maxCheckpoints: 2 })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'newest' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(
    out,
    'checkpoint OK: newest @ session session-root seq 6; pruned 1 oldest',
  )
  const raw = harness.disk.content(CHECKPOINTS_PATH)
  assert.ok(raw.includes('# 人工检查点（永不裁剪）'))
  assert.ok(raw.includes('散文：session=x | seq=9'))
  assert.ok(raw.includes('middle') && raw.includes('newest'))
  assert.ok(!raw.includes('oldest'))
  assert.equal(harness.disk.parsedCount(CHECKPOINTS_PATH), 2)
})

test('agent_checkpoint reports no prune suffix while the count stays within the limit', async () => {
  const harness = makeHarness()
  harness.disk.set(CHECKPOINTS_PATH, cpLine('one', 'session-root', 1))
  harness.apply({ maxCheckpoints: 2 })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'two' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(out, 'checkpoint OK: two @ session session-root seq 6')
  assert.ok(!out.includes('pruned'))
})

test('a failed prune never hides a successful append', async () => {
  const harness = makeHarness()
  harness.disk.set(
    CHECKPOINTS_PATH,
    cpLine('one', 'session-root', 1) + cpLine('two', 'session-root', 2),
  )
  harness.apply({ maxCheckpoints: 2 })
  let writes = 0
  harness.disk.hooks.write.push(() => {
    writes += 1
    if (writes === 2)
      throw fsError('FS_PERMISSION_DENIED', 'prune rewrite denied')
  })
  const out = await runTool(
    harness,
    'agent_checkpoint',
    { label: 'x' },
    { agent: rootAgent({ events: EVENTS }) },
  )
  assert.equal(
    out,
    'checkpoint OK: x @ session session-root seq 6; prune failed: FS_PERMISSION_DENIED',
  )
  assert.equal(harness.disk.parsedCount(CHECKPOINTS_PATH), 3)
})

// ── agent_rewind ──────────────────────────────────────────────────────────

test('agent_rewind reports a missing label instead of silently forking', async () => {
  const harness = makeHarness()
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_rewind',
        { sessionId: 'session-root', label: 'nope' },
        { agent: rootAgent() },
      ),
    /agent_rewind: no checkpoint found for label "nope"/,
  )
})

test('agent_rewind refuses a checkpoint recorded for another session', async () => {
  const harness = makeHarness()
  harness.disk.set(CHECKPOINTS_PATH, cpLine('m1', 'session-alpha', 3))
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_rewind',
        { sessionId: 'session-bravo', label: 'm1' },
        { agent: rootAgent() },
      ),
    /agent_rewind: checkpoint "m1" belongs to session session-alpha, not session-bravo/,
  )
})

test('agent_rewind hot path forks the live session at the checkpoint seq', async () => {
  const forks = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: (id) => (id === 'session-root' ? { id } : undefined),
        fork: (sid, seq) => {
          forks.push([sid, seq])
          return { id: 'child-hot' }
        },
      },
    },
  })
  harness.disk.set(CHECKPOINTS_PATH, cpLine('hot-1', 'session-root', 6))
  harness.apply()
  const out = await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-root', label: 'hot-1' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'rewound (hot): forked session-root @ seq 6 -> child child-hot',
  )
  assert.deepEqual(forks, [['session-root', 6]])
})

test('agent_rewind tolerates a missing/extra session- prefix on the recorded session', async () => {
  const forks = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: (id) => (id === 'session-root' ? { id } : undefined),
        fork: (sid, seq) => {
          forks.push([sid, seq])
          return { id: 'child-hot' }
        },
      },
    },
  })
  // checkpoint 记的是裸 id，调用方写带前缀的 id。
  harness.disk.set(CHECKPOINTS_PATH, cpLine('prefixed', 'root', 4))
  harness.apply()
  const out = await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-root', label: 'prefixed' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'rewound (hot): forked session-root @ seq 4 -> child child-hot',
  )
  assert.deepEqual(forks, [['session-root', 4]])
})

test('agent_rewind takes the newest matching label and matches it exactly', async () => {
  const forks = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: (id) => (id === 'session-root' ? { id } : undefined),
        fork: (sid, seq) => {
          forks.push([sid, seq])
          return { id: `child-${seq}` }
        },
      },
    },
  })
  harness.disk.set(
    CHECKPOINTS_PATH,
    cpLine('deploy', 'session-root', 3) +
      cpLine('deploy-2', 'session-root', 9) +
      cpLine('deploy', 'session-root', 7),
  )
  harness.apply()
  const out = await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-root', label: 'deploy' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'rewound (hot): forked session-root @ seq 7 -> child child-7',
  )
  assert.deepEqual(forks, [['session-root', 7]])
})

test('agent_rewind cold path seeds a new session with events[0..seq]', async () => {
  // 边界落在 step 中间（未闭合尾巴）：合法日志必有 data，buildForkSeed 依赖它。
  const ts = '2026-01-01T00:00:00.000Z'
  const ev = (seq, type, data = {}) => ({ seq, type, data, time: ts })
  const events = [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'step/start', { step: 0 }),
    ev(2, 'turn/end', { turn: 0 }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(4, 'step/start', { step: 0 }),
  ]
  const creates = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: () => undefined,
        create: (...args) => {
          creates.push(args)
          return { id: 'child-cold' }
        },
      },
      sessionQuery: {
        readSession: async (id) => ({
          session: { id, cwd: '/cold/workspace' },
          inheritedEventCount: 0,
          events,
        }),
      },
    },
  })
  harness.disk.set(CHECKPOINTS_PATH, cpLine('cold-1', 'session-cold', 4))
  harness.apply()
  const out = await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-cold', label: 'cold-1' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'rewound (cold): forked session-cold @ seq 4 -> child child-cold',
  )
  assert.equal(creates.length, 1)
  const [first, options] = creates[0]
  assert.equal(first, undefined)
  // 继承前缀 = events[0..seq]（inclusive），原样保留。
  assert.deepEqual(options.seed.slice(0, 5), events)
  // 前缀之后是 buildForkSeed 补的合成闭合事件：边界落在 step 中间，
  // 故必须补 session/end-seed + step/end + turn/end，否则子会话是**未闭合**的。
  assert.deepEqual(
    options.seed.slice(5).map((e) => e.type),
    ['session/end-seed', 'step/end', 'turn/end'],
  )
  assert.equal(options.inheritedEventCount, 5)
  assert.deepEqual(options.meta, {
    cwd: '/cold/workspace',
    parentSession: 'session-cold',
    isSeeded: true,
  })
})

test('agent_rewind cold path closes an open tail via buildForkSeed', async () => {
  // 与上一条成对：边界正好落在 turn/end 上时，buildForkSeed 只补 fork 切割标记，
  // 不再补 step/end + turn/end。这条是「热/冷两路径语义一致」的回归锚。
  const ts = '2026-01-01T00:00:00.000Z'
  const ev = (seq, type, data = {}) => ({ seq, type, data, time: ts })
  const events = [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'step/start', { step: 0 }),
    ev(2, 'turn/end', { turn: 0 }),
  ]
  const creates = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: () => undefined,
        create: (...args) => {
          creates.push(args)
          return { id: 'child-closed' }
        },
      },
      sessionQuery: {
        readSession: async (id) => ({
          session: { id },
          inheritedEventCount: 0,
          events,
        }),
      },
    },
  })
  harness.disk.set(CHECKPOINTS_PATH, cpLine('cold-closed', 'session-cold', 2))
  harness.apply()
  await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-cold', label: 'cold-closed' },
    { agent: rootAgent() },
  )
  const options = creates[0][1]
  assert.deepEqual(options.seed.slice(0, 3), events)
  assert.deepEqual(
    options.seed.slice(3).map((e) => e.type),
    ['session/end-seed'],
  )
  assert.equal(options.inheritedEventCount, 3)
})

test('agent_rewind cold path falls back to sessionPersistence.readFrom', async () => {
  const ts = '2026-01-01T00:00:00.000Z'
  const events = [{ seq: 0, type: 'turn/end', data: { turn: 0 }, time: ts }]
  const reads = []
  const creates = []
  const harness = makeHarness({
    services: {
      sessions: {
        get: () => undefined,
        create: (...args) => {
          creates.push(args)
          return { id: 'child-cold' }
        },
      },
      sessionQuery: undefined,
      sessionPersistence: {
        readFrom: async (sid, from) => {
          reads.push([sid, from])
          return { meta: { cwd: '/cold/ws' }, inheritedEventCount: 0, events }
        },
      },
    },
  })
  harness.disk.set(CHECKPOINTS_PATH, cpLine('cold-2', 'session-cold', 0))
  harness.apply()
  const out = await runTool(
    harness,
    'agent_rewind',
    { sessionId: 'session-cold', label: 'cold-2' },
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    'rewound (cold): forked session-cold @ seq 0 -> child child-cold',
  )
  assert.deepEqual(reads, [['session-cold', 0]])
  // 边界 0 = 整条日志只有 turn/end，buildForkSeed 只补 fork 切割标记。
  assert.deepEqual(creates[0][1].seed.slice(0, 1), [events[0]])
  assert.deepEqual(
    creates[0][1].seed.slice(1).map((e) => e.type),
    ['session/end-seed'],
  )
  assert.equal(creates[0][1].inheritedEventCount, 1)
})

test('agent_rewind refuses an out-of-range cold boundary', async () => {
  const harness = makeHarness({
    services: {
      sessions: { get: () => undefined },
      sessionQuery: {
        readSession: async (id) => ({
          session: { id },
          inheritedEventCount: 0,
          events: [{ type: 'turn/end', seq: 1 }],
        }),
      },
    },
  })
  harness.disk.set(CHECKPOINTS_PATH, cpLine('far', 'session-cold', 9))
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_rewind',
        { sessionId: 'session-cold', label: 'far' },
        { agent: rootAgent() },
      ),
    /boundary seq 9 out of range \(cold session session-cold has 1 events\)/,
  )
})

test('agent_rewind surfaces fork/create failures instead of returning a bogus child', async () => {
  const failing = makeHarness({
    services: {
      sessions: {
        get: (id) => (id === 'session-root' ? { id } : undefined),
        fork: () => {
          throw new Error('fork exploded')
        },
      },
    },
  })
  failing.disk.set(CHECKPOINTS_PATH, cpLine('m', 'session-root', 2))
  failing.apply()
  await assert.rejects(
    () =>
      runTool(
        failing,
        'agent_rewind',
        { sessionId: 'session-root', label: 'm' },
        { agent: rootAgent() },
      ),
    /agent_rewind: sessions\.fork\(session-root, 2\) failed: fork exploded/,
  )

  const empty = makeHarness({
    services: {
      sessions: {
        get: (id) => (id === 'session-root' ? { id } : undefined),
        fork: () => undefined,
      },
    },
  })
  empty.disk.set(CHECKPOINTS_PATH, cpLine('m', 'session-root', 2))
  empty.apply()
  await assert.rejects(
    () =>
      runTool(
        empty,
        'agent_rewind',
        { sessionId: 'session-root', label: 'm' },
        { agent: rootAgent() },
      ),
    /sessions\.fork\(session-root, 2\) returned no child session id/,
  )
})

test('agent_rewind validates label and sessionId before touching the file', async () => {
  const harness = makeHarness()
  harness.apply()
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_rewind',
        { sessionId: 's', label: '  ' },
        { agent: rootAgent() },
      ),
    /agent_rewind: label required/,
  )
  await assert.rejects(
    () =>
      runTool(
        harness,
        'agent_rewind',
        { sessionId: '', label: 'x' },
        { agent: rootAgent() },
      ),
    /agent_rewind: sessionId required/,
  )
})

// ── agent_checkpoint_list ─────────────────────────────────────────────────

test('agent_checkpoint_list lists only parseable current-format lines', async () => {
  const harness = makeHarness()
  harness.disk.set(
    CHECKPOINTS_PATH,
    '# 人工检查点\n\n' +
      cpLine('m1', 'session-a', 3, 'note one') +
      '- [2024-01-01T00:00:00.000Z] auto-turn | session=session-a | turn=1 | user: hi\n' +
      cpLine('m2', 'session-a', 7) +
      '散文：session=x | seq=9\n',
  )
  harness.apply()
  const out = await runTool(
    harness,
    'agent_checkpoint_list',
    {},
    { agent: rootAgent() },
  )
  assert.equal(
    out,
    '- m1 | session=session-a | seq=3 | note one\n- m2 | session=session-a | seq=7',
  )
})

test('agent_checkpoint_list reports emptiness for a missing or auto-only file', async () => {
  const missing = makeHarness()
  missing.apply()
  assert.equal(
    await runTool(missing, 'agent_checkpoint_list', {}, { agent: rootAgent() }),
    '(no checkpoints)',
  )

  const autoOnly = makeHarness()
  autoOnly.disk.set(
    CHECKPOINTS_PATH,
    '# 注释\n- [2024-01-01T00:00:00.000Z] auto-turn | session=a | turn=1 | user: hi\n',
  )
  autoOnly.apply()
  assert.equal(
    await runTool(
      autoOnly,
      'agent_checkpoint_list',
      {},
      { agent: rootAgent() },
    ),
    '(no checkpoints)',
  )
})

// ── 事件面：auto-checkpoint ──────────────────────────────────────────────

test('a root turn writes one auto-turn line with the single-lined user text', async () => {
  const resolvedPolicies = []
  const harness = makeHarness({
    services: {
      sandboxPolicy: {
        resolve: (arg) => {
          resolvedPolicies.push(arg)
          return { mode: 'workspace-write' }
        },
      },
    },
  })
  harness.apply()
  const agent = rootAgent({ id: 'session-root' })
  await harness.emitAsync('agent/inbox/claimed', {
    agent,
    turn: 3,
    message: {
      content: [{ type: 'text', text: '第一行\n第二行   多余  空白' }],
    },
  })
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 3 })

  const raw = harness.disk.content(CHECKPOINTS_PATH)
  assert.match(
    raw,
    /^- \[\d{4}-\d{2}-\d{2}T[^\]]+\] auto-turn \| session=session-root \| turn=3 \| user: 第一行 第二行 多余 空白\n$/,
  )
  assert.equal(raw.split('\n').filter(Boolean).length, 1)
  assert.deepEqual(resolvedPolicies, [{ session: agent.session }])
  // auto 行不是命名检查点：agent_checkpoint_list / 裁剪都看不到它。
  assert.equal(harness.disk.parsedCount(CHECKPOINTS_PATH), 0)
  assert.equal(
    await runTool(harness, 'agent_checkpoint_list', {}, { agent }),
    '(no checkpoints)',
  )
})

test('auto-checkpoint dedupes per turn and never mixes user text across turns', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent({ id: 'session-root' })
  await harness.emitAsync('agent/inbox/claimed', {
    agent,
    turn: 3,
    message: { content: [{ type: 'text', text: 'turn three' }] },
  })
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 3 })
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 3 })
  // turn 4 没有 claimed 文本 → 不得复用 turn 3 的文本。
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 4 })

  const lines = harness.disk
    .content(CHECKPOINTS_PATH)
    .split('\n')
    .filter(Boolean)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].endsWith('turn=3 | user: turn three'))
  assert.ok(lines[1].endsWith('turn=4 | user: (no user text)'))
})

test('auto-checkpoint truncates user text to 120 characters', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent()
  const long = 'x'.repeat(300)
  await harness.emitAsync('agent/inbox/claimed', {
    agent,
    turn: 1,
    message: { content: [{ type: 'text', text: long }] },
  })
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 1 })
  const line = harness.disk.content(CHECKPOINTS_PATH).split('\n')[0]
  assert.ok(line.endsWith(`user: ${long.slice(0, 120)}`))
  assert.ok(!line.endsWith(long))
})

test('auto-checkpoint serves root sessions only (absent or 0 depth)', async () => {
  const delegated = makeHarness()
  delegated.apply()
  const sub = rootAgent({ id: 'sub-1', depth: 1 })
  await delegated.emitAsync('agent/inbox/claimed', {
    agent: sub,
    turn: 1,
    message: { content: [{ type: 'text', text: 'sub work' }] },
  })
  await delegated.emitAsync('agent/turn-stopping', { agent: sub, turn: 1 })
  await delegated.emitAsync('agent/error', {
    agent: sub,
    turn: 1,
    error: new Error('boom'),
  })
  assert.equal(delegated.disk.has(CHECKPOINTS_PATH), false)

  // 真实 SessionHeader 根会话 delegationDepth 缺省 = 0：autoprobe/auto-checkpoint
  // 都必须照常工作（issue #3 的回归面）。
  const explicitZero = makeHarness()
  explicitZero.apply()
  const zero = rootAgent({ id: 'root-0', depth: 0 })
  await explicitZero.emitAsync('agent/turn-stopping', { agent: zero, turn: 1 })
  assert.equal(explicitZero.disk.has(CHECKPOINTS_PATH), true)
})

test('agent/error appends one deduped, single-lined auto-error line', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent({ id: 'session-root' })
  const longMessage = `boom\n  second   line ${'y'.repeat(300)}`
  await harness.emitAsync('agent/error', {
    agent,
    turn: 7,
    error: new Error(longMessage),
  })
  await harness.emitAsync('agent/error', {
    agent,
    turn: 7,
    error: new Error('again'),
  })

  const lines = harness.disk
    .content(CHECKPOINTS_PATH)
    .split('\n')
    .filter(Boolean)
  assert.equal(lines.length, 1)
  assert.match(
    lines[0],
    /auto-error \| session=session-root \| turn=7 \| boom second line y+$/,
  )
  assert.ok(!lines[0].includes('\n'))
})

test('an auto-checkpoint write failure only warns and never fails the turn', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const harness = makeHarness()
  harness.apply()
  harness.disk.hooks.write.push(() => {
    throw fsError('FS_PERMISSION_DENIED', 'telemetry path is read-only')
  })
  await harness.emitAsync('agent/turn-stopping', {
    agent: rootAgent(),
    turn: 1,
  })
  assert.equal(warn.mock.callCount(), 1)
  assert.match(
    String(warn.mock.calls[0].arguments[0]),
    /\[dsh-agent-rewind\] auto-checkpoint append failed: FS_PERMISSION_DENIED/,
  )
})

test('auto-checkpoint skips a session without cwd without throwing', async () => {
  const harness = makeHarness()
  harness.apply()
  const agent = rootAgent()
  delete agent.session.header.cwd
  await harness.emitAsync('agent/turn-stopping', { agent, turn: 1 })
  await harness.emitAsync('agent/error', {
    agent,
    turn: 1,
    error: new Error('x'),
  })
  assert.equal(harness.disk.has(CHECKPOINTS_PATH), false)
})

// ── 真实 node:fs 适配器：同一段 plugin 代码跑在真文件上 ────────────────────
// makeNodeDisk 由 harness-mocks.mjs 提供（两个测试文件共用同一份实现）。

test('real filesystem: checkpoint/list/prune land in <cwd>/.dsh/memory/checkpoints.md', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mop-runtime-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = makeHarness({ disk: makeNodeDisk() })
  harness.apply({ maxCheckpoints: 1 })
  const agent = rootAgent({ id: 'session-root', cwd: dir, events: EVENTS })
  const file = join(dir, '.dsh', 'memory', 'checkpoints.md')

  assert.equal(
    await runTool(harness, 'agent_checkpoint', { label: 'first' }, { agent }),
    'checkpoint OK: first @ session session-root seq 6',
  )
  assert.match(
    readFileSync(file, 'utf8'),
    /first \| session=session-root \| seq=6/,
  )

  assert.equal(
    await runTool(harness, 'agent_checkpoint', { label: 'second' }, { agent }),
    'checkpoint OK: second @ session session-root seq 6; pruned 1 oldest',
  )
  const raw = readFileSync(file, 'utf8')
  assert.ok(!raw.includes('first'))
  assert.match(raw, /second \| session=session-root \| seq=6/)
  assert.equal(
    await runTool(harness, 'agent_checkpoint_list', {}, { agent }),
    '- second | session=session-root | seq=6',
  )
})

test('real filesystem: a hand-edited file without trailing newline stays parseable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mop-runtime-tail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, '.dsh', 'memory', 'checkpoints.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, cpLine('hand', 'session-root', 1).trimEnd())

  const harness = makeHarness({ disk: makeNodeDisk() })
  harness.apply()
  const agent = rootAgent({ id: 'session-root', cwd: dir, events: EVENTS })
  await runTool(harness, 'agent_checkpoint', { label: 'after-hand' }, { agent })

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.equal(ledger.parseCheckpointLine(lines[0]).label, 'hand')
  assert.equal(ledger.parseCheckpointLine(lines[1]).label, 'after-hand')
})
