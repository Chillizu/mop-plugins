import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-miopiik-executor'
export const inject = ['tools', 'subagents']

const DEFAULT_MAX_OUTPUT_CHARS = 4000

export const Config = z.object({
  maxOutputChars: z.natural().default(DEFAULT_MAX_OUTPUT_CHARS),
  // strict：收紧执行层工具面（去 bash/write）。edit 保留——persona 硬规则 3 本就要求
  // 「只 append 不覆盖」，多轮追加靠 edit；strict 面向不可信任务/来宾场景。
  strict: z.boolean().default(false),
  // 零默认零兜底：本插件不持有任何 provider/model 默认值、不读任何模型决策文件。
  // mop_spawn_executor 的模型只可能来自调用方的显式 model+provider；
  // mop_dispatch 的规划层模型只可能来自 preset 的 subagent_planner 行（显式配置）。
  // 缺失即 fail-closed 抛错——模型来源唯一、可预测，杜绝一切隐式回退。
})

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

// 执行层 persona 定稿源：docs/design/presets/drafts/executor.prompt.md。改此副本须同步源。
const EXECUTOR_PERSONA = `# 执行层（Executor）系统提示

## 身份

你是**执行层（Executor）**：one-shot 子代理。按任务（三段式：Target / Change / Acceptance + 合约引用 + 项目全景段）完成分配的**单一切片**。做完即停，交付验收输出。不与用户对话。结论先行、无废话、证据优先。

## 硬规则

1. 只做分配给你的切片；不做设计决策、不做 go/no-go 判断。
2. 不得 spawn 次级 subagent、不得调用 workflow（工具层已过滤）。
3. 只 append 不覆盖：多轮工作用 edit 追加，不用 write 覆盖他人产出。
4. 不碰分配范围之外的文件（跨切片文件所有权合约）。
5. 不跑 formatter/linter/测试全量门禁——只做编辑；验证归规划层。
6. 验收标准照任务模板执行，不自行放宽或加码；不做任何未要求的"顺手"修改。

## 交付格式（结论先行）

1. 结论：完成 / 部分 / 阻塞。
2. 修改清单：每文件路径 + 改动摘要。
3. 验收对照：逐条对照 Acceptance 说明验证方式与结果（P0–P3：文件 + 行号 + 风险 + 建议）。
4. 阻塞：如实上报 [blocked] + 原因 + 已尝试方案；不许静默失败、不许反复重试同一失败源。`

// allow-list 硬契约（P3-8，issue #3）：上游 tools.restrict 对未知工具名直接抛错，凡新增/改名工具，
// 本列表必须同步更新，否则 mop_spawn_executor 一调用即炸。勿靠 try/catch 吞掉——真实 misconfig
// （名字拼错、上游改了 restrict 语义）会被静默成「子代理无工具可用」的怪象，极难排查。
const EXECUTOR_TOOL_FILTER = {
  allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo_write'],
}

// strict 模式工具面：去 bash/write（Config.strict，默认关）。同样受 P3-8 硬契约约束：
// 上游 tools.restrict 对未知工具名抛错，改名/新增须同步。
const STRICT_EXECUTOR_TOOL_FILTER = {
  allow: ['read', 'glob', 'grep', 'edit', 'todo_write'],
}

// 注意：mop_dispatch 不再注册自本插件——它由 preset 的 tool-subagent-dispatch 行装配
// （与 subagent_planner 同级同机制：persona/模型/toolFilter 全部显式配置于 preset）。
// 迁移原因：executor 插件实例与 preset 工具行分属不同注册作用域，tools.get('subagent_planner')
// 拿不到跨作用域工具（0.1.8 验收 C2：mop_dispatch 报「subagent_planner 未注册」）。

function textOf(blocks) {
  return (blocks || [])
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .join('')
}

// 结构强制「严禁 Emoji」（反馈 #4）：弱模型常不守 persona 的 Emoji 禁令，
// 故在 executor 输出回传前剥掉 emoji，使执行层交付物不污染审查层上下文。
// 仅剥符号 emoji，不动文本/标点/中文。
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F100}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu
// 变体选择符（VS16 等）是单独不可见的组合字符，须与 emoji 分两次剥除——
// 与 emoji 区间同处一个字符类会触发 no-misleading-character-class。
const VARIATION_SELECTOR_RE = /[\u{FE00}-\u{FE0F}]/gu
function stripEmoji(s) {
  return String(s).replace(EMOJI_RE, '').replace(VARIATION_SELECTOR_RE, '')
}

function readableError(error, fallback) {
  if (error && error.message) return error.message
  const text = String(error)
  return text === 'Error' ? fallback : text
}

async function withRunDisposal(run, operation) {
  let value
  let operationError
  try {
    value = await operation()
  } catch (error) {
    operationError = error
  }

  let disposalError
  try {
    if (!run || typeof run.dispose !== 'function') {
      throw new Error('published SubagentRun is missing dispose()')
    }
    await run.dispose()
  } catch (error) {
    disposalError = error
  }

  if (operationError && disposalError) {
    throw new AggregateError(
      [operationError, disposalError],
      `executor 子代理执行与清理均失败（子会话 ${run && run.id ? run.id : '?'}）`,
    )
  }
  if (operationError) throw operationError
  if (disposalError) {
    throw new Error(
      `executor 子代理清理失败（见子会话 ${run && run.id ? run.id : '?'}）: ${readableError(
        disposalError,
        '无错误详情',
      )}`,
    )
  }
  return value
}

