import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../packages/dsh-miopiik-executor/index.js')

// 新契约下任何 spawn 都应显式带 model+provider（零默认零兜底）。
const EXEC_MODEL = { model: 'mimo-v2.5', provider: 'opencode-go' }

function makeRun(
  id,
  result,
  { onDispose = async () => {} } = {},
) {
  return {
    id,
    result: Promise.resolve(result),
    dispose: onDispose,
  }
}

function makeCtx() {
  const registered = []
  const starts = []
  const disposals = []
  const ctx = {
    tools: {
      register: (tool) => {
        registered.push(tool)
      },
      get: (name) => registered.find((t) => t.name === name),
    },
    subagents: {
      start: async (name, request) => {
        starts.push({ name, request })
        return makeRun(
          'exec-session-1',
          {
            stopReason: 'completed',
            output: [{ type: 'text', text: 'done' }],
          },
          { onDispose: async () => disposals.push('exec-session-1') },
        )
      },
    },
  }
  return { ctx, registered, starts, disposals }
}

function getTool(ctx, registered) {
  apply(ctx)
  return registered.find((t) => t.name === 'mop_spawn_executor')
}

// ── 新模型解析契约（反馈 #1 核心修复）────────────────────────────────────────

test('explicit model+provider are passed through directly', async () => {
  const { ctx, registered, starts } = makeCtx()
  const tool = getTool(ctx, registered)
  await tool.execute(
    { prompt: 'task', model: 'opencode-go/hy3', provider: 'opencode-go' },
    { agent: { session: { id: 's1' } }, signal: 'SIG' },
  )
  assert.equal(starts[0].request.agentOptions.provider, 'opencode-go')
  assert.equal(starts[0].request.agentOptions.model, 'opencode-go/hy3')
})

test('only model given throws (no provider/model hybrid)', async () => {
  const { ctx, registered } = makeCtx()
  const tool = getTool(ctx, registered)
  await assert.rejects(
    () =>
      tool.execute(
        { prompt: 'task', model: 'mimo-v2.5' },
        { agent: { session: { id: 's1' } } },
      ),
    /model 与 provider 必须同时给出或同时省略/,
  )
})

test('only provider given throws (no provider/model hybrid)', async () => {
  const { ctx, registered } = makeCtx()
  const tool = getTool(ctx, registered)
  await assert.rejects(
    () =>
      tool.execute(
        { prompt: 'task', provider: 'opencode-go' },
        { agent: { session: { id: 's1' } } },
      ),
    /model 与 provider 必须同时给出或同时省略/,
  )
})

test('neither given throws — no default, no policy-file lookup, no inheritance', async () => {
  const { ctx, registered, starts } = makeCtx()
  const tool = getTool(ctx, registered)
  await assert.rejects(
    () =>
      tool.execute({ prompt: 'task' }, { agent: { session: { id: 's1' } } }),
    /无默认模型、不读 model-policy.md、不继承调用者/,
  )
  assert.equal(starts.length, 0, 'must not spawn anything')
})

test("model='inherit' is rejected (inheritance channel removed)", async () => {
  const { ctx, registered, starts } = makeCtx()
  const tool = getTool(ctx, registered)
  await assert.rejects(
    () =>
      tool.execute(
        { prompt: 'task', model: 'inherit', provider: 'opencode-go' },
        { agent: { session: { id: 's1' } } },
      ),
    /model="inherit" 通道已移除/,
  )
  await assert.rejects(
    () =>
      tool.execute(
        { prompt: 'task', model: 'inherit' },
        { agent: { session: { id: 's1' } } },
      ),
    /model="inherit" 通道已移除/,
  )
  assert.equal(starts.length, 0, 'must not spawn anything')
})

// ── 非模型契约回归（均显式带 model+provider）──────────────────────────────

test('mop_spawn_executor passes model + toolFilter and returns output', async () => {
  const { ctx, registered, starts, disposals } = makeCtx()
  const tool = getTool(ctx, registered)
  const result = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } }, signal: 'SIG' },
  )
  assert.match(result, /completed/)
  assert.match(result, /done/)
  assert.match(result, /\[executor-session: exec-session-1\]/)
  assert.equal(starts[0].name, 'spawn')
  assert.equal(starts[0].request.agentOptions.model, 'mimo-v2.5')
  assert.equal(starts[0].request.agentOptions.provider, 'opencode-go')
  assert.ok(starts[0].request.signal instanceof AbortSignal)
  assert.equal(starts[0].request.signal.aborted, false)
  assert.equal(starts[0].request.maxDepth, 1)
  assert.deepEqual(starts[0].request.toolFilter.allow, [
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'bash',
    'todo_write',
  ])
  assert.deepEqual(disposals, ['exec-session-1'])
})

test('maxDepth is absolute-parent+1: planner (depth 1) can spawn executors', async () => {
  const { ctx, registered, starts } = makeCtx()
  const tool = getTool(ctx, registered)
  await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { header: { id: 'p1', delegationDepth: 1 } } } },
  )
  assert.equal(starts[0].request.maxDepth, 2)
  await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { header: { id: 'p2', delegationDepth: 2 } } } },
  )
  assert.equal(starts[1].request.maxDepth, 3)
})

test('long output is truncated with a pointer to the executor session', async () => {
  const { ctx, registered } = makeCtx()
  ctx.subagents.start = async () =>
    makeRun('exec-session-1', {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'x'.repeat(9000) }],
    })
  const tool = getTool(ctx, registered)
  const result = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } }, signal: 'SIG' },
  )
  assert.match(result, /output truncated at 4000 chars/)
  assert.ok(result.length < 5000)
})

