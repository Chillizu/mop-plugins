import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../packages/dsh-miopiik-learn/index.js')

function agent() {
  return { session: { id: 's1', header: { cwd: '/proj' } } }
}

test('mop_learn mints a SKILL.md with frontmatter', async () => {
  const registered = []
  const writes = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    fs: {
      resolve: async (path) => ({ path }),
      stat: async () => undefined,
      writeText: async (_t, content) => {
        writes.push({ content })
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }
  apply(ctx)
  const tool = registered.find((t) => t.name === 'mop_learn')
  const result = await tool.execute(
    {
      name: 'deploy-check',
      description: 'Pre-deploy checks',
      content: '## Steps\n1. run tests',
    },
    { agent: agent() },
  )
  assert.match(result, /skill minted/)
  assert.match(writes[0].content, /^---\nname: deploy-check\n/)
  assert.match(writes[0].content, /description: "Pre-deploy checks"/)
  assert.match(writes[0].content, /## Steps/)
})

test('mop_learn rejects a multi-line description', async () => {
  const { registered } = learnCtx({ exists: false })
  const tool = registered.find((t) => t.name === 'mop_learn')
  await assert.rejects(
    () =>
      tool.execute(
        { name: 'ok', description: 'line1\nline2', content: 'y' },
        { agent: agent() },
      ),
    /description 必须为单行/,
  )
})

test('mop_learn safely serializes quotes / colon / --- in description', async () => {
  const registered = []
  const writes = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    fs: {
      resolve: async (path) => ({ path }),
      stat: async () => undefined,
      writeText: async (_t, content) => {
        writes.push(content)
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }
  apply(ctx)
  const tool = registered.find((t) => t.name === 'mop_learn')
  await tool.execute(
    { name: 'ok', description: 'say "hi": use --- fence', content: 'y' },
    { agent: agent() },
  )
  // description 被 JSON.stringify 转义：引号/冒号/--- 都封在双引号串内，不破坏 frontmatter
  assert.match(writes[0], /description: "say \\"hi\\": use --- fence"/)
})

test('mop_learn rejects invalid name / empty fields', async () => {
  const registered = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    fs: {
      resolve: async (p) => ({ path: p }),
      stat: async () => undefined,
      writeText: async () => {},
    },
    sandboxPolicy: { resolve: () => ({}) },
  }
  apply(ctx)
  const tool = registered.find((t) => t.name === 'mop_learn')
  await assert.rejects(
    () =>
      tool.execute(
        { name: 'Bad Name', description: 'x', content: 'y' },
        { agent: agent() },
      ),
    /invalid skill name/,
  )
  await assert.rejects(
    () =>
      tool.execute(
        { name: 'ok', description: '  ', content: 'y' },
        { agent: agent() },
      ),
    /description required/,
  )
})

function learnCtx({ exists = false, version = 'v1' } = {}) {
  const registered = []
  const writes = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    fs: {
      resolve: async (path) => ({ path }),
      stat: async () => (exists ? { version } : undefined),
      writeText: async (_t, _content, intent) => {
        writes.push({ intent })
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }
  apply(ctx)
  return { registered, writes }
}

test('mop_learn refuses to overwrite an existing skill without replace', async () => {
  const { registered } = learnCtx({ exists: true })
  const tool = registered.find((t) => t.name === 'mop_learn')
  await assert.rejects(
    () =>
      tool.execute(
        { name: 'deploy-check', description: 'x', content: 'y' },
        { agent: agent() },
      ),
    /already exists.*replace:true/,
  )
})

test('mop_learn replace:true writes via CAS replaceIfVersion', async () => {
  const { registered, writes } = learnCtx({ exists: true, version: 'v7' })
  const tool = registered.find((t) => t.name === 'mop_learn')
  const result = await tool.execute(
    { name: 'deploy-check', description: 'x', content: 'y', replace: true },
    { agent: agent() },
  )
  assert.match(result, /skill replaced/)
  assert.equal(writes[0].intent.kind, 'replaceIfVersion')
  assert.equal(writes[0].intent.version, 'v7')
})

test('mop_learn new skill writes via createIfAbsent', async () => {
  const { registered, writes } = learnCtx({ exists: false })
  const tool = registered.find((t) => t.name === 'mop_learn')
  const result = await tool.execute(
    { name: 'deploy-check', description: 'x', content: 'y' },
    { agent: agent() },
  )
  assert.match(result, /skill minted/)
  assert.equal(writes[0].intent.kind, 'createIfAbsent')
})