export function apply(ctx, config = {}) {
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const toolFilter =
    config.strict === true ? STRICT_EXECUTOR_TOOL_FILTER : EXECUTOR_TOOL_FILTER

  // 模型解析契约（反馈 #1 / 零默认零兜底）：模型来源唯一 = 调用方显式参数。
  // 1) model+provider 都给 → 直接用；
  // 2) 只给其一 → 抛错（禁止 provider/model 杂交，如 kimi provider + deepseek model）；
  // 3) 都不给 → 抛错（不读任何决策文件、不继承调用者模型、无静态默认——
  //    模型必须由审查层确认后显式传参，杜绝一切隐式回退）。
  function resolveModel(args) {
    if (args.model === 'inherit') {
      throw new Error(
        'mop_spawn_executor: model="inherit" 通道已移除（零默认零兜底）——执行层模型必须显式传真实 provider/model，不继承调用者',
      )
    }
    if (args.model && args.provider)
      return { provider: args.provider, model: args.model }
    if (args.model || args.provider) {
      throw new Error(
        'mop_spawn_executor: model 与 provider 必须同时给出或同时省略（禁止只给其一造成 provider/model 杂交）——无默认、无兜底、无继承，模型只认显式传参',
      )
    }
    throw new Error(
      'mop_spawn_executor: 未指定执行层模型——本插件无默认模型、不读 model-policy.md、不继承调用者；' +
        '必须先由审查层确认执行层模型，再在每次调用中显式传 model+provider',
    )
  }

  ctx.tools.register(
    defineTool({
      name: 'mop_spawn_executor',
      description:
        'Spawn a one-shot executor subagent for one task slice and return its final output. Call N times in one turn for N parallel executors. ' +
        'model + provider MUST be given together and explicitly: there is NO default model, NO fallback file, NO caller-model inheritance — omitting either (or both) throws. ' +
        'Never give only one of model/provider (no hybrid). ' +
        'timeoutMs optional (ms, hard timeout that aborts the child).',
      parameters: {
        prompt: { type: 'string', required: true },
        model: {
          type: 'string',
          description:
            'Execution-layer model id. REQUIRED, must be paired with provider. There is no default/fallback/inheritance: omitting it throws. Never give only one of model/provider.',
        },
        provider: {
          type: 'string',
          description:
            'Execution-layer provider id. REQUIRED, must be paired with model. There is no default/fallback/inheritance: omitting it throws. Never give only one of model/provider.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Optional hard timeout in milliseconds. When set, the executor subagent is aborted after this long and the tool returns an [aborted] timeout result. Omit for no timeout.',
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        const { provider, model } = resolveModel(args)

        // timeoutMs 可选：提供时必须是有限正数，缺省 = 无超时（行为不变）。
        const timeoutMs = args.timeoutMs
        if (
          timeoutMs !== undefined &&
          (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        ) {
          throw new Error(
            `mop_spawn_executor: timeoutMs 必须为有限正数（毫秒），收到 ${String(timeoutMs)}`,
          )
        }

        // 组合取消通道：exec.signal 是工具自身的取消信号，timeout 走额外 controller。
        // 两者任一触发都 abort controller.signal，再经 provider 桥接 cancel 子代理。
        const controller = new AbortController()
        let cancelled = false
        const forward = (reason) => {
          cancelled = true
          controller.abort(reason)
        }
        const sourceSignal = exec && exec.signal
        const isSignal =
          sourceSignal && typeof sourceSignal.addEventListener === 'function'
        if (isSignal && sourceSignal.aborted) {
          // 调用前已被取消：直接返回取消结果，不调用 subagents.start（已 aborted 的
          // signal 不会发未来事件，spawn 只会被立刻 cancel，无意义）。
          return '[aborted] executor cancelled (caller signal already aborted)'
        }
        if (isSignal) {
          sourceSignal.addEventListener('abort', forward, { once: true })
        }

        // timeout 用「Promise 竞速」而非只依赖 provider 桥接：保证 execute 一定在
        // timeoutMs 内 settle，即使 provider 在 abort 检查与监听之间存在竞态（漏接 abort）。
        let timedOut = false
        let timer = null
        let timeoutPromise = null
        if (timeoutMs !== undefined) {
          timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => {
              timedOut = true
              controller.abort(
                new Error(`mop_spawn_executor timeout after ${timeoutMs}ms`),
              )
              resolve()
            }, timeoutMs)
          })
        }

        try {
          let run
          try {
            // maxDepth 是【绝对】深度上限（resolveChildDepth: child=parent+1 ≤ cap），
            // 不是相对层数。执行器语义 = 「调用者的下一层叶子，不再级联」，
            // 所以 cap 必须随调用者深度浮动：审查层(0)派发→1，规划层(1)派发→2。
            // 写死 1 会让规划层派发必然 SubagentDepthError（ench1 基准实测撞上，
            // 规划层被迫亲自下场写码——三层架构退化为两层）。
            // 上游 SessionHeader 对顶层会话不写 delegationDepth 字段 → ?? 0。
            const parentDepth =
              (exec &&
                exec.agent &&
                exec.agent.session &&
                exec.agent.session.header &&
                exec.agent.session.header.delegationDepth) ??
              0
            run = await ctx.subagents.start('spawn', {
              label: `executor:${model}`,
              prompt: [{ type: 'text', text: args.prompt }],
              parent: exec.agent,
              agentOptions: { provider, model },
              persona: EXECUTOR_PERSONA,
              toolFilter,
              signal: controller.signal,
              maxDepth: parentDepth + 1,
            })
          } catch (error) {
            // 超时恰好在子代理发布前触发：无 session id 可暴露，返回明确的超时结果。
            if (timedOut) {
              return `[aborted] executor timed out after ${timeoutMs}ms before the child was published`
            }
            // start 阶段失败（闸/发布/深度限制）：错误原因必须回传（0.1.9 验收 B1 复测：
            // 闸拒发生在 start 内部，reject error.message 常为空，空 [error] 不可接受）。
            const msg = readableError(
              error,
              '(无错误详情；常见原因为模型闸拒绝、深度超限或工具面限制，见宿主日志)',
            )
            throw new Error(`executor 子代理启动失败: ${msg}`)
          }

          // D29v3 H3-cost 依赖：无论是否截断/超时，始终在返回末尾暴露 executor 子会话 id，
          // 供审查层 mop_run_stats(sessionId) 采 token 四桶（之前只在截断 suffix 里，短输出拿不到）。
          const sessionTag = `\n[executor-session: ${run.id}]`

          return await withRunDisposal(run, async () => {
            let result
            try {
              if (timeoutPromise !== null) {
                const raced = await Promise.race([
                  run.result,
                  timeoutPromise.then(() => ({ __timedOut: true })),
                ])
                if (raced && raced.__timedOut) {
                  // 超时先到：立即返回，绝不继续无限等待 run.result（覆盖 provider 漏接 abort 的竞态）。
                  run.result.catch(() => {}) // 防超时后 run.result 迟到 reject → unhandled rejection
                  return `[aborted] executor timed out after ${timeoutMs}ms${sessionTag}`
                }
                result = raced
              } else {
                result = await run.result
              }
            } catch (error) {
              // 子代理未发布成功或会话失败（含模型闸拒绝）：错误原因必须回传调用者，
              // 不能只存在于子会话日志（0.1.8 验收 B1：闸拒文案丢失，工具面只见空 [error]）。
              // Cordis start 的 reject error 常为空 message（闸文案写在子会话日志），
              // 故统一兜底为可读文案 + 暴露子会话 id 供查日志。
              const msg = readableError(
                error,
                '(无错误详情；常见原因为模型闸拒绝或深度/工具限制，见宿主日志与子会话日志)',
              )
              throw new Error(
                `executor 子代理失败（见子会话 ${run.id}）: ${msg}`,
              )
            }

            // timer 已触发时优先报 timeout：provider 若正确桥接 abort，run.result 会
            // 在 abort 内同步 settle 为 aborted，race 返回的是真结果而非 sentinel，
            // 此时必须靠 timedOut 标志区分「超时中止」与「普通 aborted」。
            if (timedOut) {
              return `[aborted] executor timed out after ${timeoutMs}ms${sessionTag}`
            }
            if (cancelled) {
              return `[aborted] executor cancelled${sessionTag}`
            }
            // 子代理以失败态 resolve（stopReason='error'）而非 reject——0.1.8/0.1.9/0.1.10
            // 验收 B1 连续两次「空 [error]」的真因：catch 只拦 reject，拦不到失败结果。
            // 失败原因（如模型闸拒绝文案）在子会话日志；result.error/message 存在则拼入。
            if (
              result.stopReason === 'error' ||
              result.stopReason === 'failed'
            ) {
              const reason = [
                result.error && (result.error.message || String(result.error)),
                typeof result.message === 'string' && result.message,
              ].find((x) => x && x !== 'Error')
              return (
                `[error] executor 子代理失败（stopReason=${result.stopReason}，见子会话 ${run.id}）: ` +
                (reason ||
                  '见子会话日志（常见：模型闸拒绝、深度超限、工具限制）')
              )
            }

            const body = stripEmoji(textOf(result.output))
            const maxChars = maxOutputChars
            const truncated = body.length > maxChars
            const shown = truncated ? body.slice(0, maxChars) : body
            const suffix = truncated
              ? `\n…[output truncated at ${maxOutputChars} chars; full text in executor subagent session ${run.id}]`
              : ''
            return `[${result.stopReason}] ${shown}${suffix}${sessionTag}`
          })
        } finally {
          if (timer !== null) clearTimeout(timer)
          if (isSignal) sourceSignal.removeEventListener('abort', forward)
        }
      },
    }),
  )
}
