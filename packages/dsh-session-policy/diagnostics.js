import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * dsh-session-policy 的诊断面：session_doctor（mode="seams" 能力清单 / mode="stats"
 * tokenUsage 投影），外加 agent/created(depth 0) 的启动自动探测。
 *
 * 本文件从 dsh-session-policy 单包运行时移动而来：除工具改名（session_doctor → session_doctor）、
 * 消息前缀更新与函数外提（apply 里的 agent/created 监听改为 installStartupProbe）外，
 * 逻辑逐字未动——尤其两条刚修好的真实缺陷不得退化：
 * - probe 的 presenceOnly 收**谓词函数**而非布尔（传布尔会把成对原语判成 false）；
 * - statsOf 的 live-first 判定（live 会话不得转 cold 兜底，否则「tokenMeter 未挂载」
 *   会被误诊为「不存在或未持久化」）。
 */

/** 能力清单落点（D27）：项目 .dsh/memory/capabilities.md。 */
export const CAPABILITIES_REL_PATH = '.dsh/memory/capabilities.md'

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

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

// ── session_doctor mode="seams"：seam 探测 + 能力清单 ──────────────────────────

// DSH 0.1.7 sessionPersistence.list() 返回 { header, revision, ... }。
function idOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    if (typeof entry.id === 'string') return entry.id
    if (typeof entry.sessionId === 'string') return entry.sessionId
    if (entry.header && typeof entry.header.id === 'string')
      return entry.header.id
  }
  return null
}

/**
 * 探测 DSH seam。条目：{ seam, present, invoked, ok, detail }。
 * 两列语义（D27 教训升级「seam 探测 ≠ 工具冒烟」）：present = 原语在场
 * （typeof 检查）；invoked = 非破坏性实调结果（'ok' | 'fail'）；null = 只查
 * 在场（实调有副作用或需会话上下文）。在场 ≠ 可用，manifest 如实分列。
 */
export async function probe(ctx) {
  const results = []
  const row = (seam) => {
    const r = {
      seam,
      present: false,
      invoked: null,
      ok: false,
      detail: 'missing',
    }
    results.push(r)
    return r
  }
  // pred 收**谓词**而非值：调用方常有「成对原语都要在」这类复合判据，
  // 若传预算好的布尔，`typeof fn === 'function'` 会把它一律判成 false（真实踩过）。
  const presenceOnly = (seam, pred, why) => {
    const r = row(seam)
    r.present = pred() === true
    r.ok = r.present
    r.detail = r.present ? `primitive present (not invoked: ${why})` : 'missing'
  }
  // systemPrompt / sessionQuery 在本包是可选 seam（懒取），探测同样懒取。
  const systemPrompt = optionalSeam(ctx, 'systemPrompt')
  const sessionQuery = optionalSeam(ctx, 'sessionQuery')

  // ── sessions.list：非破坏性实调（枚举 live 会话）──
  let readTarget = null
  {
    const r = row('sessions.list')
    const fn = ctx.sessions && ctx.sessions.list
    r.present = typeof fn === 'function'
    if (r.present) {
      try {
        const listed = await fn.call(ctx.sessions)
        const items = Array.isArray(listed) ? listed : []
        r.invoked = 'ok'
        r.ok = true
        r.detail = `${items.length} live sessions`
        readTarget = idOf(items[0])
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
      }
    }
  }

  // ── sessions.fork：只查在场——fork 会创建真实子会话，不做非破坏实调 ──
  presenceOnly(
    'sessions.fork',
    () => typeof ctx.sessions?.fork === 'function',
    'fork creates a real session',
  )

  // ── sessionPersistence.list/open + SessionHandle.read ──
  let snapshotTarget = null
  {
    const r = row('sessionPersistence.list')
    const fn = ctx.sessionPersistence && ctx.sessionPersistence.list
    r.present = typeof fn === 'function'
    if (r.present) {
      try {
        const snapshots = await fn.call(ctx.sessionPersistence)
        const items = Array.isArray(snapshots) ? snapshots : []
        r.invoked = 'ok'
        r.ok = true
        r.detail = `${items.length} stored sessions`
        snapshotTarget = idOf(items[0])
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
      }
    }
  }

  {
    const r = row('sessionPersistence.open + SessionHandle.read/close')
    const persistence = ctx.sessionPersistence
    const fn = persistence && persistence.open
    r.present = typeof fn === 'function'
    const target = readTarget ?? snapshotTarget
    if (r.present && target !== null) {
      let handle
      try {
        handle = await fn.call(persistence, target, 'read')
        await handle.read(0)
        r.invoked = 'ok'
        r.ok = true
        r.detail = `open(${target}, 'read') + read(0) ok`
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
      } finally {
        if (handle) await handle.close()
      }
    } else if (r.present) {
      r.ok = true
      r.detail =
        'primitive present (not invoked: no live session/snapshot to read)'
    }
  }

  // ── systemPrompt.section / sandboxPolicy.resolve：只查在场（前者需会话级
  // prompt 上下文，后者需真实 session 才有意义）──
  presenceOnly(
    'systemPrompt.section',
    () => typeof systemPrompt?.section === 'function',
    'needs a session-scoped prompt',
  )
  presenceOnly(
    'sandboxPolicy.resolve',
    () => typeof ctx.sandboxPolicy?.resolve === 'function',
    'needs a real session',
  )

  // DSH 0.1.7 exposes provider-independent history reads/filters plus optional
  // ranked search; only inspect the stable abstract service contract here.
  presenceOnly(
    'sessionQuery.readSession',
    () => typeof sessionQuery?.readSession === 'function',
    'reads a complete session log',
  )
  // 该行名声明的是**成对**原语，present 必须两者都在：只查 filterSessions 会在
  // filterEvents 缺失时谎报 ok:true——能力清单的价值就是「靠证据说话」，宁可报缺。
  presenceOnly(
    'sessionQuery.filterSessions/filterEvents',
    () =>
      typeof sessionQuery?.filterSessions === 'function' &&
      typeof sessionQuery?.filterEvents === 'function',
    'requires a target session for event filtering',
  )

  return results
}

