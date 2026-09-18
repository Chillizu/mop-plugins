import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const { apply } = await import('../packages/dsh-miopiik-recall/index.js')

const CWD = '/home/data/Projects/some-project'
const SLUG = '--home-data-Projects-some-project--'
const SESSION_A = 'session-aaaa-1111-2222-3333-444444444444'
const SESSION_B = 'session-bbbb-1111-2222-3333-444444444444'

async function hasZstd() {
  try {
    await execFileAsync('zstd', ['--version'])
    return true
  } catch {
    return false
  }
}

// fixture 行：直接照抄真实会话日志的 user/message 与 assistant/message 事件形状。
function ev(type, time, text) {
  return JSON.stringify({
    type,
    time,
    seq: 0,
    data: { content: [{ type: 'text', text }] },
  })
}

async function makeSessionDir(root, sessionId, lines) {
  const dir = join(root, SLUG, sessionId)
  await mkdir(dir, { recursive: true })
  const plain = join(dir, 'session.jsonl')
  await writeFile(plain, lines.join('\n') + '\n', 'utf8')
  const zstd = join(dir, 'session.jsonl.zstd')
  await execFileAsync('zstd', ['-q', '-f', '-o', zstd, plain])
  return zstd
}

function makeCtx() {
  const registered = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
  }
  return { ctx, registered }
}

function makeNativeCtx({ sessions = [], eventsBySession = {} } = {}) {
  const registered = []
  const calls = { filterSessions: [], filterEvents: [] }
  const sessionQuery = {
    async filterSessions(filters, signal) {
      calls.filterSessions.push({ filters, signal })
      return sessions
    },
    async filterEvents(sessionId, filters) {
      calls.filterEvents.push({ sessionId, filters })
      return eventsBySession[sessionId] || []
    },
  }
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined),
  }
  return { ctx, registered, calls }
}

test('mop_recall 默认优先走 native sessionQuery workspace filters', async () => {
  const { ctx, registered, calls } = makeNativeCtx({
    sessions: [
      { header: { id: 'session-native-a', cwd: CWD } },
      { header: { id: 'session-native-b', cwd: CWD } },
    ],
    eventsBySession: {
      'session-native-a': [
        {
          sessionId: 'session-native-a',
          seq: 2,
          type: 'user/message',
          time: Date.parse('2026-08-01T00:00:00.000Z'),
          text: 'portal native user hit',
        },
      ],
      'session-native-b': [
        {
          sessionId: 'session-native-b',
          seq: 4,
          type: 'assistant/message',
          time: Date.parse('2026-08-02T00:01:00.000Z'),
          text: 'portal native assistant hit',
        },
      ],
    },
  })
  apply(ctx, { sessionsRoot: '/path/that/does/not/exist' })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'portal', scope: 'workspace' },
    {
      agent: { session: { header: { id: 'session-current', cwd: CWD } } },
      signal: new AbortController().signal,
    },
  )

  assert.match(out, /sources=sessionQuery/)
  assert.match(out, /scanned=2, matched=2, skipped=0/)
  assert.match(out, /native-a USER: portal native user hit/)
  assert.match(out, /native-b ASSISTANT: portal native assistant hit/)
  assert.deepEqual(calls.filterSessions[0].filters, [
    { kind: 'cwd', values: [CWD] },
  ])
  assert.equal(calls.filterEvents.length, 2)
  for (const call of calls.filterEvents) {
    assert.deepEqual(call.filters, [
      {
        kind: 'type',
        values: ['user/message', 'assistant/message'],
      },
      { kind: 'text', text: 'portal' },
    ])
  }
})

test('mop_recall native scope=session 不枚举 workspace', async () => {
  const { ctx, registered, calls } = makeNativeCtx({
    eventsBySession: {
      'session-current': [
        {
          sessionId: 'session-current',
          seq: 1,
          type: 'assistant/message',
          time: Date.parse('2026-08-03T00:00:00.000Z'),
          text: 'needle native current',
        },
      ],
    },
  })
  apply(ctx)
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'needle', scope: 'session' },
    {
      agent: { session: { header: { id: 'session-current', cwd: CWD } } },
    },
  )

  assert.equal(calls.filterSessions.length, 0)
  assert.equal(calls.filterEvents.length, 1)
  assert.equal(calls.filterEvents[0].sessionId, 'session-current')
  assert.match(out, /scanned=1, matched=1/)
  assert.match(out, /current ASSISTANT: needle native current/)
})

