// 会话替身的契约校验：在**无 stub** 的独立 Node 进程里对真实 `Session` 类实测断言。
//
// 为什么单独一个文件：`npm test` 通过 test/register-mocks.mjs 把 `@deepseek-ai/dsh-llm`
// 换成 stub，而真实 `@deepseek-ai/dsh-session` 需要该模块的 `callConfigEquals`——两者
// 不能在同一进程共存。所以这里不加载 register-mocks，直接加载真实类。
//
// 目的：钉死 harness 里 makeSessionLike 的契约，防止它再次「比现实更宽松」。
// 历史事故：替身曾暴露 `.events`，而真实 Session 没有该公开属性，于是
// 「读 live 会话事件流」的缺陷一路绿灯，生产上直接报
// "agent_checkpoint: event stream of session ... unavailable"。
//
// 用法：node test/session-contract.mjs   （exit 0 = 契约成立）
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'

import { makeSessionLike } from './harness-mocks.mjs'

const T = 1_700_000_000_000
const events = [
  { seq: 0, type: 'turn/start', time: T, data: { turn: 0 } },
  { seq: 1, type: 'turn/end', time: T + 1, data: { turn: 0 } },
]

// ── 1) 真实 Session 的可观测面 ──
const real = Session.create('session-contract', events)

assert.equal(
  typeof real.snapshotEvents,
  'function',
  '真实 Session 必须提供 snapshotEvents()；替身依据此契约',
)
assert.ok(
  Array.isArray(real.snapshotEvents()),
  '真实 Session.snapshotEvents() 必须返回数组',
)
assert.equal(
  real.events,
  undefined,
  '真实 Session 不得暴露 .events —— 替身若提供它就会掩盖缺陷',
)

// ── 2) 替身必须满足同一契约 ──
const double = makeSessionLike('session-contract', events, {
  id: 'session-contract',
})

assert.equal(
  typeof double.snapshotEvents,
  'function',
  '替身与真实 Session 一样必须提供 snapshotEvents()',
)
assert.deepEqual(
  double.snapshotEvents(),
  events,
  '替身 snapshotEvents() 必须返回传入的事件',
)
assert.equal(
  double.events,
  undefined,
  '替身不得暴露 .events —— 这正是历史事故的根因',
)

// ── 3) 替身产物必须能被插件真正读出来（端到端契约，不只是形状） ──
const { liveSessionEvents, lastTurnEndSeq } =
  await import('../packages/dsh-agent-rewind/index.js')
const read = liveSessionEvents(double)
assert.ok(Array.isArray(read), 'liveSessionEvents 必须能从替身读出事件数组')
assert.equal(
  lastTurnEndSeq(read),
  1,
  '从替身读出的事件流必须能定位最后一个 turn/end 的 seq',
)

console.log(
  'session contract OK: snapshotEvents() 存在、.events 缺位、插件可读',
)