// markdown 表格单元格转义：换行折叠、`|` 转义，防异常消息破坏表格格式。
function escapeCell(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
}

// 运行环境行：node 版本 + 平台 + 可获取时的 harness 根目录（组合测试/部署注入
// DSH_HARNESS_ROOT；普通运行可能未设，如实标 unknown）。
function harnessInfo() {
  const root =
    typeof process !== 'undefined' && process.env
      ? process.env.DSH_HARNESS_ROOT
      : undefined
  return `node ${(process && process.version) || 'unknown'} | ${
    (process && process.platform) || 'unknown'
  } | harness root: ${root || 'unknown'}`
}

// 四层架构的层级自知道（ench1 复盘：各层应知道自己是谁、还能不能再派）。
// 真实 SessionHeader 对根会话不写 delegationDepth（absent = 0），子代理 >= 1。
function tierOf(depth) {
  if (depth === 0) return '审查层'
  if (depth === 1) return '规划层'
  return '执行/监督层或更深'
}

function delegationLine(agent) {
  const depth =
    (agent &&
      agent.session &&
      agent.session.header &&
      agent.session.header.delegationDepth) ??
    0
  return `> 本会话层级：depth ${depth}（${tierOf(depth)}）。层级预算：审查(0)→规划(1)→执行·监督(2，叶子不再派发)；第 3 层属极端场景，须用户经授权闸明示同意。`
}

function renderManifest(results, cwd, agent) {
  const degraded = results.filter((r) => !r.ok).length
  const status = degraded === 0 ? 'OK' : 'DEGRADED'
  const rows = results
    .map(
      (r) =>
        `| \`${r.seam}\` | ${r.present ? '[是]' : '[否]'} | ${
          r.invoked === 'ok' ? '[ok]' : r.invoked === 'fail' ? '[fail]' : '—'
        } | ${escapeCell(r.detail)} |`,
    )
    .join('\n')
  return `# DSH Capabilities（能力清单）

> 探测时间：${new Date().toISOString()} | status：${status} | cwd：${cwd} | 由 \`dsh-session-policy\` 的 \`session_doctor(mode="seams")\` 生成。
> 运行环境：${harnessInfo()}
${delegationLine(agent)}
> 读此文件了解当前部署 seam 可用性；**勿凭记忆假设上游契约**（DSH 尚在 rc， seam 语义可能流动）。
> 两列语义：「在场」= 原语存在（typeof 检查）；「实调」= 非破坏性实调结果，「—」= 未实调（有副作用或需会话上下文）。**在场 ≠ 可用**。

## 探测结果

| seam | 在场 | 实调 | 详情 |
|---|---|---|---|
${rows}
`
}

