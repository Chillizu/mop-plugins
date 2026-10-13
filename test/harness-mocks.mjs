// 共享测试替身：两个运行时测试文件（dsh-agent-rewind / dsh-session-policy）共用同一套
// 边界替身，避免两份实现漂移。
//
// 替身只站在 seam 边界上：内存 fs（精确控制版本 / 缺失 / 写入失败，用于 CAS 与
// 错误注入）+ 真实 node:fs 适配器（同一段插件代码跑在真文件上）。插件逻辑本身
// 一律不替身。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CWD = '/workspace/project'
export const CHECKPOINTS_PATH = join(CWD, '.dsh', 'memory', 'checkpoints.md')
export const CAPABILITIES_PATH = join(CWD, '.dsh', 'memory', 'capabilities.md')

// 会话事件流：最后一个 turn/end 是 seq 6，其后还有事件（证明边界取 turn/end
// 而不是「最后一个事件」）。
export const EVENTS = [
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', seq: 1 },
  { type: 'turn/start', seq: 2 },
  { type: 'turn/end', seq: 6 },
  { type: 'message', seq: 9 },
]

export const BUCKETS = {
  uncachedInputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 0,
}
export const ZERO_BUCKETS = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export function fsError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/** 内存 fs seam：保留真实 dsh-fs 的 stat/readText/writeText(intent) 语义。 */
export function makeMemoryDisk(initial = {}, parseLine = () => null) {
  const files = new Map()
  let clock = 0
  const store = (path, content) => {
    const version = `v${++clock}`
    files.set(path, { content, version })
    return { content, version }
  }
  for (const [path, content] of Object.entries(initial)) store(path, content)

  const calls = { resolve: [], stat: [], readText: [], writeText: [] }
  // 写入前钩子：测试用它注入版本冲突 / 持久失败。
  const hooks = { write: [] }

  const seams = {
    async resolve(rel, opts = {}) {
      const path = opts.cwd ? join(opts.cwd, rel) : rel
      calls.resolve.push({ rel, cwd: opts.cwd, path })
      return { path }
    },
    async stat(target) {
      calls.stat.push(target.path)
      const record = files.get(target.path)
      return record === undefined
        ? undefined
        : {
            path: target.path,
            size: record.content.length,
            version: record.version,
          }
    },
    async readText(target) {
      calls.readText.push(target.path)
      const record = files.get(target.path)
      if (record === undefined)
        throw fsError('FS_NOT_FOUND', `no such file: ${target.path}`)
      return record.content
    },
    async writeText(target, content, intent, signal, policy) {
      const call = { path: target.path, content, intent, signal, policy }
      calls.writeText.push(call)
      for (const hook of hooks.write) hook(call)
      const record = files.get(target.path)
      if (intent && intent.kind === 'createIfAbsent' && record !== undefined)
        throw fsError('FS_NOT_OBSERVED', `${target.path} appeared concurrently`)
      if (intent && intent.kind === 'replaceIfVersion') {
        if (record === undefined)
          throw fsError('FS_NOT_OBSERVED', `${target.path} is absent`)
        if (record.version !== intent.version)
          throw fsError('FS_STALE_VERSION', `${target.path} moved`)
      }
      return store(target.path, content)
    },
  }

  return {
    seams,
    calls,
    hooks,
    content: (path) => files.get(path)?.content,
    has: (path) => files.has(path),
    set: (path, content) => store(path, content),
    version: (path) => files.get(path)?.version,
    parsedCount: (path) => {
      const content = files.get(path)?.content ?? ''
      return content.split('\n').filter((line) => parseLine(line) !== null)
        .length
    },
  }
}

