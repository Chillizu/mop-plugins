import {
  CAPABILITIES_REL_PATH,
  installStartupProbe,
  probe,
  registerDiagnostics,
} from './diagnostics.js'
import { registerSessionRules } from './session-rules.js'

/**
 * dsh-session-policy：MiOpIIk 特性 —— 会话级硬规则 + 诊断。
 *
 * 模型可见工具 2 个（0.5.0 起去 agent_ 前缀，改用 DSH 先例的「类别_动词」形态）：
 * - session_rule    会话作用域硬规则注入 / 查看 / 撤销（session-rules.js）
 * - session_doctor  seams（能力清单探测）/ stats（tokenUsage 投影）（diagnostics.js）
 *
 * 命名恢复账本（agent_checkpoint / agent_rewind / agent_checkpoint_list
 * 与事件驱动 auto-checkpoint）自 0.5.0 起由 **依赖包 `dsh-agent-rewind`**
 * 独立承担——它共享 `<cwd>/.dsh/memory/checkpoints.md`，与本包的规则/诊断面无关。
 * 两包同版本 lockstep 发布，本包 patch 同时挂上该行（见 cordis.patch.yml）。
 *
 * inject 就是本包实际需要的联合，**不要再缩**：
 * - `tools`：注册两个工具；
 * - `fs` + `sandboxPolicy`：session_doctor(seams) 写 `.dsh/memory/capabilities.md`；
 * - `sessions` + `sessionPersistence`：diagnostics 的 probe() **直接**读它们做实调
 *   （`sessions.list`、`sessions.fork` presence、`sessionPersistence.list` /
 *   `open+read`），statsOf() 也用 `sessions.get` 做 live-first 判定——砍掉会让
 *   live 会话被误判成冷会话（P3-7 明令禁止的误诊）或让能力清单整份抛错。
 * 可选 seam（systemPrompt / sessionQuery / sessionProjections /
 * sessionProjectionCache）仍由 ctx.get 懒取，不进 inject。
 */
export const name = 'dsh-session-policy'

export const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'sessions',
  'sessionPersistence',
]

export function apply(ctx) {
  registerSessionRules(ctx)
  installStartupProbe(ctx)
  registerDiagnostics(ctx)
}

export {
  CAPABILITIES_REL_PATH,
  installStartupProbe,
  probe,
  registerDiagnostics,
}