// signal 可缺省（P3-10，issue #3）：工具调用路径透传 exec.signal 让取消可中止
// 写路径；agent/created 启动监听路径没有 exec 上下文，传 undefined。
async function writeManifest(ctx, agent, signal) {
  const cwd =
    agent && agent.session && agent.session.header && agent.session.header.cwd
  if (!cwd) throw new Error('session_doctor: session cwd unavailable')
  const results = await probe(ctx)
  const target = await ctx.fs.resolve(CAPABILITIES_REL_PATH, { cwd })
  const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
  // CAS 写入：观测版本 → replaceIfVersion；缺失 → createIfAbsent。多 root agent
  // 并发探测时不会盲覆盖他人已写的清单（冲突抛 FS_NOT_OBSERVED / FS_STALE_VERSION）。
  const info = await ctx.fs.stat(target)
  await ctx.fs.writeText(
    target,
    renderManifest(results, cwd, agent),
    info === undefined
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: info.version },
    signal,
    policy,
  )
  return results
}

// ── session_doctor mode="stats"：tokenUsage 投影 ─────────────────────────────

async function statsOf(ctx, sessionId) {
  let usage
  let asOfSeq
  let live

  // live-first：会话仍 live 时同步快照（最新、零 I/O、无 dispose drain 竞态）
  live = ctx.sessions?.get(sessionId)
  if (live) {
    // seam 在场但缺 snapshot 时给出与「投影键缺失」一致的可诊断错误，而不是
    // 让 `snapshot is not a function` 的原始 TypeError 冒到模型面前。
    const projections = optionalSeam(ctx, 'sessionProjections')
    if (
      projections !== undefined &&
      typeof projections.snapshot !== 'function'
    ) {
      throw new Error(
        'session_doctor(stats): sessionProjections 在场但缺少 snapshot()——投影 seam 契约不完整',
      )
    }
    const snap = projections?.snapshot(live)
    usage = snap?.values?.tokenUsage
    asOfSeq = snap?.asOfSeq
    // live 但 tokenUsage 缺失 = tokenMeter 未挂载，落下方统一报错。
    // 不得转 cold 兜底：cold 服务已 dispose 会话，live 会话转 cold 会把
    // 「tokenMeter 未挂载」误诊为「不存在或未持久化」（P3-7，issue #3）。
  } else {
    // 冷会话：先由 DSH sessionQuery 读完整、已回放校验的日志，再交给
    // 最新 sessionProjectionCache.coldSnapshot(meta, inheritedEventCount, events)。
    const cache = optionalSeam(ctx, 'sessionProjectionCache')
    if (cache) {
      try {
        const query = optionalSeam(ctx, 'sessionQuery')
        if (!query || typeof query.readSession !== 'function') {
          throw new Error('sessionQuery.readSession unavailable')
        }
        const log = await query.readSession(sessionId)
        const snap = await cache.coldSnapshot(
          log.session,
          log.inheritedEventCount,
          log.events,
        )
        usage = snap?.values?.tokenUsage
        asOfSeq = snap.asOfSeq
      } catch (error) {
        throw new Error(
          `session_doctor: session ${sessionId} 不存在或未持久化（${String(error)}）`,
        )
      }
    }
  }

  if (usage === undefined) {
    // 两种成因分开诊断：live 会话 = tokenMeter 未挂载；非 live = 该会话
    // 生前未挂 tokenMeter，或 sessionProjectionCache seam 缺失读不到冷投影。
    throw new Error(
      live
        ? 'session_doctor: tokenUsage 投影不可用（tokenMeter 未挂载）。' +
            'session 存在但无 usage 记录时不会走到这里（会返回全零桶）。'
        : `session_doctor: session ${sessionId} tokenUsage 投影不可用（tokenMeter 未挂载）；` +
            '若 sessionProjectionCache seam 缺失，已 dispose 会话也会走到此。',
    )
  }

  // 数值校验：token 桶须为有限非负数值。provider 上报异常（NaN/负/非数值）时
  // 不采信、不求和，直接报错让门判 INCONCLUSIVE，而非污染 cost 计算。
  const bucket = (raw, key) => {
    const n = raw ?? 0
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new Error(
        `session_doctor: tokenUsage.${key} 非有限非负数值（${String(raw)}）——provider 上报异常`,
      )
    }
    return n
  }
  const uncachedInputTokens = bucket(
    usage.uncachedInputTokens,
    'uncachedInputTokens',
  )
  const cacheReadTokens = bucket(usage.cacheReadTokens, 'cacheReadTokens')
  const cacheWriteTokens = bucket(usage.cacheWriteTokens, 'cacheWriteTokens')
  const outputTokens = bucket(usage.outputTokens, 'outputTokens')
  const totalInputTokens =
    uncachedInputTokens + cacheReadTokens + cacheWriteTokens

  // 全零桶 = 该 session 无 usage 记录：必须显式提示门判 INCONCLUSIVE 而非 PASS。
  // 作为附加 JSON 字段（而非尾部散文）输出，保持现有文本整体仍是可解析 JSON。
  const allZero = totalInputTokens + outputTokens === 0

  return JSON.stringify(
    {
      sessionId,
      asOfSeq,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      // 计费输入计数（uncached + cacheRead + cacheWrite），非成本
      totalInputTokens,
      totalOutputTokens: outputTokens,
      ...(allZero
        ? {
            allZero: true,
            note: '全零桶：该 session 无 usage 记录——门应判 INCONCLUSIVE 而非 PASS。',
          }
        : {}),
    },
    null,
    2,
  )
}

