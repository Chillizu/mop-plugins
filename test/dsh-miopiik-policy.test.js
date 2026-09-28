import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../packages/dsh-miopiik-policy/index.js'

function getGuard() {
  const guards = []
  apply({ tools: { guard: (guard) => guards.push(guard) } })
  assert.equal(guards.length, 1)
  return guards[0]
}

test('requires explicit, non-empty provider and model for subagent_execute', () => {
  const guard = getGuard()
  for (const args of [
    {},
    { provider: 'openai' },
    { model: 'model-a' },
    { provider: '', model: 'model-a' },
    { provider: 'openai', model: '  ' },
    null,
  ]) {
    assert.match(
      guard({ name: 'subagent_execute', arguments: args }),
      /requires explicit non-empty provider and model/,
    )
  }
})

test('allows a complete route and leaves other native tools untouched', () => {
  const guard = getGuard()
  assert.equal(
    guard({
      name: 'subagent_execute',
      arguments: { provider: 'openai', model: 'model-a' },
    }),
    undefined,
  )
  assert.equal(guard({ name: 'subagent_plan', arguments: {} }), undefined)
})
