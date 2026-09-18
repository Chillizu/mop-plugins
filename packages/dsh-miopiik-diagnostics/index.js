import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-miopiik-diagnostics'
export const inject = [
  'tools',
  'fs',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'systemPrompt',
  'sandboxPolicy',
]

// 0.2 diagnostics domain: compatibility/seam probing + a thin programmatic
// export over DSH tokenUsage projections. The old capabilities/run-stats
// packages delegate to the two named apply functions below during migration.

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

// 能力清单落点（D27，docs/design/capabilities.md）：项目 .dsh/memory/capabilities.md。
const CAPABILITIES_REL_PATH = '.dsh/memory/capabilities.md'

function msgOf(error) {
  return error && error.code
    ? String(error.code)
    : error && error.message
      ? error.message
      : String(error)
}

// list()/listSnapshots() 条目可能是字符串或带 id/sessionId 的对象（上游形状未
// 稳定，探测端必须容忍两种）；提取不出就跳过实调而非误报失败。
function idOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    if (typeof entry.id === 'string') return entry.id
    if (typeof entry.sessionId === 'string') return entry.sessionId
  }
  return null
}

/**
 * 探测 DSH seam。条目：{ seam, present, invoked, ok, detail }。
 * 两列语义（D27 教训升级「seam 探测 ≠ 工具冒烟」）：present = 原语在场
 * （typeof 检查）；invoked = 非破坏性实调结果（'ok' | 'fail'）；null = 只查
 * 在场（实调有副作用或需会话上下文）。在场 ≠ 可用，manifest 如实分列。
 */
