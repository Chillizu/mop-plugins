import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../packages/dsh-miopiik-run-stats/index.js')

function captureTool(services) {
  let tool
  const available = {
    sessionQuery: {
      readSession: async (id) => ({
        session: { id },
        inheritedEventCount: 0,
        events: [],
      }),
    },
    ...services,
  }
  const ctx = {
    get: (name) => available[name],
    tools: { register: (t) => (tool = t) },
  }
  apply(ctx)
  return tool
}

const BUCKETS = {
  uncachedInputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 0,
}

const ZERO = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

test('live-first: 从 live session 快照读取精确桶', async () => {
  const tool = captureTool({
    sessions: { get: (id) => (id === 's-1' ? { id: 's-1' } : undefined) },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: 3, values: { tokenUsage: BUCKETS } }),
    },
  })
  const result = await tool.execute({ sessionId: 's-1' })
  assert.deepEqual(JSON.parse(result), {
    sessionId: 's-1',
    asOfSeq: 3,
    uncachedInputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalInputTokens: 12,
    totalOutputTokens: 5,
  })
})

test('cold 兜底: live 缺失时走 coldSnapshot 且使用 sessionQuery 读取的日志', async () => {
  let seen
  const tool = captureTool({
    sessions: { get: () => undefined },
    sessionProjectionCache: {
      coldSnapshot: async (meta, inheritedEventCount, events) => {
        seen = { meta, inheritedEventCount, events }
        return { asOfSeq: 7, values: { tokenUsage: BUCKETS } }
      },
    },
  })
  const result = await tool.execute({ sessionId: 'cold-9' })
  assert.deepEqual(seen, {
    meta: { id: 'cold-9' },
    inheritedEventCount: 0,
    events: [],
  })
  assert.deepEqual(JSON.parse(result), {
    sessionId: 'cold-9',
    asOfSeq: 7,
    uncachedInputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalInputTokens: 12,
    totalOutputTokens: 5,
  })
})

test('tokenUsage 键缺失（tokenMeter 未挂载）→ 报错', async () => {
  const tool = captureTool({
    sessions: { get: () => undefined },
    sessionProjectionCache: {
      coldSnapshot: async () => ({ asOfSeq: -1, values: {} }),
    },
  })
  await assert.rejects(
    () => tool.execute({ sessionId: 's-1' }),
    /tokenUsage 投影不可用（tokenMeter 未挂载）/,
  )
})

// P3-7 回归（issue #3）：live 会话 tokenUsage 缺失时，旧代码会掉进 cold 兜底，
// coldSnapshot 一 reject 就把「tokenMeter 未挂载」误诊为「不存在或未持久化」。
test('live 会话 tokenUsage 缺失 → 不转 cold、正确报 tokenMeter 未挂载', async () => {
  let coldCalled = false
  const tool = captureTool({
    sessions: { get: (id) => (id === 's-live' ? { id: 's-live' } : undefined) },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: 5, values: {} }), // tokenMeter 未挂载
    },
    sessionProjectionCache: {
      coldSnapshot: async () => {
        coldCalled = true
        throw new Error('not found')
      },
    },
  })
  await assert.rejects(
    () => tool.execute({ sessionId: 's-live' }),
    /tokenUsage 投影不可用（tokenMeter 未挂载）/,
  )
  assert.equal(coldCalled, false, 'live 会话不得走 cold 兜底')
})

test('session 不存在/未持久化（coldSnapshot reject）→ 报错', async () => {
  const tool = captureTool({
    sessions: { get: () => undefined },
    sessionProjectionCache: {
      coldSnapshot: async () => {
        throw new Error('not found')
      },
    },
  })
  await assert.rejects(
    () => tool.execute({ sessionId: 'gone' }),
    /session gone 不存在或未持久化/,
  )
})

test('空 sessionId → 报错', async () => {
  const tool = captureTool({})
  await assert.rejects(
    () => tool.execute({ sessionId: '   ' }),
    /sessionId 必填/,
  )
})

test('全零桶不是错误：返回零值（门判 INCONCLUSIVE）', async () => {
  const tool = captureTool({
    sessions: { get: () => undefined },
    sessionProjectionCache: {
      coldSnapshot: async () => ({ asOfSeq: -1, values: { tokenUsage: ZERO } }),
    },
  })
  const result = await tool.execute({ sessionId: 'empty' })
  assert.deepEqual(JSON.parse(result), {
    sessionId: 'empty',
    asOfSeq: -1,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  })
})

test('输出键序稳定（contract anchor）', async () => {
  const tool = captureTool({
    sessions: { get: () => undefined },
    sessionProjectionCache: {
      coldSnapshot: async () => ({
        asOfSeq: 3,
        values: { tokenUsage: BUCKETS },
      }),
    },
  })
  const result = await tool.execute({ sessionId: 's-1' })
  const keys = Object.keys(JSON.parse(result))
  assert.deepEqual(keys, [
    'sessionId',
    'asOfSeq',
    'uncachedInputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'totalInputTokens',
    'totalOutputTokens',
  ])
})

test('token 桶非有限非负数值 → 报错（不污染求和）', async () => {
  for (const bad of [Number.NaN, -1, '100']) {
    const tool = captureTool({
      sessions: { get: () => undefined },
      sessionProjectionCache: {
        coldSnapshot: async () => ({
          asOfSeq: 3,
          values: { tokenUsage: { ...BUCKETS, outputTokens: bad } },
        }),
      },
    })
    await assert.rejects(
      () => tool.execute({ sessionId: 's-1' }),
      /tokenUsage\.outputTokens 非有限非负数值/,
      `bucket=${String(bad)} 应报错`,
    )
  }
})
