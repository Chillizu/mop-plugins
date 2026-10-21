import { defineTool } from '@deepseek-ai/dsh-tools'
// 冷路径 fork 必须复用 DSH 官方的种子构造：它负责补上未闭合尾巴的合成闭合事件。
// 导入路径与第一方 dsh-api-session-controller 完全一致（@deepseek-ai/dsh-session/fork）。
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'

/**
 * dsh-agent-rewind 的账本核心：命名恢复账本的纯逻辑、读写原语与三个模型可见工具。
 * 装配在 index.js；本文件从 dsh-session-policy 移动而来，除工具改名（去 agent_ 前缀）与
 * 消息前缀更新外，逻辑逐字未动。
 *
 * 模型可见工具 3 个：
 * - agent_checkpoint       命名检查点（含追加后按 maxCheckpoints 自动裁剪最旧行）
 * - agent_rewind           按命名检查点无损 fork 回退（热会话 / 冷会话两条路径）
 * - agent_checkpoint_list  列出可解析的现行 checkpoints.md 行
 *
 * 无工具面的事件驱动 auto-checkpoint（agent/inbox/claimed → turn-stopping /
 * error）也归本包，与命名检查点共用同一落点与同一追加原语。
 */

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** checkpoint 落点（D13）：项目 .dsh/memory/checkpoints.md，同包内写/读/裁剪三处必须同一路径。 */
export const CHECKPOINTS_REL_PATH = '.dsh/memory/checkpoints.md'

/**
 * 命名检查点现行格式：`- [ISO] label | session=<sid> | seq=<n> [| note]`。
 * 这是与既有 checkpoints.md 文件的兼容契约（历史文件必须继续可解析），
 * 也是 computePrune「只删可解析行」的判据，不得改动。
 */
const CHECKPOINT_LINE =
  /^- \[[^\]]*\] (.+?) \| session=(\S+) \| seq=(\d+)(?: \| (.*))?\s*$/

/** auto-turn / auto-error 行的用户文本与错误详情截断长度。 */
const AUTO_SUMMARY_CHARS = 120

/**
 * agent_checkpoint 追加后的自动裁剪阈值：现行 checkpoint 行数超过它时删最旧的若干条
 * （默认 200）。只裁可被 CHECKPOINT_LINE 解析的行；注释/空行/旧格式/散文永不删除。
 * 可用 apply(ctx, config) 的 config.maxCheckpoints 覆盖（正整数）。
 */
export const DEFAULT_MAX_CHECKPOINTS = 200

function msgOf(error) {
  return error && error.code
    ? String(error.code)
    : error && error.message
      ? error.message
      : String(error)
}

/**
 * 懒取可选 seam。有 ctx.get 走 ctx.get（缺失返回 undefined，不抛）；没有 ctx.get
 * 的组合（测试替身）退化为直接读属性，真实 Cordis 里读未 inject 的属性会抛错，
 * 因此这条兜底路径必须容忍异常并把「不可用」如实报成 undefined。
 */
function optionalSeam(ctx, seamName) {
  if (typeof ctx.get === 'function') return ctx.get(seamName)
  try {
    return ctx[seamName]
  } catch {
    return undefined
  }
}

export function resolveMaxCheckpoints(config) {
  const raw = config && config.maxCheckpoints
  if (raw === undefined) return DEFAULT_MAX_CHECKPOINTS
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `dsh-agent-rewind: maxCheckpoints must be a positive integer (got ${String(raw)})`,
    )
  }
  return raw
}

function textOfAutoBlock(block) {
  if (!block || typeof block !== 'object') return ''
  return block.type === 'text' ? block.text || '' : ''
}

function autoMessageText(content) {
  if (Array.isArray(content)) return content.map(textOfAutoBlock).join('')
  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
  )
    return content.text
  return ''
}

/**
 * 读一个会话的完整事件流。优先 DSH 0.1.7 的回放校验逻辑读
 * （sessionQuery.readSession），其次退回 sessionPersistence。
 *
 * 两条 seam 都不可用时抛明确错误而不是返回空事件流：空事件流会让调用方把
 * checkpoint 静默打到 seq 0（谎报边界），是必须避免的静默失败。
 * @param label - 调用工具名，用于错误消息前缀（agent_checkpoint / agent_rewind）。
 */
