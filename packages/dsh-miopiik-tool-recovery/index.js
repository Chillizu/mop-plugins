import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-miopiik-tool-recovery'
export const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'sessions',
  'sessionPersistence',
]

// 四个工具的字符串输出声明，抽为公共常量。
const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

// checkpoint 行格式：`- [ISO] label | session=<sid> | seq=<n> [| note]`
const CHECKPOINT_LINE =
  /^- \[[^\]]*\] (.+?) \| session=(\S+) \| seq=(\d+)(?: \| (.*))?\s*$/

// checkpoint 落点（D13，docs/design/recovery-toolkit.md）：项目 .dsh/memory/checkpoints.md，同包内写/读三处必须同一路径。
const CHECKPOINTS_REL_PATH = '.dsh/memory/checkpoints.md'


const AUTO_SUMMARY_CHARS = 120

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
 * Structural auto-checkpoints live in the recovery domain in 0.2.
 *
 * They deliberately keep the 0.1.13 wire format (auto-turn / auto-error rows)
 * so existing checkpoint files remain readable. Named rewind checkpoints keep
 * their separate current-format rows and parser contract below.
 */
function installAutoCheckpoint(ctx, fs, sandboxPolicy) {
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
      await appendCheckpoint(fs, target, line + '\n', signal, policy)
    } catch (error) {
      // Auto-checkpointing is recovery telemetry: never make turn shutdown fail
      // because the recovery line could not be persisted.
      console.warn(
        `[dsh-miopiik-tool-recovery] auto-checkpoint append failed: ${
          (error && error.message) || error
        }`,
      )
    }
  }

  ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    const text = autoMessageText(message && message.content)
      .replace(/\s+/g, ' ')
      .trim()
    if (text) claimedByTurn.set(turn, text)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (writtenTurns.has(turn)) return
    writtenTurns.add(turn)
    const root = rootOf(agent)
    if (!root) return
    const user = (claimedByTurn.get(turn) || '').slice(0, AUTO_SUMMARY_CHARS)
    const line = [
      `- [${new Date().toISOString()}] auto-turn`,
      `session=${root.id}`,
      `turn=${turn}`,
      `user: ${user || '(no user text)'}`,
    ].join(' | ')
    await appendAutoLine(agent, line, signal)
  })

  ctx.on('agent/error', async ({ agent, turn, error, signal }) => {
    if (erroredTurns.has(turn)) return
    erroredTurns.add(turn)
    const root = rootOf(agent)
    if (!root) return
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
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return events[i].seq
  }
  return 0
}

