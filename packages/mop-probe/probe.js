import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * mop-probe 的运行时探针：把「部署事实」与「工具面契约」读出来给模型看。
 *
 * ── 为什么存在（事故溯源）──
 * 2026-10-13 的 web profile 上，一个挂在 agent preset 里的第三方探针包以
 * `mop_probe_env` 注册了工具，其 `parameters` 为空 schema。DSH 侧不拦（`tools.register()`
 * 的原样路径不做 object-root 校验），于是空 schema 一路走到 deepseek API，被上游
 * 拒绝：`Invalid schema for function 'mop_probe_env': schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'`——**整个会话每一轮都失败**，与该轮内容无关。
 *
 * 本包的判据因此是硬性的：
 * 1. 所有工具一律经 `defineTool()` 产出。它内部走 `parameterSchemaSpecToJsonSchema()`，
 *    **结构上保证** `{type:'object', properties:{...}}`，零参工具也退化成
 *    `{type:'object', properties:{}}` 而绝不是 null/`type:null`。
 * 2. 再叠一层判据（`toolSchemaViolations()`），运行时自检与 CI 测试共用同一份：
 *    `probeToolSurface()` 读 `tools.schemas()`（模型面权威投影，只白名单
 *    name/description/parameters），即使日后有人绕过 `defineTool`，也能当场看见。
 */

/** 契约违规：任何一条都足以让上游拒绝整个会话的请求。 */
const VIOLATION = {
  missing: 'parameters 缺失（上游要求 object-root schema）',
  notRecord: 'parameters 不是对象',
  notObject: 'parameters.type 不是 "object"',
  nullType: 'parameters.type 为 null 或含 "null"（上游明确拒绝）',
  noProperties: 'parameters.properties 不是对象',
  requiredNotDeclared: 'required 里的字段未在 properties 声明',
}

/**
 * 懒取 seam。有 `ctx.get` 走 `ctx.get`（缺失返回 undefined，不抛）；没有的组合
 * （测试替身）退化为直接读属性，并容忍异常——与 dsh-session-policy/diagnostics.js
 * 同一套兜底，不另造轮子。
 */
function optionalSeam(ctx, seamName) {
  if (typeof ctx.get === 'function') return ctx.get(seamName)
  try {
    return ctx[seamName]
  } catch {
    return undefined
  }
}

/** 手写参数图的「必填」标记：`{ [字段]: { required: true } }`。 */
const REQUIRED_FLAG = 'required'

/**
 * 把「手写参数图」归一成 JSON Schema。DSH 的 `defineTool()` 用
 * `parameterSchemaSpecToJsonSchema()` 做同一件事（扁平字段表 → object-root schema，
 * `required: true` 的字段收进 `required[]`），这里按同一规则复刻，好让判据在
 * **扁平图**与**已投影 schema** 两种形态上都能生效。
 *
 * 只认已投影 schema 的判据（`type === 'object'`）会漏掉一支真实输入：`defineTool`
 * 的入参是扁平的，而测试替身 `defineTool` 原样返回它。判据必须两种形态都吃。
 */
export function normalizeParameterSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return spec
  }
  // 已投影的 JSON Schema 认 `type` 关键字，**不能**用 `properties` 判：否则
  // `{type:'object', properties:{…}}` 会被当成扁平图再套一层——静默地产出
  // 一个 properties 里躺着 "properties" 字段的错 schema，正是要防的那类事故。
  if (Object.hasOwn(spec, 'type')) return spec
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      properties[key] = field
      continue
    }
    const { [REQUIRED_FLAG]: isRequired, ...rest } = field
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/** 递归找 schema 里任何显式 null 类型（含 `type: "null"` / `type: ['string','null']`）。 */
function findNullType(node, path, hits, options) {
  if (node === null || typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      findNullType(item, `${path}[${index}]`, hits, options),
    )
    return hits
  }
  const atRoot = options && options.root && path === options.root
  const type = node.type
  // 根节点的 type 已由调用方单列一条违规，这里不重复计：同一份 schema
  // 只报一次，违规条数才等于可执行的修复项数。
  if (!atRoot) {
    if (type === null) hits.push(`${path}.type`)
    else if (type === 'null') hits.push(`${path}.type`)
    else if (Array.isArray(type) && type.includes('null'))
      hits.push(`${path}.type[]`)
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'description' || key === 'title') continue
    findNullType(value, `${path}.${key}`, hits, options)
  }
  return hits
}

