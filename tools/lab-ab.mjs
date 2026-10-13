#!/usr/bin/env node
// MiOpIIk A/B 效率/规则比对工具（反馈 #5：框架是否真更高效更好）。
//
// 用法：
//   node tools/lab-ab.mjs <session.jsonl> [<session.jsonl> ...]
//   node tools/lab-ab.mjs --group standard=lab1-default.jsonl,lab2-default.jsonl \
//                         --group miopiik=lab1-miopiik.jsonl,lab2-miopiik.jsonl
//
// 每个 session 提取：模型分布 / 子代理调用 / llm 重试 / 中止·阻塞 /
// 规则遵循（Ciallo 问候、Emoji 违规、[OK]/[FAIL] 标记）/ 完成度启发式 / token 四桶合计。
// --group 模式下按组聚合均值，便于 standard vs miopiik 直接对比。
//
// 注意：token 取自 session.jsonl 内的 `usage` 事件（provider 口径）；
// 若导出的 jsonl 不含 usage，则该列显示 0（可改用 agent_run_stats(sessionId) 取 live 值）。

import { readFileSync } from 'node:fs'

function load(path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      // 非 JSON 行跳过
    }
  }
  return out
}

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F100}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu

function textOf(b) {
  if (!b || typeof b !== 'object') return ''
  if (b.type === 'text') return b.text || ''
  if (b.type === 'reasoning') return b.text || ''
  if (b.type === 'tool-call') {
    let a = b.arguments || ''
    try {
      a = JSON.stringify(JSON.parse(a), null, 0)
    } catch {
      // 参数非 JSON 时原样保留
    }
    return ` [TOOL ${b.name}(${a})]`
  }
  return ''
}
function walk(msg, acc) {
  for (const b of msg.content || [])
    if (typeof b === 'object') acc.push(textOf(b))
}

function analyze(path) {
  const ev = load(path)
  const models = {}
  let subs = 0
  const subBreakdown = {}
  let retries = 0
  let aborted = 0
  let blocked = 0
  let ciallo = 0
  let emoji = 0
  let okfail = 0
  let tokIn = 0
  let tokOut = 0
  const allText = []
  for (const e of ev) {
    const t = e.type
    if (t === 'assistant/message') {
      const msg = e.data?.message
      const src = msg?.source || {}
      if (src.model)
        models[`${src.provider}/${src.model}`] =
          (models[`${src.provider}/${src.model}`] || 0) + 1
      const acc = []
      walk(msg, acc)
      const full = acc.join('\n')
      allText.push(full)
      if (full.startsWith('Ciallo') || full.slice(0, 40).includes('Ciallo~~'))
        ciallo++
      if (EMOJI_RE.test(full)) emoji++
      if (
        full.includes('[OK]') ||
        full.includes('[FAIL]') ||
        full.includes('[*]')
      )
        okfail++
      for (const b of msg.content || []) {
        if (b?.type === 'tool-call') {
          const n = b.name
          if (
            [
              'agent_spawn_executor',
              'subagent',
              'subagent_fork',
              'subagent_planner',
              'subagent_supervisor',
            ].includes(n)
          ) {
            subs++
            subBreakdown[n] = (subBreakdown[n] || 0) + 1
          }
        }
      }
    } else if (t === 'llm/retry' || t === 'llm/retry-started') {
      retries++
    } else if (t === 'tool/result' || t === 'tool-result') {
      const s = JSON.stringify(e.data || {})
      if (s.toLowerCase().includes('aborted')) aborted++
      if (s.includes('[blocked]')) blocked++
    } else if (t === 'usage') {
      const u = e.data || {}
      tokIn += u.inputTokens || 0
      tokOut += u.outputTokens || 0
    }
  }
  const joined = allText.join('\n')
  const completed =
    /smoke\.mjs/.test(joined) && /(PASS|通过|exit code 0|全部通过)/.test(joined)
  return {
    models,
    subs,
    subBreakdown,
    retries,
    aborted,
    blocked,
    ciallo,
    emoji,
    okfail,
    tokIn,
    tokOut,
    completed,
    assistantMsgs: allText.length,
  }
}

function fmt(r) {
  return {
    模型: Object.keys(r.models).join(', ') || '(无)',
    子代理调用:
      r.subs +
      (Object.keys(r.subBreakdown).length
        ? ` (${Object.entries(r.subBreakdown)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')})`
        : ''),
    llm重试: r.retries,
    '中止/阻塞': `${r.aborted}/${r.blocked}`,
    'Ciallo/Emoji/[OK·FAIL]': `${r.ciallo}/${r.emoji}/${r.okfail}`,
    'token(in/out)': `${r.tokIn}/${r.tokOut}`,
    '完成?': r.completed ? '是' : '否',
  }
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`)
  const keys = [
    '模型',
    '子代理调用',
    'llm重试',
    '中止/阻塞',
    'Ciallo/Emoji/[OK·FAIL]',
    'token(in/out)',
    '完成?',
  ]
  const nameW = 22
  const lines = rows.map(([name, r]) => [name, fmt(r)])
  const colW = {}
  for (const k of keys)
    colW[k] = Math.max(k.length, ...lines.map(([, r]) => String(r[k]).length))
  const header = [
    '会话'.padEnd(nameW),
    ...keys.map((k) => k.padEnd(colW[k])),
  ].join(' | ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const [name, r] of lines) {
    console.log(
      [
        name.padEnd(nameW),
        ...keys.map((k) => String(r[k]).padEnd(colW[k])),
      ].join(' | '),
    )
  }
}

const args = process.argv.slice(2)
const groups = {}
let positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--group') {
    const [g, paths] = args[++i].split('=')
    groups[g] = paths.split(',')
  } else positional.push(args[i])
}

if (Object.keys(groups).length) {
  for (const [g, paths] of Object.entries(groups)) {
    const rows = paths.map((p) => [p.split('/').pop(), analyze(p)])
    printTable(`组: ${g}`, rows)
  }
  // 组聚合均值
  console.log('\n=== 组聚合（均值）===')
  for (const [g, paths] of Object.entries(groups)) {
    const rs = paths.map(analyze)
    const n = rs.length || 1
    const avg = (f) => (rs.reduce((s, r) => s + f(r), 0) / n).toFixed(1)
    console.log(
      `${g.padEnd(12)} 子代理=${avg((r) => r.subs)} llm重试=${avg((r) => r.retries)} Emoji违规=${avg((r) => r.emoji)} 完成率=${rs.filter((r) => r.completed).length}/${n} tokenIn均值=${avg((r) => r.tokIn)}`,
    )
  }
} else if (positional.length) {
  const rows = positional.map((p) => [p.split('/').pop(), analyze(p)])
  printTable('会话', rows)
} else {
  console.error(
    '用法: node tools/lab-ab.mjs <session.jsonl> ... | --group name=paths,...',
  )
  process.exit(1)
}