test('mop_recall native maxLines 保持全局截断语义', async () => {
  const { ctx, registered, calls } = makeNativeCtx({
    sessions: [
      { header: { id: 'session-a', cwd: CWD } },
      { header: { id: 'session-b', cwd: CWD } },
    ],
    eventsBySession: {
      'session-a': Array.from({ length: 4 }, (_, index) => ({
        sessionId: 'session-a',
        seq: index,
        type: 'assistant/message',
        time: Date.parse('2026-08-04T00:00:00.000Z') + index,
        text: `needle native ${index}`,
      })),
      'session-b': [
        {
          sessionId: 'session-b',
          seq: 0,
          type: 'assistant/message',
          time: Date.parse('2026-08-05T00:00:00.000Z'),
          text: 'needle should not be reached',
        },
      ],
    },
  })
  apply(ctx)
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'needle', maxLines: 3 },
    { agent: { session: { header: { cwd: CWD } } } },
  )

  assert.match(out, /matched=3/)
  assert.match(out, /truncated at 3 lines/)
  assert.equal(calls.filterEvents.length, 1)
  assert.doesNotMatch(out, /should not be reached/)
})

test('mop_recall caseSensitive=true 明确绕过 native seam', async () => {
  const { ctx, registered, calls } = makeNativeCtx({
    sessions: [{ header: { id: 'session-native-a', cwd: CWD } }],
  })
  apply(ctx, { sessionsRoot: '/no/native-case-sensitive-logs' })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'PortalCase', caseSensitive: true },
    { agent: { session: { header: { cwd: CWD } } } },
  )

  assert.equal(calls.filterSessions.length, 0)
  assert.equal(calls.filterEvents.length, 0)
  assert.match(out, /caseSensitive=true/)
  assert.match(out, /\(no hits\)/)
})

test('mop_recall native seam 失败时回退 legacy scanner', async () => {
  const registered = []
  let nativeCalls = 0
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    get: (name) =>
      name === 'sessionQuery'
        ? {
            filterSessions: async () => {
              nativeCalls += 1
              throw new Error('native seam unavailable')
            },
            filterEvents: async () => [],
          }
        : undefined,
  }
  apply(ctx, { sessionsRoot: '/no/fallback-logs' })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'fallback' },
    { agent: { session: { header: { cwd: CWD } } } },
  )

  assert.equal(nativeCalls, 1)
  assert.match(out, /sources=\/no\/fallback-logs/)
  assert.match(out, /\(no hits\)/)
})

test('mop_recall 工作目录级命中并标注会话/角色/时间', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  const linesA = [
    ev('user/message', '2026-08-01T00:00:00.000Z', '合约 A 定义 portal 契约'),
    ev(
      'assistant/message',
      '2026-08-01T00:01:00.000Z',
      '已冻结契约：portal v1',
    ),
  ]
  const linesB = [
    ev('user/message', '2026-08-02T00:00:00.000Z', '无关内容'),
    ev(
      'assistant/message',
      '2026-08-02T00:01:00.000Z',
      'portal 验收门 PASS（带偶发 token 采集）',
    ),
  ]
  await makeSessionDir(root, SESSION_A, linesA)
  await makeSessionDir(root, SESSION_B, linesB)

  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'portal', scope: 'workspace' },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(out, /recall "portal"/)
  assert.match(out, /scanned=2, matched=3, skipped=0/)
  assert.match(
    out,
    /aaaa-1111-2222-3333-444444444444 USER: 合约 A 定义 portal 契约/,
  )
  assert.match(
    out,
    /aaaa-1111-2222-3333-444444444444 ASSISTANT: 已冻结契约：portal v1/,
  )
  assert.match(
    out,
    /bbbb-1111-2222-3333-444444444444 ASSISTANT: portal 验收门 PASS/,
  )
})

