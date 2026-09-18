import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-miopiik-recall'
export const inject = ['tools']

// 会话日志根：~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.jsonl.zstd
// slug 规则与 DSH 一致：路径段以 '-' 连接，整体包 '--'，如 /home/a/b → --home-a-b--。
const DEFAULT_MAX_LINES = 50
const DEFAULT_LINE_CHARS = 400

function slugOf(cwd) {
  return '--' + String(cwd).split('/').filter(Boolean).join('-') + '--'
}

function textOf(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return block.text || ''
  return ''
}

// 命中的"行"：user/message 与 assistant/message 事件里的纯文本内容。
function messageText(data) {
  const content = data && data.content
  if (Array.isArray(content)) return content.map(textOf).join('')
  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
  )
    return content.text
  return ''
}

export const Config = z.object({
  // zstd 可执行文件：默认 'zstd'（PATH 查找）。可通过组合层指向绝对路径。
  zstdBin: z.string(),
  // 会话日志根：默认 ~/.dsh/sessions（DSH 默认布局）；测试/异形布局可覆盖。
  sessionsRoot: z.string(),
  maxLines: z.natural(),
  lineChars: z.natural(),
})

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const MESSAGE_EVENT_TYPES = ['user/message', 'assistant/message']

function normalizeSessionId(id) {
  return String(id || '').replace(/^session-/, '')
}

function currentSessionId(session, header) {
  return (
    (header && (header.id || header.sessionId)) ||
    (session && session.id) ||
    ''
  )
}

function formatHit(hit, lineChars) {
  const time =
    hit.time === undefined || hit.time === null
      ? '?'
      : new Date(hit.time).toISOString()
  const role = hit.type === 'user/message' ? 'USER' : 'ASSISTANT'
  const text = String(hit.text || '').replace(/\s+/g, ' ').trim()
  return `[${time}] ${normalizeSessionId(hit.sessionId)} ${role}: ${text.slice(
    0,
    lineChars,
  )}`
}

async function nativeRecall(ctx, { query, scope, cwd, sessionId, limit, lineChars, signal }) {
  if (typeof ctx.get !== 'function') return null
  const sessionQuery = ctx.get('sessionQuery')
  if (
    !sessionQuery ||
    typeof sessionQuery.filterSessions !== 'function' ||
    typeof sessionQuery.filterEvents !== 'function'
  ) {
    return null
  }

  const eventFilters = [
    { kind: 'type', values: MESSAGE_EVENT_TYPES },
    { kind: 'text', text: query },
  ]
  const targets =
    scope === 'session'
      ? [{ header: { id: sessionId } }]
      : await sessionQuery.filterSessions(
          [{ kind: 'cwd', values: [cwd] }],
          signal,
        )

  const out = []
  let matched = 0
  let scanned = 0
  for (const target of targets) {
    signal?.throwIfAborted?.()
    const id =
      target &&
      target.header &&
      (target.header.id || target.header.sessionId)
    if (!id) continue
    scanned += 1
    const hits = await sessionQuery.filterEvents(id, eventFilters)
    for (const hit of hits) {
      if (matched >= limit) break
      out.push(formatHit(hit, lineChars))
      matched += 1
    }
    if (matched >= limit) break
  }

  return {
    scanned,
    matched,
    lines: out,
    truncated: matched >= limit,
    backend: 'sessionQuery',
  }
}