test('emoji in executor output is stripped structurally', async () => {
  const { ctx, registered } = makeCtx()
  ctx.subagents.start = async () =>
    makeRun('exec-session-1', {
      stopReason: 'completed',
      output: [{ type: 'text', text: '完成 🚀 改了 a.js ✅' }],
    })
  const tool = getTool(ctx, registered)
  const result = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } }, signal: 'SIG' },
  )
  assert.doesNotMatch(result, /🚀/)
  assert.doesNotMatch(result, /✅/)
  assert.match(result, /完成\s+改了 a\.js/)
})

test('timeoutMs aborts the child and returns an [aborted] timeout with session id', async () => {
  const { ctx, registered, starts } = makeCtx()
  ctx.subagents.start = async (name, request) => {
    starts.push({ name, request })
    const result = new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => resolve({ stopReason: 'aborted', output: [] }),
        { once: true },
      )
    })
    return makeRun('exec-session-1', result)
  }
  const tool = getTool(ctx, registered)
  const result = await tool.execute(
    { prompt: 'task', timeoutMs: 20, ...EXEC_MODEL },
    { agent: { session: { id: 's1' } } },
  )
  assert.match(result, /\[aborted\] executor timed out after 20ms/)
  assert.match(result, /\[executor-session: exec-session-1\]/)
  assert.equal(starts[0].request.signal.aborted, true)
})

test('timeout before publication with a rejecting start returns timeout (no hang)', async () => {
  const { ctx, registered, starts } = makeCtx()
  ctx.subagents.start = async (name, request) => {
    starts.push({ name, request })
    await new Promise((_resolve, reject) => {
      request.signal.addEventListener(
        'abort',
        () => reject(new Error('start aborted before publication')),
        { once: true },
      )
    })
    return makeRun('never', { stopReason: 'completed', output: [] })
  }
  const tool = getTool(ctx, registered)
  const result = await tool.execute(
    { prompt: 'task', timeoutMs: 20, ...EXEC_MODEL },
    { agent: { session: { id: 's1' } } },
  )
  assert.match(
    result,
    /\[aborted\] executor timed out after 20ms before the child was published/,
  )
})

test('already-aborted caller signal short-circuits before spawning', async () => {
  const { ctx, registered, starts } = makeCtx()
  const tool = getTool(ctx, registered)
  const caller = new AbortController()
  caller.abort(new Error('user cancelled'))
  const result = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } }, signal: caller.signal },
  )
  assert.match(result, /\[aborted\] executor cancelled/)
  assert.equal(starts.length, 0)
})

test('caller cancellation during the run is distinguished from timeout', async () => {
  const { ctx, registered, starts } = makeCtx()
  ctx.subagents.start = async (name, request) => {
    starts.push({ name, request })
    const result = new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => resolve({ stopReason: 'aborted', output: [] }),
        { once: true },
      )
    })
    return makeRun('exec-session-1', result)
  }
  const tool = getTool(ctx, registered)
  const caller = new AbortController()
  const pending = tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } }, signal: caller.signal },
  )
  caller.abort(new Error('user cancelled'))
  const result = await pending
  assert.match(result, /\[aborted\] executor cancelled/)
  assert.doesNotMatch(result, /timed out/)
})

test('timeoutMs rejects non-finite / non-positive values', async () => {
  const { ctx, registered } = makeCtx()
  const tool = getTool(ctx, registered)
  for (const bad of [0, -5, Number.NaN]) {
    await assert.rejects(
      () =>
        tool.execute(
          { prompt: 'task', timeoutMs: bad, ...EXEC_MODEL },
          { agent: { session: { id: 's1' } } },
        ),
      /timeoutMs 必须为有限正数/,
    )
  }
})

test('Config.strict=true drops bash/write from the executor tool face (edit kept)', async () => {
  const { ctx, registered, starts } = makeCtx()
  apply(ctx, { strict: true })
  const tool = registered.find((t) => t.name === 'mop_spawn_executor')
  await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } } },
  )
  assert.deepEqual(starts[0].request.toolFilter.allow, [
    'read',
    'glob',
    'grep',
    'edit',
    'todo_write',
  ])
})

// ── B1 真因回归：子代理以失败态 resolve（stopReason='error'）而非 reject ──────

test('stopReason=error 结果返回可读失败文案（子会话 id + 原因/指引）', async () => {
  const { ctx, registered } = makeCtx()
  ctx.subagents.start = async () =>
    makeRun('exec-session-fail-1', {
      stopReason: 'error',
      output: [],
    })
  apply(ctx)
  const tool = registered.find((t) => t.name === 'mop_spawn_executor')
  const out = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } } },
  )
  assert.match(
    out,
    /\[error\] executor 子代理失败（stopReason=error，见子会话 exec-session-fail-1）/,
  )
  assert.match(out, /见子会话日志（常见：模型闸拒绝、深度超限、工具限制）/)
})

test('stopReason=error 且 result.error.message 存在时原样拼入', async () => {
  const { ctx, registered } = makeCtx()
  ctx.subagents.start = async () =>
    makeRun('exec-session-fail-2', {
      stopReason: 'error',
      output: [],
      error: {
        message: 'dsh-miopiik-model-auth: 请求未授权模型 opencode-go/hy3（…）',
      },
    })
  apply(ctx)
  const tool = registered.find((t) => t.name === 'mop_spawn_executor')
  const out = await tool.execute(
    { prompt: 'task', ...EXEC_MODEL },
    { agent: { session: { id: 's1' } } },
  )
  assert.match(out, /请求未授权模型 opencode-go\/hy3/)
  assert.match(out, /exec-session-fail-2/)
})