async function readAllEvents(ctx, sid, label) {
  const sessionQuery = optionalSeam(ctx, 'sessionQuery')
  const sessionPersistence = ctx.sessionPersistence
  if (typeof sessionQuery?.readSession === 'function') {
    try {
      const log = await sessionQuery.readSession(sid)
      return {
        meta: log.session,
        inheritedEventCount: log.inheritedEventCount,
        events: log.events,
      }
    } catch (error) {
      throw new Error(
        `${label}: cannot read session ${sid} via sessionQuery.readSession: ${msgOf(error)}`,
      )
    }
  }
  if (typeof sessionPersistence?.readFrom === 'function') {
    try {
      return await sessionPersistence.readFrom(sid, 0)
    } catch (error) {
      throw new Error(
        `${label}: cannot read session ${sid} via sessionPersistence.readFrom: ${msgOf(error)}`,
      )
    }
  }
  if (typeof sessionPersistence?.open === 'function') {
    let handle
    try {
      handle = await sessionPersistence.open(sid, 'read')
      const { events } = await handle.read(0)
      return {
        meta: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events,
      }
    } catch (error) {
      throw new Error(
        `${label}: cannot read session ${sid} via sessionPersistence.open: ${msgOf(error)}`,
      )
    } finally {
      if (handle) await handle.close()
    }
  }
  throw new Error(
    `${label}: session ${sid} is not live and neither sessionQuery.readSession nor a sessionPersistence read seam is available`,
  )
}

/** 归一化会话 id：补/去 `session-` 前缀，便于 `sessions.get` 命中。 */
export function normalizeSessionId(sessions, id) {
  const get =
    typeof sessions?.get === 'function'
      ? (value) => sessions.get(value)
      : () => undefined
  if (get(id)) return id
  if (!id.startsWith('session-') && get('session-' + id)) return 'session-' + id
  if (id.startsWith('session-') && get(id.slice('session-'.length)))
    return id.slice('session-'.length)
  return id
}

function stripSessionPrefix(id) {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/**
 * 两个会话 id 是否指同一会话。先按 live 注册表归一化（能区分 `abc` 与
 * `session-abc` 两个真实会话）；两侧都不在注册表（冷会话）时退化为前缀不敏感
 * 比对，满足「兼容 session- 前缀有无」——否则「checkpoint 记 session=abc、
 * 调用传 sessionId=session-abc」会被误判为归属不符而拒绝一次合法回溯。
 */
function sameSessionId(sessions, a, b) {
  if (a === b) return true
  if (normalizeSessionId(sessions, a) === normalizeSessionId(sessions, b))
    return true
  return stripSessionPrefix(a) === stripSessionPrefix(b)
}

/** 构造一条 checkpoint 行；与 {@link parseCheckpointLine} 互为 round-trip 契约。 */
export function formatCheckpointLine(label, sid, boundary, note) {
  const time = new Date().toISOString()
  return note
    ? `- [${time}] ${label} | session=${sid} | seq=${boundary} | ${note}\n`
    : `- [${time}] ${label} | session=${sid} | seq=${boundary}\n`
}

/** 解析一条 checkpoint 行；label 精确匹配（非子串），seq 为 inclusive 边界。 */
export function parseCheckpointLine(line) {
  const m = CHECKPOINT_LINE.exec(line)
  if (!m) return null
  return { label: m[1], session: m[2], seq: Number(m[3]), note: m[4] }
}

/** 会话事件流里最后一个 `turn/end` 的 seq；无则 0（fork 到空）。 */
export function lastTurnEndSeq(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'turn/end') return list[i].seq
  }
  return 0
}

/**
 * 读一个 live Session 的事件流。
 *
 * DSH 的 `Session` **没有** 公开的 `.events` 属性——事件只能通过
 * `snapshotEvents()`（或已弃用的 `ownEvents()`）取得。用 `session.events`
 * 会拿到 `undefined`，进而被误报成「会话不可用」。
 *
 * 为什么用这个已弃用的同步读、而不是只走 async 的 `sessionQuery.readSession`：
 * 持久化后端是**异步缓冲**的，durable log 可能落后于内存；而 checkpoint 要的是
 * 「**此刻**最后一个 turn/end」，慢一拍就会把边界记小、回溯到错的位置。故 live
 * 会话优先取内存快照，durable 读只作为会话不再 live 时的回落。
 *
 * @returns 事件数组；取不到时返回 `null`（调用方据此报错）。
 */