/** 归一化会话 id：补/去 `session-` 前缀，便于 `sessions.get` 命中。 */
export function normalizeSessionId(sessions, id) {
  if (sessions.get(id)) return id
  if (!id.startsWith('session-') && sessions.get('session-' + id))
    return 'session-' + id
  if (id.startsWith('session-') && sessions.get(id.slice('session-'.length)))
    return id.slice('session-'.length)
  return id
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
async function appendCheckpoint(fs, target, line, signal, policy) {
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
    try {
      await fs.writeText(
        target,
        prev + line,
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
  throw new Error(
    'mop_checkpoint: append failed after retries (concurrent writes)',
  )
}

/** 纯计算：对 checkpoint 内容按 keep 裁剪。只返回结果，不写文件。 */
function computePrune(content, keep) {
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
    'mop_checkpoint_prune: rewrite failed after retries (concurrent writes)',
  )
}

export function apply(ctx) {
  const { tools, fs, sandboxPolicy, sessions, sessionPersistence } = ctx
  installAutoCheckpoint(ctx, fs, sandboxPolicy)
  // sessionId -> { disposer, text }；规则状态按会话隔离，避免多会话互相覆盖。
  const ruleState = new Map()

  // 会话 dispose 时清理该会话的注入规则状态，避免长期运行进程累积无效条目。
  // agent/disposed payload = { agent }；disposer 幂等，已清理过则安全 no-op。
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    const sid = agent && agent.session ? agent.session.id : null
    if (sid === null) return
    const state = ruleState.get(sid)
    if (state !== undefined && state.disposer) state.disposer()
    ruleState.delete(sid)
  })

  // 插件 fiber 生命周期兜底：stop/update/undefine 时回收全部仍挂着的规则
  // section。此前只靠 agent/disposed——会话未 dispose 而插件先停时，
  // 注入的 systemPrompt section 会泄漏到进程里。disposer 幂等，与上面的
  // 会话级清理、mop_rule_clear 互不冲突（fiber teardown 晚于一切工具调用）。
  ctx.effect(() => () => {
    for (const state of ruleState.values()) {
      if (state.disposer) state.disposer()
    }
    ruleState.clear()
  })

  tools.register(
    defineTool({
      name: 'mop_checkpoint',
      description:
        'Record a recovery point for a session (label + its last completed turn boundary) into .dsh/memory/checkpoints.md. Call at major milestones; a checkpoint is meaningful only across turns — call it at the start of the next turn for the turn just finished.',
      parameters: {
        label: { type: 'string', required: true },
        note: { type: 'string' },
        sessionId: { type: 'string' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd) throw new Error('mop_checkpoint: session cwd unavailable')
        // 校验 label/note：禁止换行与 `|`（checkpoint 行分隔符）。否则会注入伪行或
        // 错位字段，破坏 parseCheckpointLine round-trip 与 mop_rewind 的精确 label 匹配。
        const label = String(args.label ?? '').trim()
        if (!label) throw new Error('mop_checkpoint: label required')
        if (/[\r\n|]/.test(label))
          throw new Error('mop_checkpoint: label 不得包含换行或 "|" 分隔符')
        const note = args.note == null ? undefined : String(args.note).trim()
        if (note !== undefined && /[\r\n|]/.test(note))
          throw new Error('mop_checkpoint: note 不得包含换行或 "|" 分隔符')
        let sid
        let events
        if (args.sessionId) {
          sid = normalizeSessionId(sessions, args.sessionId)
          const target = sessions.get(sid)
          events = target
            ? target.events
            : (await sessionPersistence.readFrom(sid, 0)).events
        } else {
          sid = agent.session.id
          events = agent.session.events
        }
        const boundary = lastTurnEndSeq(events)
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const line = formatCheckpointLine(label, sid, boundary, note)
        const policy = sandboxPolicy.resolve({ session: agent.session })
        await appendCheckpoint(fs, target, line, exec.signal, policy)
        return `checkpoint OK: ${label} @ session ${sid} seq ${boundary}`
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'mop_rewind',
      description:
        'Fork a target session (planner) losslessly back to a named checkpoint boundary and return the child session id. Use when the planner went off-track or you want to try another route. label must exist in checkpoints.md; pass sessionId equal to the session recorded in that checkpoint.',
      parameters: {
        sessionId: { type: 'string', required: true },
        label: { type: 'string', required: true },
      },
      output: stringOutput,
      async execute(args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd) throw new Error('mop_rewind: session cwd unavailable')
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const cp = await readExisting(fs, target)
        let seq = null
        let cpSession = null
        // 倒序遍历取最新一条（checkpoint 文件只追加，同名 label 后写的才是最新边界）。
        const lines = cp.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const entry = parseCheckpointLine(lines[i])
          if (entry !== null && entry.label === args.label) {
            seq = entry.seq
            cpSession = entry.session
            break
          }
        }
        if (seq === null)
          throw new Error(`no checkpoint found for label "${args.label}"`)
        const sid = normalizeSessionId(sessions, args.sessionId)
        // 归属校验：checkpoint 记录的 session 必须与传入 sessionId 一致（归一化后比对）。
        // 旧行无 session 字段则跳过校验（向后兼容）。
        if (cpSession && normalizeSessionId(sessions, cpSession) !== sid) {
          throw new Error(
            `mop_rewind: checkpoint "${args.label}" belongs to session ${cpSession}, not ${args.sessionId} — pass the checkpoint's own sessionId`,
          )
        }

        if (sessions.get(sid)) {
          const child = sessions.fork(sid, seq)
          return `rewound (hot): forked ${sid} @ seq ${seq} -> child ${child.id}`
        }
        const read = await sessionPersistence.readFrom(sid, 0)
        if (seq >= read.events.length)
          throw new Error(
            `boundary seq ${seq} out of range (cold session has ${read.events.length} events)`,
          )
        // 与热路径 sessions.fork 一致：seq 为 inclusive 边界（seed = events[0..seq]）。
        const seed = read.events.slice(0, seq + 1)
        const child = sessions.create(undefined, {
          seed,
          meta: {
            ...(read.meta.cwd ? { cwd: read.meta.cwd } : {}),
            parentSession: sid,
            seedLength: seed.length,
          },
        })
        return `rewound (cold): forked ${sid} @ seq ${seq} -> child ${child.id}`
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'mop_checkpoint_list',
      description:
        'List every recovery point in .dsh/memory/checkpoints.md (label / session / seq / note) — read this to see what you can rewind to.',
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
          throw new Error('mop_checkpoint_list: session cwd unavailable')
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

  tools.register(
    defineTool({
      name: 'mop_checkpoint_prune',
      description:
        'Prune old checkpoints from .dsh/memory/checkpoints.md, keeping the newest `keep` current-format checkpoint lines. Only lines parseable as current checkpoints are removed; comments, blank lines, legacy-format lines and prose are preserved in place. Dry-run by default: only `confirm:true` writes. keep=0 clears all current-format checkpoints (high risk, still requires confirm:true).',
      parameters: {
        keep: { type: 'integer', required: true },
        confirm: { type: 'boolean' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd)
          throw new Error('mop_checkpoint_prune: session cwd unavailable')
        const keep = args.keep
        if (!Number.isInteger(keep) || keep < 0)
          throw new Error(
            `mop_checkpoint_prune: keep 必须为非负整数，收到 ${String(keep)}`,
          )
        const confirm = args.confirm
        if (confirm !== undefined && typeof confirm !== 'boolean')
          throw new Error(
            'mop_checkpoint_prune: confirm 必须为布尔值（仅严格 true 才写入）',
          )
        const target = await fs.resolve(CHECKPOINTS_REL_PATH, { cwd })
        const policy = sandboxPolicy.resolve({ session: agent.session })

        if (confirm === true) {
          const r = await pruneWithRetry(fs, target, keep, exec.signal, policy)
          if (r.kind === 'absent') return '(no checkpoints)'
          if (r.kind === 'nothing')
            return `nothing to prune (${r.N} checkpoints <= keep ${keep})`
          return `pruned ${r.removeCount} checkpoint(s), kept ${keep}`
        }

        // dry-run（confirm 缺省或 false）：只读，绝不写。
        const content = await readExisting(fs, target)
        if (content === '') return '(no checkpoints)'
        const preview = computePrune(content, keep)
        if (preview.N === 0) return '(no current-format checkpoints to prune)'
        if (preview.removeCount === 0)
          return `nothing to prune (${preview.N} checkpoints <= keep ${keep})`
        return `dry-run: would prune ${preview.removeCount} checkpoint(s) — labels: ${preview.prunedLabels.join(', ')} (kept ${keep})`
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'mop_rule_inject',
      description:
        'Inject a session-scoped rule that overrides default behavior for the current session. Use to freeze a lesson or constraint so later turns obey it. Memory-only (lost on process restart); revoke with mop_rule_clear.',
      parameters: { text: { type: 'string', required: true } },
      output: stringOutput,
      execute(args, exec) {
        const agent = exec.agent
        const sid = agent && agent.session ? agent.session.id : null
        if (sid === null) throw new Error('mop_rule_inject: no calling session')
        // 注册到调用 agent 的作用域（session-scoped），而非插件的 standing scope。
        const sessionPrompt =
          agent.ctx && agent.ctx.get ? agent.ctx.get('systemPrompt') : undefined
        if (sessionPrompt === undefined)
          throw new Error(
            'mop_rule_inject: session-scoped systemPrompt unavailable — refusing to fall back to a process-global rule',
          )
        const prompt = sessionPrompt
        const prev = ruleState.get(sid)
        if (prev && prev.disposer) prev.disposer()
        const disposer = prompt.section({
          name: 'session:rules',
          order: 50,
          text: `会话硬规则（规则注入）：\n${args.text}`,
        })
        ruleState.set(sid, { disposer, text: args.text })
        return `rule injected: ${args.text.slice(0, 120)}`
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'mop_rule_show',
      description: 'Show the rules injected for the current session.',
      parameters: {},
      output: stringOutput,
      execute(_args, exec) {
        const agent = exec.agent
        const sid = agent && agent.session ? agent.session.id : null
        const state = sid !== null ? ruleState.get(sid) : undefined
        return state === undefined || state.text === ''
          ? '(no rule injected)'
          : state.text
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'mop_rule_clear',
      description:
        'Clear the session-scoped rules injected by mop_rule_inject for the current session. Memory-only: injected rules are not persisted and are also lost on process restart.',
      parameters: {},
      output: stringOutput,
      execute(_args, exec) {
        const agent = exec.agent
        const sid = agent && agent.session ? agent.session.id : null
        const state = sid !== null ? ruleState.get(sid) : undefined
        if (state !== undefined && state.disposer) state.disposer()
        ruleState.delete(sid)
        return state === undefined ? '(no rule injected)' : 'rules cleared'
      },
    }),
  )
}
