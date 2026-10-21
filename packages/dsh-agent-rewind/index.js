import {
  CHECKPOINTS_REL_PATH,
  DEFAULT_MAX_CHECKPOINTS,
  computePrune,
  formatCheckpointLine,
  installAutoCheckpoint,
  lastTurnEndSeq,
  liveSessionEvents,
  normalizeSessionId,
  parseCheckpointLine,
  registerLedgerTools,
  resolveMaxCheckpoints,
} from './ledger.js'

/**
 * dsh-agent-rewind：会话的命名恢复账本。
 *
 * 三个模型可见工具（agent_checkpoint / agent_rewind / agent_checkpoint_list）
 * 与事件驱动 auto-checkpoint 都只读写 `<cwd>/.dsh/memory/checkpoints.md`；
 * 本文件只做装配，逻辑在 ledger.js。
 *
 * inject 是工具功能成立的前提：三个工具都要 tools；写/读/裁剪都要 fs +
 * sandboxPolicy；agent_checkpoint / agent_rewind 要 sessions 与
 * sessionPersistence（前者判 live 事件流，后者冷会话回读）。
 */
export const name = 'dsh-agent-rewind'

export const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'sessions',
  'sessionPersistence',
]

export function apply(ctx, config) {
  const { fs, sandboxPolicy, sessions } = ctx
  const maxCheckpoints = resolveMaxCheckpoints(config)
  installAutoCheckpoint(ctx, fs, sandboxPolicy)
  registerLedgerTools(ctx, { fs, sandboxPolicy, sessions, maxCheckpoints })
}

export {
  CHECKPOINTS_REL_PATH,
  DEFAULT_MAX_CHECKPOINTS,
  computePrune,
  formatCheckpointLine,
  installAutoCheckpoint,
  lastTurnEndSeq,
  liveSessionEvents,
  normalizeSessionId,
  parseCheckpointLine,
  registerLedgerTools,
}