export function liveSessionEvents(session) {
  if (!session || typeof session !== 'object') return null
  const snapshot = session.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const events = snapshot.call(session)
      if (Array.isArray(events)) return events
    } catch {
      // 落到下面的兼容分支；两条都不行就返回 null，由调用方报错。
    }
  }
  // 兼容面：更早的 Session 形态曾暴露 `.events`。仅为兼容保留，正常 DSH 不走这里。
  return Array.isArray(session.events) ? session.events : null
}

/** 读文件内容；仅当文件不存在返回空串，权限等其它错误照常抛出。 */
async function readExisting(fs, target) {
  const stat = await fs.stat(target)
  return stat === undefined ? '' : await fs.readText(target)
}

/**
 * 原子追加一行到 checkpoint 文件：CAS（version）防并发会话写覆盖。
 * 冲突（FS_STALE_VERSION / FS_NOT_OBSERVED）重试，其余错误照常抛。
 */
// signal 透传（P3-10，issue #3）：工具被取消时 fs seam 应能随 exec.signal
// 中止写路径，而不是写一半状态不明的文件。
async function appendCheckpoint(fs, target, line, signal, policy, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await fs.stat(target)
    if (info === undefined) {
      try {
        await fs.writeText(
          target,
          line,
          { kind: 'createIfAbsent' },
          signal,
          policy,
        )
        return
      } catch (error) {
        if (error && error.code === 'FS_NOT_OBSERVED') continue // 并发创建竞争 → 重试
        throw error
      }
    }
    const prev = await fs.readText(target)
    // 兼容不以换行结尾的历史文件（人工编辑/外部工具写过）：先补一个换行再追加，
    // 否则新行会粘在最后一行尾部 —— 那一行随即不可解析，checkpoint 静默丢失。
    const separator = prev === '' || prev.endsWith('\n') ? '' : '\n'
    try {
      await fs.writeText(
        target,
        prev + separator + line,
        { kind: 'replaceIfVersion', version: info.version },
        signal,
        policy,
      )
      return
    } catch (error) {
      if (error && error.code === 'FS_STALE_VERSION') continue // 并发写冲突 → 重试
      throw error
    }
  }
  throw new Error(`${label}: append failed after retries (concurrent writes)`)
}

/** 纯计算：对 checkpoint 内容按 keep 裁剪。只返回结果，不写文件。 */
export function computePrune(content, keep) {
  const lines = content.split('\n')
  const cpIndexes = []
  lines.forEach((line, i) => {
    if (parseCheckpointLine(line) !== null) cpIndexes.push(i)
  })
  const N = cpIndexes.length
  if (N <= keep) {
    return { N, keep, removeCount: 0, prunedLabels: [], kept: null }
  }
  const removeCount = N - keep
  // 只删最旧 removeCount 条现行 checkpoint 行（append-only = 文件顺序即时间序）；
  // 注释/空行/旧格式行/普通文本永不删除（parseCheckpointLine null）。
  const removeIndexes = new Set(cpIndexes.slice(0, removeCount))
  const prunedLabels = cpIndexes
    .slice(0, removeCount)
    .map((i) => parseCheckpointLine(lines[i]).label)
  const kept = lines.filter((_, i) => !removeIndexes.has(i))
  return { N, keep, removeCount, prunedLabels, kept }
}

/**
 * CAS 重试重写：每次版本冲突都重新 stat + read + 重新 computePrune，再 replaceIfVersion。
 * 非重试错误直接上抛，原文件与版本不变（writeText 原子替换）。
 */
async function pruneWithRetry(fs, target, keep, signal, policy) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await fs.stat(target)
    if (info === undefined) return { kind: 'absent' }
    const content = await fs.readText(target)
    const r = computePrune(content, keep)
    if (r.removeCount === 0) return { kind: 'nothing', N: r.N }
    try {
      await fs.writeText(
        target,
        r.kept.join('\n'),
        { kind: 'replaceIfVersion', version: info.version },
        signal,
        policy,
      )
      return { kind: 'pruned', removeCount: r.removeCount }
    } catch (error) {
      if (error && error.code === 'FS_STALE_VERSION') continue
      throw error
    }
  }
  throw new Error(
    'agent_checkpoint: prune rewrite failed after retries (concurrent writes)',
  )
}

