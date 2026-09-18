import z from '@deepseek-ai/schemastery'

export { applyRunStats as apply } from 'dsh-miopiik-diagnostics'

export const name = 'dsh-miopiik-run-stats'
export const inject = ['tools']

// Compatibility surface: keep the historical empty config contract while
// implementation lives in the 0.2 diagnostics domain.
export const Config = z.object({})