/**
 * 校验一个模型面工具 schema 是否满足上游的函数调用契约。
 * 纯函数：CI 测试与运行时自检共用同一份判据，不允许两处各写一套。
 *
 * 接受两种 parameters 形态：`defineTool` 的**扁平参数图**，以及 `tools.schemas()`
 * 投影出的 **JSON Schema**（`{type:'object',properties:{…}}`）。两者都归一后判。
 *
 * @param schema - `{ name, description, parameters }`，可来自 tools.schemas()。
 * @returns 违规描述数组；空数组即合规。
 */
export function toolSchemaViolations(schema) {
  const name =
    schema && typeof schema.name === 'string' ? schema.name : '<unnamed>'
  const violations = []
  const raw = schema ? schema.parameters : undefined
  if (raw === undefined || raw === null) {
    violations.push(`${name}: ${VIOLATION.missing}`)
    return violations
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push(`${name}: ${VIOLATION.notRecord}`)
    return violations
  }
  const parameters = normalizeParameterSchema(raw)
  if (parameters.type !== 'object') {
    violations.push(
      `${name}: ${parameters.type === null ? VIOLATION.nullType : VIOLATION.notObject}（实际 ${JSON.stringify(parameters.type)}）`,
    )
  }
  const properties = parameters.properties
  if (properties === undefined) {
    // 缺 properties 本身不致命，但记录成待观察项，避免静默。
    violations.push(`${name}: ${VIOLATION.noProperties}（undefined）`)
  } else if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    violations.push(`${name}: ${VIOLATION.noProperties}`)
  }
  if (
    Array.isArray(parameters.required) &&
    properties &&
    typeof properties === 'object'
  ) {
    const missing = parameters.required.filter(
      (key) => typeof key === 'string' && !Object.hasOwn(properties, key),
    )
    if (missing.length > 0) {
      violations.push(
        `${name}: ${VIOLATION.requiredNotDeclared} ${missing.join(', ')}`,
      )
    }
  }
  const root = `${name}.parameters`
  const nullHits = findNullType(parameters, root, [], { root })
  if (nullHits.length > 0)
    violations.push(`${name}: 显式 null 类型 ${nullHits.join(', ')}`)
  return violations
}

/**
 * 读调用方 scope 可见的工具面并做契约校验。
 * `tools.schemas(scope)` 是模型面权威投影：只含 name/description/parameters，
 * 正是上游拿去构造 function 定义的那三个字段，所以在这里判等于在线上判。
 *
 * `tools` 已在 inject 里声明，正常组合下 `ctx.tools` 必然存在；但 `ctx.get` 缺失
 * 的测试替身里直接读未声明属性会抛（真实 Cordis 同样抛），故与 diagnostics.js 同法
 * 兜底：读不到就如实报「工具面不可读」，而不是让整个探针抛错——探针本身失效时
 * 最不该做的就是再制造一次会话失败。
 */
export function probeToolSurface(ctx, agent) {
  const tools = optionalSeam(ctx, 'tools')
  if (tools === undefined || typeof tools.schemas !== 'function') {
    return {
      available: false,
      total: 0,
      tools: [],
      violations: [],
      byPrefix: {},
    }
  }
  const schemas = tools.schemas(agent)
  const violations = []
  const byPrefix = {}
  for (const schema of schemas) {
    const name =
      schema && typeof schema.name === 'string' ? schema.name : '<unnamed>'
    const prefix = name.includes('_')
      ? name.slice(0, name.indexOf('_'))
      : '(无前缀)'
    byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1
    violations.push(...toolSchemaViolations(schema))
  }
  return {
    available: true,
    total: schemas.length,
    tools: schemas.map((schema) => schema.name),
    violations,
    byPrefix,
  }
}

