import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 维护规则「改决策行必须同步承载文档代码块」的机制化：把三层 preset persona 的定稿源
// （docs/design/presets/drafts/*.prompt.md）与运行时副本钉死为逐字同步。
// review/planner/supervisor 副本在 examples/miopiik/agent.cordis.yml 的 persona 块标量。
// 一旦有人只改一处，本测试即失败（trust structure, not self-discipline）。
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function normalize(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('> ')) // 剥掉文档内部注记（「> 同步清单」等）
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function readDraft(name) {
  return normalize(
    readFileSync(join(root, 'docs/design/presets/drafts', name), 'utf8'),
  )
}

// 从 examples/miopiik/agent.cordis.yml 抽取一个 YAML 块标量（`|` 之后的缩进内容）。
// anchor.row 定位所在行，anchor.marker 定位其后第一个 `xxx: |` 标记，随后按首行
// 缩进 dedent 到块结束（遇到缩进更小的 sibling key 即止）。
function extractPersona(yaml, anchor) {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => anchor.row.test(l))
  if (start === -1) return null
  let marker = -1
  for (let i = start; i < lines.length; i++) {
    if (anchor.marker.test(lines[i])) {
      marker = i
      break
    }
  }
  if (marker === -1) return null
  const content = []
  let baseIndent = null
  for (let j = marker + 1; j < lines.length; j++) {
    const line = lines[j]
    if (line.trim() === '') {
      if (baseIndent !== null) content.push('')
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    if (baseIndent === null) baseIndent = indent
    if (indent < baseIndent) break
    content.push(line.slice(baseIndent))
  }
  return normalize(content.join('\n'))
}

// ── review / planner / supervisor：examples/miopiik 副本 ──
const exampleYaml = readFileSync(
  join(root, 'examples/miopiik/agent.cordis.yml'),
  'utf8',
)

test('review persona：定稿源与 examples/miopiik 副本逐字同步', () => {
  const block = extractPersona(exampleYaml, {
    row: /name: '@deepseek-ai\/dsh-persona'/,
    marker: /text: \|/,
  })
  assert.ok(block !== null, 'review persona 块必须存在于 examples/miopiik')
  assert.equal(
    readDraft('review.prompt.md'),
    block,
    'persona 漂移：review.prompt.md 与 examples/miopiik 的 persona 块不一致',
  )
})

test('planner persona：定稿源与 examples/miopiik 副本逐字同步', () => {
  const block = extractPersona(exampleYaml, {
    row: /toolName: subagent_plan/,
    marker: /persona: \|/,
  })
  assert.ok(block !== null, 'planner persona 块必须存在于 examples/miopiik')
  assert.equal(
    readDraft('planner.prompt.md'),
    block,
    'persona 漂移：planner.prompt.md 与 examples/miopiik 的 persona 块不一致',
  )
})

test('supervisor persona：定稿源与 examples/miopiik 副本逐字同步', () => {
  const block = extractPersona(exampleYaml, {
    row: /toolName: subagent_supervise/,
    marker: /persona: \|/,
  })
  assert.ok(block !== null, 'supervisor persona 块必须存在于 examples/miopiik')
  assert.equal(
    readDraft('supervisor.prompt.md'),
    block,
    'persona 漂移：supervisor.prompt.md 与 examples/miopiik 的 persona 块不一致',
  )
})
