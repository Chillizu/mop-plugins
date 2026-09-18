export { applyCapabilities as apply } from 'dsh-miopiik-diagnostics'

export const name = 'dsh-miopiik-capabilities'
export const inject = [
  'tools',
  'fs',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'systemPrompt',
  'sandboxPolicy',
]