/**
 * agent_checkpoint 追加后的自动裁剪：现行行数 > max 时删最旧的若干条，返回一句
 * 可直接拼在成功消息后的结果（无裁剪返回空串）。
 *
 * 裁剪失败不吞掉已经成功的 append：checkpoint 已落盘，工具必须如实报告
 * 「写入成功 + 裁剪失败」，既不谎报成功也不让调用方以为整次调用失败而重试
 * （重试会重复写一条 checkpoint）。
 */
async function autoPrune(fs, target, keep, signal, policy) {
  let content
  try {
    content = await readExisting(fs, target)
  } catch (error) {
    return `; prune skipped: cannot read checkpoints file (${msgOf(error)})`
  }
  if (computePrune(content, keep).removeCount === 0) return ''
  try {
    const r = await pruneWithRetry(fs, target, keep, signal, policy)
    if (r.kind === 'pruned') return `; pruned ${r.removeCount} oldest`
    if (r.kind === 'absent')
      return '; prune skipped: checkpoints file disappeared'
    return '' // nothing：并发写者已裁剪，或行数已回落
  } catch (error) {
    return `; prune failed: ${msgOf(error)}`
  }
}

/**
 * 结构性 auto-checkpoint（无工具面）。
 *
 * 刻意保持 0.1.13 的线格式（auto-turn / auto-error 行），既有 checkpoint 文件
 * 继续可读；命名回溯检查点是另一套现行格式行，解析契约见 CHECKPOINT_LINE。
 * 只服务 delegationDepth 为 0 的根会话；写失败只 console.warn——恢复遥测绝不能让
 * 轮次关闭失败。
 */
export function installAutoCheckpoint(ctx, fs, sandboxPolicy) {
  const writtenTurns = new Set()
  const claimedByTurn = new Map()
  const erroredTurns = new Set()

  function rootOf(agent) {
    if (!agent || !agent.session) return null
    const session = agent.session
    const header = session.header || session
    if ((header.delegationDepth ?? 0) !== 0) return null
    return {
      id: header.id || header.sessionId || session.id || '',
      cwd: header.cwd || session.cwd || '',
    }
  }

  async function appendAutoLine(agent, line, signal) {
    const root = rootOf(agent)
    if (!root || !root.cwd) return
    try {
      const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd: root.cwd })
      const policy = sandboxPolicy.resolve({ session: agent.session })
      await appendCheckpoint(
        fs,
        target,
        line + '\n',
        signal,
        policy,
        'auto-checkpoint',
      )
    } catch (error) {
      // Auto-checkpointing is recovery telemetry: never make turn shutdown fail
      // because the recovery line could not be persisted.
      console.warn(
        `[dsh-agent-rewind] auto-checkpoint append failed: ${msgOf(error)}`,
      )
    }
  }

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const root = rootOf(agent)
    if (!root) return
    const key = `${root.id}\u0000${turn}`
    const text = autoMessageText(message && message.content)
      .replace(/\s+/g, ' ')
      .trim()
    if (text) claimedByTurn.set(key, text)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const root = rootOf(agent)
    if (!root) return
    const key = `${root.id}\u0000${turn}`
    if (writtenTurns.has(key)) return
    writtenTurns.add(key)
    const user = (claimedByTurn.get(key) || '').slice(0, AUTO_SUMMARY_CHARS)
    const line = [
      `- [${new Date().toISOString()}] auto-turn`,
      `session=${root.id}`,
      `turn=${turn}`,
      `user: ${user || '(no user text)'}`,
    ].join(' | ')
    await appendAutoLine(agent, line, signal)
  })

  ctx.on('agent/error', async ({ agent, turn, error, signal }) => {
    const root = rootOf(agent)
    if (!root) return
    const key = `${root.id}\u0000${turn}`
    if (erroredTurns.has(key)) return
    erroredTurns.add(key)
    const detail = String((error && error.message) || error)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, AUTO_SUMMARY_CHARS)
    const line = [
      `- [${new Date().toISOString()}] auto-error`,
      `session=${root.id}`,
      `turn=${turn}`,
      detail || '(no detail)',
    ].join(' | ')
    await appendAutoLine(agent, line, signal)
  })
}