export function makeHarness(options = {}) {
  assert.equal(
    typeof options.apply,
    'function',
    'makeHarness needs the module apply() under test',
  )
  const disk =
    options.disk ??
    makeMemoryDisk(options.files, options.parseLine ?? (() => null))
  const listeners = new Map()
  const registered = []
  const effects = []
  const services = {
    tools: {
      register: (tool) => {
        registered.push(tool)
      },
    },
    fs: disk.seams,
    sandboxPolicy: {
      resolve: (arg) => ({
        mode: 'workspace-write',
        session: arg && arg.session,
      }),
    },
    sessions: {
      get: () => undefined,
      list: () => [],
      fork: () => ({ id: 'child-hot' }),
      create: () => ({ id: 'child-cold' }),
    },
    sessionQuery: {
      readSession: async (id) => ({
        session: { id },
        inheritedEventCount: 0,
        events: [],
      }),
      filterSessions: async () => [],
      filterEvents: async () => [],
    },
    sessionPersistence: {
      list: async () => [],
      open: async (id) => ({
        header: { id },
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    },
    systemPrompt: { section: () => () => {} },
    ...options.services,
  }
  const ctx = {
    ...services,
    on: (event, fn) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    effect: (fn) => {
      effects.push(fn)
    },
    get: (name) => services[name],
  }

  return {
    ctx,
    services,
    disk,
    fs: services.fs,
    registered,
    effects,
    apply: (config) => options.apply(ctx, config),
    names: () => registered.map((tool) => tool.name),
    tool(name) {
      const found = registered.find((tool) => tool.name === name)
      assert.ok(found, `tool ${name} must be registered`)
      return found
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    async emitAsync(event, payload) {
      for (const fn of listeners.get(event) ?? []) await fn(payload)
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

/** 按被测模块绑定 apply / checkpoint 解析器，返回与旧签名一致的 makeHarness。 */
export function createHarnessFactory(apply, parseLine) {
  return (options = {}) => makeHarness({ parseLine, ...options, apply })
}

/** 工具调用：async 包装让同步抛错也变成 rejection（assert.rejects 语义一致）。 */
export async function runTool(harness, name, args, exec = {}) {
  const tool = harness.tool(name)
  return tool.execute(args, { signal: undefined, ...exec })
}

/**
 * 会话/agent 替身。header 的 delegationDepth 只在显式给 depth 时写入——真实
 * SessionHeader 对根会话不写该字段（absent = 0），显式写 0 会掩盖回归。
 */
export function rootAgent(options = {}) {
  const id = options.id ?? 'session-root'
  const header = { id, cwd: options.cwd ?? CWD }
  if (options.depth !== undefined) header.delegationDepth = options.depth
  const session = { id, header, events: options.events ?? [] }
  return {
    session,
    ctx: {
      get: (name) =>
        name === 'systemPrompt' ? options.systemPrompt : undefined,
    },
  }
}

export function promptDouble() {
  const sections = []
  return {
    sections,
    section(options) {
      const record = { options, disposed: 0 }
      sections.push(record)
      return () => {
        record.disposed += 1
      }
    },
  }
}

export function cpLine(label, sid, seq, note) {
  const suffix = note === undefined ? '' : ` | ${note}`
  return `- [2024-01-01T00:00:00.000Z] ${label} | session=${sid} | seq=${seq}${suffix}\n`
}

export const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * 真实 node:fs 适配器：把插件跑在真文件上（路径处理、追加、裁剪、CAS 全走真盘）。
 * 版本号在进程内维护，语义与 dsh-fs 的 replaceIfVersion / createIfAbsent 对齐。
 */
export function makeNodeDisk() {
  const versions = new Map()
  const versionOf = (path) => versions.get(path) ?? 'n0'
  const bump = (path) => {
    const next = `n${Number(versionOf(path).slice(1)) + 1}`
    versions.set(path, next)
    return next
  }
  return {
    seams: {
      async resolve(rel, opts = {}) {
        const path = join(opts.cwd ?? process.cwd(), rel)
        mkdirSync(dirname(path), { recursive: true })
        return { path }
      },
      async stat(target) {
        try {
          const stat = statSync(target.path)
          if (!stat.isFile()) return undefined
          return {
            path: target.path,
            size: stat.size,
            version: versionOf(target.path),
          }
        } catch (error) {
          if (error.code === 'ENOENT') return undefined
          throw error
        }
      },
      async readText(target) {
        return readFileSync(target.path, 'utf8')
      },
      async writeText(target, content, intent) {
        if (intent && intent.kind === 'createIfAbsent') {
          try {
            writeFileSync(target.path, content, { flag: 'wx' })
          } catch (error) {
            if (error.code === 'EEXIST')
              throw fsError('FS_NOT_OBSERVED', target.path)
            throw error
          }
        } else if (intent && intent.kind === 'replaceIfVersion') {
          if (versionOf(target.path) !== intent.version)
            throw fsError('FS_STALE_VERSION', target.path)
          writeFileSync(target.path, content)
        } else {
          writeFileSync(target.path, content)
        }
        bump(target.path)
      },
    },
  }
}
