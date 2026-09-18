import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply, applyCapabilities, applyRunStats } = await import(
  '../packages/dsh-miopiik-diagnostics/index.js'
)

function baseCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      tools: {
        register: (tool) => {
          registered.push(tool)
        },
      },
      fs: {
        resolve: async () => ({}),
        stat: async () => undefined,
        writeText: async () => {},
      },
      sessions: {
        list: () => [],
        get: () => undefined,
        fork: () => ({ id: 'x' }),
      },
      sessionPersistence: {
        listSnapshots: async () => [],
        readFrom: async () => ({ meta: {}, events: [] }),
      },
      sessionQuery: {
        searchSessions: async () => ({ items: [] }),
      },
      systemPrompt: { section: () => () => {} },
      sandboxPolicy: { resolve: () => ({}) },
      on: () => {},
      get: () => undefined,
    },
  }
}

test('diagnostics default apply exposes both stable tool names', () => {
  const { ctx, registered } = baseCtx()
  apply(ctx)
  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    ['mop_probe_capabilities', 'mop_run_stats'],
  )
})

test('compatibility apply functions stay independently mountable', () => {
  const capabilities = baseCtx()
  applyCapabilities(capabilities.ctx)
  assert.deepEqual(
    capabilities.registered.map((tool) => tool.name),
    ['mop_probe_capabilities'],
  )

  const runStats = baseCtx()
  applyRunStats(runStats.ctx)
  assert.deepEqual(
    runStats.registered.map((tool) => tool.name),
    ['mop_run_stats'],
  )
})