async function probe(ctx) {
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
  const presenceOnly = (seam, fn, why) => {
    const r = row(seam)
    r.present = typeof fn === 'function'
    r.ok = r.present
    r.detail = r.present ? `primitive present (not invoked: ${why})` : 'missing'
  }

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
    ctx.sessions && ctx.sessions.fork,
    'fork creates a real session',
  )

  // ── sessionPersistence.listSnapshots：非破坏性实调，并为 readFrom 探测目标 ──
  let snapshotTarget = null
  {
    const r = row('sessionPersistence.listSnapshots')
    const fn = ctx.sessionPersistence && ctx.sessionPersistence.listSnapshots
    r.present = typeof fn === 'function'
    if (r.present) {
      try {
        const snapshots = await fn.call(ctx.sessionPersistence)
        const items = Array.isArray(snapshots) ? snapshots : []
        r.invoked = 'ok'
        r.ok = true
        r.detail = `${items.length} snapshots`
        snapshotTarget = idOf(items[0])
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
      }
    }
  }

  {
    const r = row('sessionPersistence.readFrom')
    const fn = ctx.sessionPersistence && ctx.sessionPersistence.readFrom
    r.present = typeof fn === 'function'
    const target = readTarget ?? snapshotTarget
    if (r.present && target !== null) {
      try {
        await fn.call(ctx.sessionPersistence, target, 0)
        r.invoked = 'ok'
        r.ok = true
        r.detail = `readFrom(${target}, 0) ok`
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
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
    ctx.systemPrompt && ctx.systemPrompt.section,
    'needs a session-scoped prompt',
  )
  presenceOnly(
    'sandboxPolicy.resolve',
    ctx.sandboxPolicy && ctx.sandboxPolicy.resolve,
    'needs a real session',
  )

  // ── sessionQuery.searchSessions：非破坏性实调（既有行为，补在场检查）──
  {
    const r = row('sessionQuery.searchSessions')
    const fn = ctx.sessionQuery && ctx.sessionQuery.searchSessions
    r.present = typeof fn === 'function'
    if (r.present) {
      try {
        const page = await fn.call(ctx.sessionQuery, {
          query: 'capability-probe',
        })
        r.invoked = 'ok'
        r.ok = true
        r.detail = `${page.items.length} hits`
      } catch (error) {
        r.invoked = 'fail'
        r.detail = msgOf(error)
      }
    }
  }

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

> 探测时间：${new Date().toISOString()} | status：${status} | cwd：${cwd} | 由 \`dsh-miopiik-capabilities\` 生成。
> 运行环境：${harnessInfo()}
${delegationLine(agent)}
> 读此文件了解当前部署 seam 可用性；**勿凭记忆假设上游契约**（DSH 尚在 rc，seam 语义可能流动）。
> 两列语义：「在场」= 原语存在（typeof 检查）；「实调」= 非破坏性实调结果，「—」= 未实调（有副作用或需会话上下文）。**在场 ≠ 可用**。

## 探测结果

| seam | 在场 | 实调 | 详情 |
|---|---|---|---|
${rows}
`
}

export function applyCapabilities(ctx) {
  const { tools, fs, sandboxPolicy } = ctx

  // signal 可缺省（P3-10，issue #3）：工具调用路径透传 exec.signal 让取消可中止
  // 写路径；agent/created 启动监听路径没有 exec 上下文，传 undefined。
  async function writeManifest(agent, signal) {
    const cwd =
      agent && agent.session && agent.session.header && agent.session.header.cwd
    if (!cwd)
      throw new Error('dsh-miopiik-capabilities: session cwd unavailable')
    const results = await probe(ctx)
    const target = await fs.resolve(CAPABILITIES_REL_PATH, { cwd })
    const policy = sandboxPolicy.resolve({ session: agent.session })
    // CAS 写入：观测版本 → replaceIfVersion；缺失 → createIfAbsent。多 root agent
    // 并发探测时不会盲覆盖他人已写的清单（冲突抛 FS_NOT_OBSERVED / FS_STALE_VERSION）。
    const info = await fs.stat(target)
    await fs.writeText(
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

  // 根会话启动时自动探测一次；子代理各自不再重复写。best-effort 异步：
  // 首次工作可能早于 manifest 完成——读清单时检查 status/时间戳，缺失则显式调
  // mop_probe_capabilities。写失败只 console.error，不崩启动。
  // 深度判定必须容忍 absent：上游 SessionHeader 对顶层会话**不写** delegationDepth
  // 字段（dsh-session types.ts：「absent (zero) for a top-level session」），
  // 子代理才有 >= 1。写成 `depth !== 0` 会把 undefined 当非零跳过 → 自动探测
  // 永不触发（曾被测试 fixture 显式写 0 掩盖，见 issue #3）。
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    const depth =
      agent &&
      agent.session &&
      agent.session.header &&
      agent.session.header.delegationDepth
    if ((depth ?? 0) !== 0) return
    writeManifest(agent).catch((error) => {
      console.error('dsh-miopiik-capabilities: startup probe failed', error)
    })
  })

  tools.register(
    defineTool({
      name: 'mop_probe_capabilities',
      description:
        'Probe DSH seam availability and write the capability manifest to .dsh/memory/capabilities.md. Each seam reports two evidence levels: present (primitive exists) and invoked-ok (non-destructive real call succeeded; "—" means not invoked because the call has side effects or needs a session context). Overall status OK/DEGRADED plus node/platform/harness-root info are recorded. Call at session start to detect upstream drift instead of assuming contracts from memory; the startup auto-probe is best-effort (async), so call this explicitly to guarantee the manifest is fresh before work.',
      parameters: {},
      output: stringOutput,
      async execute(_args, exec) {
        const agent = exec.agent
        const results = await writeManifest(agent, exec.signal)
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        const degraded = results.filter((r) => !r.ok).map((r) => r.seam)
        return degraded.length === 0
          ? `capabilities manifest written to ${cwd}/${CAPABILITIES_REL_PATH} (all ${results.length} seams OK)`
          : `capabilities manifest written (degraded: ${degraded.join(', ')})`
      },
    }),
  )
}

export function applyRunStats(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'mop_run_stats',
      description:
        '读取一个 session 的累计 token 用量（provider 上报口径，逐 turn/step 折叠，同 step 的 usage 替换不重复计）。返回 uncachedInput / cacheRead / cacheWrite / output 四桶 + 计费输入 / 输出合计，不计算价格或成本。全零桶表示该 session 无 usage 记录——门应判 INCONCLUSIVE 而非 PASS；tokenUsage 键缺失才表示 tokenMeter 未挂载（工具报错）。',
      parameters: {
        sessionId: { type: 'string', required: true },
      },
      output: stringOutput,
      async execute(args) {
        const sessionId = String(args.sessionId ?? '').trim()
        if (!sessionId)
          throw new Error('mop_run_stats: sessionId 必填（executor 子会话 id）')

        let usage
        let asOfSeq

        // 三个读取 seam（sessions/sessionProjections/sessionProjectionCache）走懒
        // ctx.get 而非 inject：它们在上游是可选服务，inject 会让插件在缺 seam 的
        // 部署里加载即失败；懒取才能在缺失时给出清晰报错而非炸加载（P2-4，issue #3）。
        const live = ctx.get('sessions')?.get(sessionId)
        if (live) {
          // live-first：会话仍 live 时同步快照（最新、零 I/O、无 dispose drain 竞态）
          const snap = ctx.get('sessionProjections')?.snapshot(live)
          usage = snap?.values?.tokenUsage
          asOfSeq = snap?.asOfSeq
          // live 但 tokenUsage 缺失 = tokenMeter 未挂载，落下方统一报错。
          // 不得转 cold 兜底：cold 服务已 dispose 会话，live 会话转 cold 会把
          // 「tokenMeter 未挂载」误诊为「不存在或未持久化」（P3-7，issue #3）。
        } else {
          // cold 兜底：仅非 live（已 dispose / 不存在）时从持久化投影缓存读
          //（缓存行 + readFrom 尾段重折叠）
          const cache = ctx.get('sessionProjectionCache')
          if (cache) {
            try {
              const snap = await cache.coldSnapshot(sessionId)
              usage = snap.values.tokenUsage
              asOfSeq = snap.asOfSeq
            } catch (error) {
              throw new Error(
                `mop_run_stats: session ${sessionId} 不存在或未持久化（${String(error)}）`,
              )
            }
          }
        }

        if (usage === undefined) {
          // 两种成因分开诊断：live 会话 = tokenMeter 未挂载；非 live = 该会话
          // 生前未挂 tokenMeter，或 sessionProjectionCache seam 缺失读不到冷投影。
          throw new Error(
            live
              ? 'mop_run_stats: tokenUsage 投影不可用（tokenMeter 未挂载）。' +
                  'session 存在但无 usage 记录时不会走到这里（会返回全零桶）。'
              : `mop_run_stats: session ${sessionId} tokenUsage 投影不可用（tokenMeter 未挂载）；` +
                  '若 sessionProjectionCache seam 缺失，已 dispose 会话也会走到此。',
          )
        }

        // 数值校验：token 桶须为有限非负数值。provider 上报异常（NaN/负/非数值）时
        // 不采信、不求和，直接报错让门判 INCONCLUSIVE，而非污染 cost 计算。
        const bucket = (raw, key) => {
          const n = raw ?? 0
          if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
            throw new Error(
              `mop_run_stats: tokenUsage.${key} 非有限非负数值（${String(raw)}）——provider 上报异常`,
            )
          }
          return n
        }
        const uncachedInputTokens = bucket(
          usage.uncachedInputTokens,
          'uncachedInputTokens',
        )
        const cacheReadTokens = bucket(usage.cacheReadTokens, 'cacheReadTokens')
        const cacheWriteTokens = bucket(
          usage.cacheWriteTokens,
          'cacheWriteTokens',
        )
        const outputTokens = bucket(usage.outputTokens, 'outputTokens')

        return JSON.stringify(
          {
            sessionId,
            asOfSeq,
            uncachedInputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens,
            // 计费输入计数（uncached + cacheRead + cacheWrite），非成本
            totalInputTokens:
              uncachedInputTokens + cacheReadTokens + cacheWriteTokens,
            totalOutputTokens: outputTokens,
          },
          null,
          2,
        )
      },
    }),
  )
}

export function apply(ctx) {
  applyCapabilities(ctx)
  applyRunStats(ctx)
}