/**
 * 注册三个模型可见工具。装配层（index.js）只传依赖，逻辑全部留在本文件。
 * @param ctx - 插件 ctx（readAllEvents 需要懒取 sessionQuery / sessionPersistence）
 * @param deps - { fs, sandboxPolicy, sessions, maxCheckpoints }
 */
export function registerLedgerTools(ctx, deps) {
  const { fs, sandboxPolicy, sessions, maxCheckpoints } = deps

  ctx.tools.register(
    defineTool({
      name: 'agent_checkpoint',
      description:
        'Record a named recovery point for a session (label + the seq of that session’s last completed turn) into .dsh/memory/checkpoints.md. Call it at major milestones; a checkpoint is meaningful only across turns, so call it at the start of the next turn for the turn just finished. When the file holds more current-format checkpoints than the configured limit, the oldest ones are pruned automatically.',
      parameters: {
        label: {
          type: 'string',
          required: true,
          description:
            'Exact label later passed to agent_rewind; non-empty, no newlines or "|" characters.',
        },
        note: {
          type: 'string',
          description:
            'Free-form note stored with the checkpoint (e.g. a git HEAD); no newlines or "|" characters.',
        },
        sessionId: {
          type: 'string',
          description:
            'Session to checkpoint; defaults to the calling session. Pass a delegated session id to checkpoint that session instead of your own.',
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd) throw new Error('agent_checkpoint: session cwd unavailable')
        // 校验 label/note：禁止换行与 `|`（checkpoint 行分隔符）。否则会注入伪行或
        // 错位字段，破坏 parseCheckpointLine round-trip 与 agent_rewind 的精确 label 匹配。
        const label = String(args.label ?? '').trim()
        if (!label) throw new Error('agent_checkpoint: label required')
        if (/[\r\n|]/.test(label))
          throw new Error(
            'agent_checkpoint: label must not contain newlines or "|"',
          )
        const note = args.note == null ? undefined : String(args.note).trim()
        if (note !== undefined && /[\r\n|]/.test(note))
          throw new Error(
            'agent_checkpoint: note must not contain newlines or "|"',
          )
        let sid
        let events
        if (args.sessionId != null) {
          // 显式传了空 sessionId 是调用错误：静默回退到「打在自己会话」会写错边界。
          const requested = String(args.sessionId).trim()
          if (!requested)
            throw new Error(
              'agent_checkpoint: sessionId must be non-empty when provided',
            )
          sid = normalizeSessionId(sessions, requested)
          const live = sessions.get(sid)
          events = live
            ? liveSessionEvents(live)
            : (await readAllEvents(ctx, sid, 'agent_checkpoint')).events
        } else {
          sid = agent.session.id
          events = liveSessionEvents(agent.session)
        }
        if (!sid)
          throw new Error('agent_checkpoint: target session id unavailable')
        if (!Array.isArray(events))
          throw new Error(
            `agent_checkpoint: event stream of session ${sid} unavailable`,
          )
        const boundary = lastTurnEndSeq(events)
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const line = formatCheckpointLine(label, sid, boundary, note)
        const policy = sandboxPolicy.resolve({ session: agent.session })
        await appendCheckpoint(
          fs,
          target,
          line,
          exec.signal,
          policy,
          'agent_checkpoint',
        )
        const pruned = await autoPrune(
          fs,
          target,
          maxCheckpoints,
          exec.signal,
          policy,
        )
        return `checkpoint OK: ${label} @ session ${sid} seq ${boundary}${pruned}`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'agent_rewind',
      description:
        'Fork a target session losslessly back to a named checkpoint boundary and return the child session id. Use it when the target session went off-track or you want to try another route; the old session retires on its own. label must exist in .dsh/memory/checkpoints.md and sessionId must be the session that checkpoint records.',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description:
            'Session the checkpoint belongs to; the "session-" prefix is optional.',
        },
        label: {
          type: 'string',
          required: true,
          description: 'Exact checkpoint label to rewind to.',
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd) throw new Error('agent_rewind: session cwd unavailable')
        const label = String(args.label ?? '').trim()
        if (!label) throw new Error('agent_rewind: label required')
        const requested = String(args.sessionId ?? '').trim()
        if (!requested) throw new Error('agent_rewind: sessionId required')
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const cp = await readExisting(fs, target)
        let entry = null
        // 倒序遍历取最新一条（checkpoint 文件只追加，同名 label 后写的才是最新边界）。
        const lines = cp.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const parsed = parseCheckpointLine(lines[i])
          if (parsed !== null && parsed.label === label) {
            entry = parsed
            break
          }
        }
        if (entry === null)
          throw new Error(
            `agent_rewind: no checkpoint found for label "${label}"`,
          )
        // 归属校验：checkpoint 记录的 session 必须与传入 sessionId 指同一会话
        // （前缀不敏感比对）。fork 目标取记录里的真实 id —— 边界属于记录会话的
        // 事件流，用调用方可能写错前缀的字符串去冷读只会读到不存在的会话。
        if (!sameSessionId(sessions, entry.session, requested)) {
          throw new Error(
            `agent_rewind: checkpoint "${label}" belongs to session ${entry.session}, not ${requested} — pass the checkpoint's own sessionId`,
          )
        }
        const sid = normalizeSessionId(sessions, entry.session)
        const seq = entry.seq

        const live = sessions.get(sid)
        if (live) {
          let child
          try {
            child = sessions.fork(sid, seq)
          } catch (error) {
            throw new Error(
              `agent_rewind: sessions.fork(${sid}, ${seq}) failed: ${msgOf(error)}`,
            )
          }
          if (!child || !child.id)
            throw new Error(
              `agent_rewind: sessions.fork(${sid}, ${seq}) returned no child session id`,
            )
          return `rewound (hot): forked ${sid} @ seq ${seq} -> child ${child.id}`
        }

        const read = await readAllEvents(ctx, sid, 'agent_rewind')
        if (!Array.isArray(read.events))
          throw new Error(
            `agent_rewind: session ${sid} read returned no event stream`,
          )
        if (seq >= read.events.length)
          throw new Error(
            `agent_rewind: boundary seq ${seq} out of range (cold session ${sid} has ${read.events.length} events)`,
          )
        // 热路径走 sessions.fork → 内部用 buildForkSeed 把未闭合的尾巴补上合成
        // 闭合事件（session/end-seed + step/end + turn/end，未匹配的 tool call 还会
        // 先补结果）。冷路径若只 slice 原始前缀，边界落在 turn 中间时会 fork 出一个
        // **未闭合**的子会话——与热路径行为不一致，且是结构损坏。故这里显式用
        // DSH 公开的 buildForkSeed 取得同一语义；inheritedEventCount 只算继承前缀，
        // 合成闭合事件在它之外（这正是 buildForkSeed 的契约）。
        const inheritedCount = seq + 1
        let seed
        try {
          seed = buildForkSeed(read.events, seq)
        } catch (error) {
          throw new Error(
            `agent_rewind: buildForkSeed failed for ${sid} @ seq ${seq}: ${msgOf(error)}`,
          )
        }
        let child
        try {
          child = sessions.create(undefined, {
            seed,
            meta: {
              ...(read.meta && read.meta.cwd ? { cwd: read.meta.cwd } : {}),
              parentSession: sid,
              isSeeded: true,
            },
            inheritedEventCount: inheritedCount,
          })
        } catch (error) {
          throw new Error(
            `agent_rewind: sessions.create for seed of session ${sid} failed: ${msgOf(error)}`,
          )
        }
        if (!child || !child.id)
          throw new Error(
            `agent_rewind: sessions.create returned no child session id for session ${sid}`,
          )
        return `rewound (cold): forked ${sid} @ seq ${seq} -> child ${child.id}`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'agent_checkpoint_list',
      description:
        'List every named recovery point in .dsh/memory/checkpoints.md (label / session / seq / note) — read it to see what you can rewind to. Structural auto-checkpoint lines are omitted.',
      parameters: {},
      output: stringOutput,
      async execute(_args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd)
          throw new Error('agent_checkpoint_list: session cwd unavailable')
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const cp = await readExisting(fs, target)
        const entries = cp
          .split('\n')
          .map(parseCheckpointLine)
          .filter((e) => e !== null)
        if (entries.length === 0) return '(no checkpoints)'
        return entries
          .map(
            (e) =>
              `- ${e.label} | session=${e.session} | seq=${e.seq}${e.note ? ` | ${e.note}` : ''}`,
          )
          .join('\n')
      },
    }),
  )
}