/** 环境事实：只读、不含凭据；undefined 一律显式标成 null 便于模型判读。 */
export function collectEnv(ctx, agent) {
  const session = agent && agent.session ? agent.session : undefined
  const header = session && session.header ? session.header : undefined
  const model =
    agent && agent.modelSelection && typeof agent.modelSelection === 'object'
      ? agent.modelSelection
      : undefined
  const env = typeof process === 'undefined' ? {} : process.env
  return {
    runtime: {
      node: typeof process === 'undefined' ? null : process.version,
      platform: typeof process === 'undefined' ? null : process.platform,
      arch: typeof process === 'undefined' ? null : process.arch,
      pid: typeof process === 'undefined' ? null : process.pid,
    },
    deployment: {
      // 只报「是否设置」，不报凭据；DSH_* 都是路径/档位，不含密钥。
      profile: env.DSH_PROFILE ?? null,
      profileDir: env.DSH_PROFILE_DIR ?? null,
      home: env.DSH_HOME ?? null,
      sandboxMode: env.DSH_SANDBOX_MODE ?? null,
    },
    session: {
      id: session && session.id ? session.id : null,
      cwd: header && header.cwd ? header.cwd : null,
      createdAt: header && header.createdAt ? header.createdAt : null,
      depth: typeof agent?.depth === 'number' ? agent.depth : null,
    },
    model: model
      ? {
          provider: model.provider ?? null,
          model: model.model ?? null,
          reasoningEffort: model.reasoningEffort ?? null,
        }
      : null,
  }
}

/** 零参也必须是 object-root：空 parametersMap 交给 defineTool 即得 properties:{}。 */
const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function section(title) {
  return `\n── ${title} ──`
}

export function registerProbe(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'mop_probe_env',
      description:
        'Probe this deployment and report runtime facts, or audit the model-facing tool surface. mode "env" returns runtime / deployment (profile, sandbox mode) / session / model facts. mode "tools" audits every visible tool’s JSON Schema against the function-calling contract enforced by the upstream API (object-root parameters, no explicit null type, required ⊆ properties) and lists any violation — a violation here means the API rejects the ENTIRE request, so the whole session fails every turn until the offending tool is unloaded. mode "all" runs both.',
      parameters: {
        mode: {
          type: 'string',
          required: true,
          enum: ['env', 'tools', 'all'],
          description:
            '"env" reports runtime/deployment/session/model facts; "tools" audits the visible tool schemas; "all" runs both.',
        },
      },
      output: stringOutput,
      execute(args, exec) {
        const mode = String(args.mode ?? '')
        if (mode !== 'env' && mode !== 'tools' && mode !== 'all') {
          throw new Error(
            `mop_probe_env: unknown mode "${mode}" (expected env|tools|all)`,
          )
        }
        const agent = exec.agent
        const parts = []
        if (mode === 'env' || mode === 'all') {
          parts.push(section('env'))
          parts.push(JSON.stringify(collectEnv(ctx, agent), null, 2))
        }
        if (mode === 'tools' || mode === 'all') {
          const surface = probeToolSurface(ctx, agent)
          parts.push(section('tools'))
          if (!surface.available) {
            parts.push(
              'tools 服务不可用：无法读取工具面（本工具仍按契约注册）。',
            )
          } else {
            parts.push(
              `可见工具 ${surface.total} 个；前缀分布 ${JSON.stringify(surface.byPrefix)}`,
            )
            parts.push(
              surface.violations.length === 0
                ? '契约校验：全部通过（object-root，无 null 类型，required ⊆ properties）。'
                : `契约校验：${surface.violations.length} 条违规——\n${surface.violations.map((v) => `  - ${v}`).join('\n')}\n发现违规时，上游会以 "Invalid schema for function ..." 拒绝整个请求，先卸下违规工具再继续。`,
            )
            parts.push(`工具名：${surface.tools.join(', ')}`)
          }
        }
        return parts.join('\n').replace(/^\n/, '')
      },
    }),
  )
}