test('mop_recall scope=session 只扫当前会话', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  await makeSessionDir(root, SESSION_A, [
    ev('assistant/message', '2026-08-01T00:01:00.000Z', '本会话含 needle-x'),
  ])
  await makeSessionDir(root, SESSION_B, [
    ev('assistant/message', '2026-08-02T00:01:00.000Z', '他会话含 needle-x'),
  ])
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'needle-x', scope: 'session' },
    {
      agent: {
        session: {
          header: { id: SESSION_A.slice('session-'.length), cwd: CWD },
        },
      },
    },
  )
  assert.match(out, /scanned=1, matched=1, skipped=0/)
  assert.match(out, /本会话含 needle-x/)
  assert.doesNotMatch(out, /他会话含 needle-x/)
})

test('mop_recall 大小写不敏感默认，caseSensitive=true 精确', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  await makeSessionDir(root, SESSION_A, [
    ev(
      'assistant/message',
      '2026-08-01T00:01:00.000Z',
      'PortalCase 混合大小写',
    ),
  ])
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const ci = await tool.execute(
    { query: 'portalcase' },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(ci, /matched=1/)
  const cs = await tool.execute(
    { query: 'PortalCase', caseSensitive: true },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(cs, /matched=1/)
  const csMiss = await tool.execute(
    { query: 'portalcase', caseSensitive: true },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(csMiss, /matched=0/)
})

test('mop_recall 空 query 抛错', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx)
  const tool = registered.find((x) => x.name === 'mop_recall')
  await assert.rejects(
    () =>
      tool.execute(
        { query: '  ' },
        { agent: { session: { header: { cwd: CWD } } } },
      ),
    /query 必填/,
  )
})

test('mop_recall 无会话记录返回 no hits 不崩', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'anything' },
    { agent: { session: { header: { cwd: '/no/such/project' } } } },
  )
  assert.match(out, /scanned=0, matched=0/)
  assert.match(out, /\(no hits\)/)
})

test('mop_recall 忽略非消息事件（tool 事件不参与匹配）', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  await makeSessionDir(root, SESSION_A, [
    ev(
      'assistant/message',
      '2026-08-01T00:01:00.000Z',
      '真实消息含 target-abc',
    ),
    JSON.stringify({
      type: 'tool/result',
      time: '2026-08-01T00:02:00.000Z',
      data: { content: 'tool 结果也含 target-abc 但不该被 recall' },
    }),
  ])
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'target-abc' },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(out, /matched=1/)
  assert.doesNotMatch(out, /不该被 recall/)
})

test('mop_recall scope=session 容忍带 session- 前缀的完整 SessionId（R4c 回归）', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  await makeSessionDir(root, SESSION_A, [
    ev(
      'assistant/message',
      '2026-08-01T00:01:00.000Z',
      '前缀会话含 needle-pfx',
    ),
  ])
  await makeSessionDir(root, SESSION_B, [
    ev('assistant/message', '2026-08-02T00:01:00.000Z', '他会话含 needle-pfx'),
  ])
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  // header.id 用生产形态：带 'session-' 前缀的完整 id——0.1.9 验收 R4c 恒空现场。
  const out = await tool.execute(
    { query: 'needle-pfx', scope: 'session' },
    { agent: { session: { header: { id: SESSION_A, cwd: CWD } } } },
  )
  assert.match(out, /scanned=1, matched=1, skipped=0/)
  assert.match(out, /前缀会话含 needle-pfx/)
  assert.doesNotMatch(out, /他会话含 needle-pfx/)
})

test('mop_recall 达到 maxLines 提前终止并标注 truncated', async (t) => {
  if (!(await hasZstd())) return t.skip('zstd CLI 不可用')
  const root = await mkdtemp(join(tmpdir(), 'recall-'))
  const lines = Array.from({ length: 20 }, (_, i) =>
    ev(
      'assistant/message',
      `2026-08-01T00:0${i % 10}:00.000Z`,
      `needle-line-${i}`,
    ),
  )
  await makeSessionDir(root, SESSION_A, lines)
  const { ctx, registered } = makeCtx()
  apply(ctx, { sessionsRoot: root })
  const tool = registered.find((x) => x.name === 'mop_recall')
  const out = await tool.execute(
    { query: 'needle-line', maxLines: 5 },
    { agent: { session: { header: { cwd: CWD } } } },
  )
  assert.match(out, /matched=5/)
  assert.match(out, /truncated at 5 lines/)
  assert.match(out, /needle-line-4/)
  assert.doesNotMatch(out, /needle-line-9/)
})