export function apply(ctx, config = {}) {
  const zstdBin = config.zstdBin ?? 'zstd'
  const sessionsRoot =
    config.sessionsRoot ?? join(homedir(), '.dsh', 'sessions')
  const maxLines = config.maxLines ?? DEFAULT_MAX_LINES
  const lineChars = config.lineChars ?? DEFAULT_LINE_CHARS

  // 流式解压扫描：zstd 子进程管道逐行处理，命中即收集、达到上限即 kill——
  // 不整文件缓冲（0.1.11 冒烟实测：20M+ 大会话解压超 execFile 64MB maxBuffer 被 skip）。
  async function scanFile(file, query, lower, needle, limit) {
    let proc
    try {
      proc = spawn(zstdBin, ['-d', '-c', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return {
        skipped: 1,
        error:
          error && error.message
            ? String(error.message).slice(0, 120)
            : String(error),
      }
    }
    let stderr = ''
    proc.stderr.on('data', (c) => {
      stderr = (stderr + String(c)).slice(-400)
    })
    const hits = []
    try {
      const rl = createInterface({ input: proc.stdout })
      for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        let ev
        try {
          ev = JSON.parse(t)
        } catch {
          continue
        }
        if (ev.type !== 'user/message' && ev.type !== 'assistant/message')
          continue
        const text = messageText(ev.data)
        if (!text) continue
        const matched = lower
          ? text.toLowerCase().includes(needle)
          : text.includes(query)
        if (!matched) continue
        hits.push({ time: ev.time, type: ev.type, text })
        if (hits.length >= limit) {
          proc.kill('SIGTERM')
          break
        }
      }
      await new Promise((resolve) => {
        proc.on('close', resolve)
        proc.on('error', resolve)
      })
    } catch (error) {
      if (proc && typeof proc.kill === 'function') proc.kill('SIGTERM')
      return {
        skipped: 1,
        error:
          error && error.message
            ? String(error.message).slice(0, 120)
            : String(error),
      }
    }
    if (stderr.trim() && hits.length === 0) {
      return {
        skipped: 1,
        error: stderr.trim().slice(0, 120),
      }
    }
    return { hits, skipped: 0, error: null }
  }

  async function sessionFiles(cwdDir) {
    let entries = []
    try {
      entries = await readdir(cwdDir, { withFileTypes: true })
    } catch {
      return [] // 无任何会话记录
    }
    const out = []
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue
      for (const suffix of ['session.jsonl.zstd', 'session.jsonl.zst']) {
        const f = join(cwdDir, e.name, suffix)
        try {
          await stat(f)
          out.push({ sessionId: e.name.slice('session-'.length), file: f })
          break
        } catch {
          /* 该后缀不存在，尝试下一个 */
        }
      }
    }
    out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
    return out
  }

  ctx.tools.register(
    defineTool({
      name: 'mop_recall',
      description:
        'Recall：查找本会话（scope="session"）或本工作目录全部历史会话（scope="workspace"，默认）中，所有 user/assistant 消息文本包含 query 的行。0.2 默认优先使用 DSH 原生 sessionQuery 逻辑会话语料库（不依赖私有日志布局）；caseSensitive=true、原生 seam 缺失或原生读取失败时保留旧 zstd 日志扫描兼容路径。用于追溯之前回合说过/写过的内容：契约、数字结论、已做的决定、步骤号等。返回命中的消息行（时间 + 会话 id + 角色 + 文本，行内截断），并汇总扫描/命中统计。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description:
            '要检索的字符串（子串匹配；默认忽略大小写，可用 caseSensitive=true 精确匹配）。',
        },
        scope: {
          type: 'string',
          description:
            '"workspace"（默认）：扫描本工作目录所有历史会话；"session"：只扫描当前会话。',
        },
        caseSensitive: {
          type: 'boolean',
          description: '默认 false（忽略大小写）。',
        },
        maxLines: {
          type: 'number',
          description: `最多返回的命中行数，默认 ${DEFAULT_MAX_LINES}。`,
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        const query = String(args.query ?? '').trim()
        if (!query) {
          throw new Error('mop_recall: query 必填（要检索的字符串）')
        }
        const lower = !args.caseSensitive
        const needle = lower ? query.toLowerCase() : query
        const session = exec && exec.agent && exec.agent.session
        const header = session && session.header
        const cwd =
          (header && header.cwd) || (session && session.cwd) || process.cwd()
        const cwdDir = join(sessionsRoot, slugOf(cwd))
        const limit = args.maxLines ?? maxLines
        const scope = args.scope === 'session' ? 'session' : 'workspace'
        const currentId = currentSessionId(session, header)

        // 0.2 native-first：DSH sessionQuery 的 provider-independent filter*
        // 读取完整逻辑语料库，不依赖 ~/.dsh/sessions 私有布局，也不要求 FTS
        // openAt。其 text filter 固定大小写不敏感，因此 caseSensitive=true
        // 明确保留旧 scanner 语义。
        if (lower) {
          try {
            const native = await nativeRecall(ctx, {
              query,
              scope,
              cwd,
              sessionId: currentId,
              limit,
              lineChars,
              signal: exec && exec.signal,
            })
            if (native) {
              const headerOut = [
                `recall "${query}" (scope=${scope}, cwd=${cwd}, caseSensitive=false)`,
                `scanned=${native.scanned}, matched=${native.matched}, skipped=0, sources=${native.backend}`,
              ]
              if (native.matched === 0) {
                headerOut.push('(no hits)')
                return headerOut.join('\n')
              }
              if (native.truncated)
                headerOut.push(`(truncated at ${limit} lines)`)
              return [...headerOut, ...native.lines].join('\n')
            }
          } catch (error) {
            if (exec && exec.signal && exec.signal.aborted) throw error
            // 兼容优先：native seam 在旧部署缺失/临时不可用时继续走 0.1.x
            // zstd scanner；不要让存量安装因上游 sessionQuery 漂移直接失效。
          }
        }

        const files = await sessionFiles(cwdDir)
        // id 归一化：目录名 session-<uuid> 解析出的 sessionId 已去前缀，
        // 而 header.id/session.id 常为带 'session-' 前缀的完整 SessionId——
        // 严格相等会永不命中（0.1.9 验收 R4c：scope=session 恒空）。
        const targets =
          scope === 'session'
            ? files.filter((f) => f.sessionId === normalizeSessionId(currentId))
            : files

        let matched = 0
        let skipped = 0
        let skippedError = null
        const out = []
        for (const t of targets) {
          const r = await scanFile(t.file, query, lower, needle, limit)
          if (r.skipped) {
            skipped += 1
            skippedError = r.error
            continue
          }
          for (const h of r.hits) {
            if (matched >= limit) break
            const time = h.time ? new Date(h.time).toISOString() : '?'
            const role = h.type === 'user/message' ? 'USER' : 'ASSISTANT'
            const text = h.text.replace(/\s+/g, ' ').trim()
            out.push(
              `[${time}] ${t.sessionId} ${role}: ${text.slice(0, lineChars)}`,
            )
            matched += 1
          }
          if (matched >= limit) break
        }
        const headerOut = [
          `recall "${query}" (scope=${scope}, cwd=${cwd}, caseSensitive=${!lower})`,
          `scanned=${targets.length}, matched=${matched}, skipped=${skipped}, sources=${cwdDir}`,
        ]
        if (skipped > 0 && skippedError) {
          headerOut.push(`(zstd 解压失败示例: ${skippedError})`)
        }
        if (matched === 0) {
          headerOut.push('(no hits)')
          return headerOut.join('\n')
        }
        if (matched >= limit) headerOut.push(`(truncated at ${limit} lines)`)
        return [...headerOut, ...out].join('\n')
      },
    }),
  )
}