// ── 装配：启动自动探测 + session_doctor 注册 ──────────────────────────────────

/**
 * 根会话启动时自动探测一次；子代理各自不再重复写。best-effort 异步：
 * 首次工作可能早于 manifest 完成——读清单时检查 status/时间戳，缺失则显式调
 * session_doctor(mode="seams")。写失败只 console.error，不崩启动。
 * 深度判定必须容忍 absent：上游 SessionHeader 对顶层会话**不写** delegationDepth
 * 字段（dsh-session types.ts：「absent (zero) for a top-level session」），
 * 子代理才有 >= 1。写成 `depth !== 0` 会把 undefined 当非零跳过 → 自动探测
 * 永不触发（曾被测试 fixture 显式写 0 掩盖，见 issue #3）。
 */
export function installStartupProbe(ctx) {
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    const depth =
      agent &&
      agent.session &&
      agent.session.header &&
      agent.session.header.delegationDepth
    if ((depth ?? 0) !== 0) return
    writeManifest(ctx, agent).catch((error) => {
      console.error('dsh-session-policy: startup probe failed', error)
    })
  })
}

/** 注册 session_doctor 工具。 */
export function registerDiagnostics(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'session_doctor',
      description:
        'Diagnose this DSH deployment. mode "seams" probes seam availability and writes the capability manifest to .dsh/memory/capabilities.md; each seam reports two evidence levels: present (primitive exists) and invoked-ok (non-destructive real call succeeded; "—" means not invoked because the call has side effects or needs a session context). mode "stats" reads one session’s cumulative token usage (provider-reported, folded per turn/step) as uncachedInput / cacheRead / cacheWrite / output buckets plus billable input/output totals, without pricing. Call mode "seams" at session start to detect upstream drift instead of assuming contracts from memory; the startup auto-probe is best-effort, so call it explicitly to refresh the manifest.',
      parameters: {
        mode: {
          type: 'string',
          required: true,
          enum: ['seams', 'stats'],
          description:
            '"seams" probes DSH seams and refreshes the capability manifest; "stats" reads one session’s token usage.',
        },
        sessionId: {
          type: 'string',
          description:
            'Target session id; required for mode "stats", ignored for "seams".',
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        const mode = String(args.mode ?? '')
        if (mode === 'seams') {
          const agent = exec.agent
          const results = await writeManifest(ctx, agent, exec.signal)
          const cwd =
            agent &&
            agent.session &&
            agent.session.header &&
            agent.session.header.cwd
          const degraded = results.filter((r) => !r.ok).map((r) => r.seam)
          return degraded.length === 0
            ? `capabilities manifest written to ${cwd}/${CAPABILITIES_REL_PATH} (all ${results.length} seams OK)`
            : `capabilities manifest written (degraded: ${degraded.join(', ')})`
        }
        if (mode === 'stats') {
          const sessionId = String(args.sessionId ?? '').trim()
          if (!sessionId)
            throw new Error(
              'session_doctor: sessionId 必填（mode="stats" 读取目标会话的 tokenUsage 投影）',
            )
          return await statsOf(ctx, sessionId)
        }
        throw new Error(
          `session_doctor: unknown mode "${mode}" (expected seams|stats)`,
        )
      },
    }),
  )
}
