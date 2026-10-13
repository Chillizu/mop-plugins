import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * dsh-session-policy 的会话级硬规则：session_rule（inject / show / clear）。
 *
 * 规则注册到**调用 agent 的会话作用域**的 systemPrompt.section，按 sessionId 隔离；
 * agent/disposed 清理该会话，ctx.effect 兜底回收全部（插件先停时 section 不泄漏）。
 * 取不到会话作用域时拒绝调用，绝不回退到进程全局 section。
 * 本文件从 dsh-session-policy 单包运行时移动而来：除工具改名（session_rule → session_rule）
 * 与消息前缀更新外，逻辑逐字未动。
 */

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
 * 注册 session_rule 工具并接管规则状态的生命周期。
 * @param ctx - 插件 ctx（需要 tools；规则 section 走 agent.ctx.get('systemPrompt')）
 */
export function registerSessionRules(ctx) {
  const { tools } = ctx

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
  // 会话级清理、session_rule(clear) 互不冲突（fiber teardown 晚于一切工具调用）。
  ctx.effect(() => () => {
    for (const state of ruleState.values()) {
      if (state.disposer) state.disposer()
    }
    ruleState.clear()
  })

  tools.register(
    defineTool({
      name: 'session_rule',
      description:
        'Manage the hard rule injected into the calling session’s system prompt, which overrides default behavior for that session only. Use "inject" to freeze a lesson or constraint so later turns obey it, "show" to read it back, and "clear" to revoke it. Memory-only: an injected rule is not persisted and is also lost on process restart.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['inject', 'show', 'clear'],
          description:
            '"inject" registers or replaces this session’s rule; "show" returns it; "clear" revokes it.',
        },
        text: {
          type: 'string',
          description:
            'Rule text; required when action is "inject", ignored otherwise.',
        },
      },
      output: stringOutput,
      execute(args, exec) {
        const agent = exec.agent
        const sid = agent && agent.session ? agent.session.id : null
        if (sid === null || sid === '')
          throw new Error(
            'session_rule: no calling session — refusing to touch process-global rule state',
          )
        const action = String(args.action ?? '')
        if (action === 'inject') {
          const text = typeof args.text === 'string' ? args.text : ''
          if (text.trim() === '')
            throw new Error(
              'session_rule: text required (non-empty) for action "inject"',
            )
          // 注册到调用 agent 的作用域（session-scoped），而非插件的 standing scope。
          const sessionPrompt =
            agent.ctx && typeof agent.ctx.get === 'function'
              ? agent.ctx.get('systemPrompt')
              : undefined
          if (
            sessionPrompt === undefined ||
            typeof sessionPrompt.section !== 'function'
          )
            throw new Error(
              'session_rule: session-scoped systemPrompt unavailable — refusing to fall back to a process-global rule',
            )
          const prev = ruleState.get(sid)
          if (prev && prev.disposer) prev.disposer()
          ruleState.delete(sid)
          let disposer
          try {
            disposer = sessionPrompt.section({
              name: 'session:rules',
              order: 50,
              text: `会话硬规则（规则注入）：\n${text}`,
            })
          } catch (error) {
            throw new Error(
              `session_rule: failed to register session rule section: ${msgOf(error)}`,
            )
          }
          ruleState.set(sid, { disposer, text })
          return `rule injected: ${text.slice(0, 120)}`
        }
        if (action === 'show') {
          const state = ruleState.get(sid)
          return state === undefined || state.text === ''
            ? '(no rule injected)'
            : state.text
        }
        if (action === 'clear') {
          const state = ruleState.get(sid)
          if (state !== undefined && state.disposer) state.disposer()
          ruleState.delete(sid)
          return state === undefined ? '(no rule injected)' : 'rules cleared'
        }
        throw new Error(
          `session_rule: unknown action "${action}" (expected inject|show|clear)`,
        )
      },
    }),
  )
}
