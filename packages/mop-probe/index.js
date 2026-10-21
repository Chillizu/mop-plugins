import { registerProbe } from './probe.js'

/**
 * mop-probe：部署探针。模型可见工具恰 1 个 —— `mop_probe_env`。
 *
 * mode="env"   运行/部署/会话/模型事实
 * mode="tools" 工具面契约审计（object-root、无 null 类型、required ⊆ properties）
 *
 * ── 与 dsh-session-policy 的分工（不许重叠）──
 * `session_doctor(mode="seams")` 探的是 **DSH seam 可用性**并落 capabilities 清单；
 * 本包探的是 **这次请求本身能不能被上游接受**（工具面 schema 契约）+ 进程事实。
 * 两者判据不同、失败面也不同：seam 缺失是功能降级，工具面违规是**整轮会话直接失败**。
 *
 * ── inject 为什么只有 tools ──
 * 探针只读：读 `tools.schemas()` 与 agent/session/process 上已有的值，不写文件、
 * 不碰 sandbox，所以不需要 fs / sandboxPolicy / sessions。少 inject 一条，就少一处
 * 上游漂移面。
 */
export const name = 'mop-probe'

export const inject = ['tools']

export function apply(ctx) {
  registerProbe(ctx)
}

export {
  collectEnv,
  normalizeParameterSchema,
  probeToolSurface,
  toolSchemaViolations,
} from './probe.js'
