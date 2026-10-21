// 事故防线：**工具 schema 必须能被上游接受**。
//
// 2026-10-13 实况：web profile 上一个第三方探针以 `mop_probe_env` 注册了空 schema，
// deepseek API 拒绝整个请求 ——
//   Invalid schema for function 'mop_probe_env': schema must be a JSON Schema of
//   'type: "object"', got 'type: null'.
// 该会话此后**每一轮都失败**，与轮次内容无关；而 DSH 的 `tools.register()` 原样
// 路径不做 object-root 校验，插件侧代码全绿也照样炸。所以判据必须落在本仓库能管住
// 的一侧：所有工具一律经 `defineTool()`，并用这里的测试把它钉死。
//
// 覆盖两层：
//   1. 判据本身（toolSchemaViolations）——含反例，防止测试真空通过；
//   2. 全部 workspace 包的实际注册结果——插件代码改坏时立刻现形。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import * as policy from '../packages/dsh-session-policy/index.js'
import * as ledger from '../packages/dsh-agent-rewind/index.js'
import * as probe from '../packages/mop-probe/index.js'
import { createHarnessFactory, rootAgent, runTool } from './harness-mocks.mjs'

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')
const WORKSPACE_PLUGINS = [policy, ledger, probe]

const harnessFor = (plugin) => createHarnessFactory(plugin.apply)()

/** 注册一个插件的全部工具，返回模型面 schema（name/description/parameters）。 */
function registeredSchemas(plugin, options) {
  const harness = harnessFor(plugin)
  if (options) Object.assign(harness.services, options.services)
  harness.apply()
  return harness.registered.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

test('the violation predicate catches the exact production failure', () => {
  // 正例：空对象参数（零参工具的唯一合法形态）。
  assert.deepEqual(
    probe.toolSchemaViolations({
      name: 'ok',
      parameters: { type: 'object', properties: {} },
    }),
    [],
  )
  // 反例 1：`type: null` —— 就是线上那一条（恰一条违规，不重复计）。
  assert.equal(
    probe.toolSchemaViolations({
      name: 'bad',
      parameters: { type: null, properties: {} },
    }).length,
    1,
  )
  // 反例 2：parameters 整体缺失（旧代码常见）。
  assert.equal(probe.toolSchemaViolations({ name: 'bad' }).length, 1)
  // 反例 3：parameters 显式为 null。
  assert.equal(
    probe.toolSchemaViolations({ name: 'bad', parameters: null }).length,
    1,
  )
  // 反例 4：非 object-root。
  assert.ok(
    probe
      .toolSchemaViolations({ name: 'bad', parameters: { type: 'string' } })
      .some((v) => v.includes('object')),
  )
  // 反例 5：嵌套里出现 null 类型（上游同样拒绝）。
  assert.ok(
    probe
      .toolSchemaViolations({
        name: 'bad',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'object', properties: { y: { type: null } } },
          },
        },
      })
      .some((v) => v.includes('null')),
  )
  // 反例 6：required 引用了未声明的字段。
  assert.ok(
    probe
      .toolSchemaViolations({
        name: 'bad',
        parameters: { type: 'object', properties: {}, required: ['ghost'] },
      })
      .some((v) => v.includes('ghost')),
  )
  // 反例 7：properties 缺失 —— 不致命但必须被记录，不许静默。
  assert.ok(
    probe
      .toolSchemaViolations({ name: 'bad', parameters: { type: 'object' } })
      .some((v) => v.includes('properties')),
  )
})

test('every tool registered by every workspace package satisfies the upstream contract', () => {
  let total = 0
  for (const plugin of WORKSPACE_PLUGINS) {
    const schemas = registeredSchemas(plugin)
    assert.ok(schemas.length > 0, `${plugin.name} must register tools`)
    total += schemas.length
    for (const schema of schemas) {
      assert.equal(
        typeof schema.description,
        'string',
        `${schema.name} needs a model-facing description`,
      )
      // 判据吃扁平参数图与投影 schema 两种形态（`defineTool` 收扁平的，测试替身
      // 也原样返回扁平的；运行时读到的则是投影后的 JSON Schema）。
      assert.deepEqual(
        probe.toolSchemaViolations(schema),
        [],
        `${schema.name} would make the upstream API reject every request of the session`,
      )
      // 扁平形态的结构判据：每个字段必须是对象，且 `required: true` 的字段真的存在。
      const parameters = schema.parameters
      assert.ok(
        parameters &&
          typeof parameters === 'object' &&
          !Array.isArray(parameters),
        `${schema.name} parameters must be a flat field map (zero-arg tools pass {})`,
      )
      for (const [field, spec] of Object.entries(parameters)) {
        assert.ok(
          spec && typeof spec === 'object' && !Array.isArray(spec),
          `${schema.name}.${field} must be a parameter spec object`,
        )
        assert.equal(typeof spec.type, 'string', `${schema.name}.${field}.type`)
      }
      // 投影形态的结构判据：同一份图归一后必须是 object-root。
      const projected = probe.normalizeParameterSchema(parameters)
      assert.equal(
        projected.type,
        'object',
        `${schema.name} must project to an object-root schema`,
      )
      assert.ok(
        projected.properties &&
          typeof projected.properties === 'object' &&
          !Array.isArray(projected.properties),
        `${schema.name} must project to an object properties map`,
      )
      for (const key of projected.required ?? []) {
        assert.ok(
          Object.hasOwn(projected.properties, key),
          `${schema.name} required[] names undeclared field ${key}`,
        )
      }
    }
  }
  // 反向自检：三个包的工具总数必须 > 0，否则上面的循环可能整体空转。
  assert.ok(total >= 4, `expected at least 4 workspace tools, got ${total}`)
})

test('the probe registers exactly one tool with a frozen flat parameter map', () => {
  const schemas = registeredSchemas(probe)
  assert.deepEqual(
    schemas.map((schema) => schema.name),
    ['mop_probe_env'],
  )
  const [tool] = schemas
  // 扁平形态下的必填标记：`required: true`，由 defineTool 收进 schema 的 required[]。
  assert.deepEqual(Object.keys(tool.parameters), ['mode'])
  assert.equal(tool.parameters.mode.required, true)
  assert.deepEqual(tool.parameters.mode.enum, ['env', 'tools', 'all'])
  const projected = probe.normalizeParameterSchema(tool.parameters)
  assert.deepEqual(projected.required, ['mode'])
  assert.deepEqual(Object.keys(projected.properties), ['mode'])
})

test('defineTool itself guarantees the object root the incident lacked', () => {
  // 上游契约的最后一层证据：空参数图必须投影成 properties:{}，而不是 null/type:null。
  // 这里**不**依赖测试替身 defineTool 的行为，直接对判据的归一入口断言——替身
  // 原样返回扁平图（见 test/stubs/dsh-tools.js），拿它的输出证明上游契约会变成
  // 「用替身证明替身」的循环论证。
  const zeroArg = probe.normalizeParameterSchema({})
  assert.deepEqual(zeroArg, { type: 'object', properties: {} })
  assert.deepEqual(
    probe.toolSchemaViolations({ name: 'zero', parameters: zeroArg }),
    [],
  )

  const oneArg = probe.normalizeParameterSchema({
    mode: { type: 'string', required: true, enum: ['a'] },
    note: { type: 'string' },
  })
  assert.deepEqual(oneArg, {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['a'] },
      note: { type: 'string' },
    },
    required: ['mode'],
  })
  assert.deepEqual(
    probe.toolSchemaViolations({ name: 'one', parameters: oneArg }),
    [],
  )
})

/** 取从 `source[index]` 处 `(` 起、配对到 `)` 为止的实参文本（保持原样，未 trim）。 */
function argumentTextAt(source, index) {
  let depth = 0
  for (let i = index; i < source.length; i += 1) {
    const char = source[i]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(index + 1, i)
    }
  }
  return source.slice(index)
}

/** 去掉注释再扫：注释里出现的 `tools.register()` 是散文，不是调用点。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('no workspace package can bypass defineTool when registering a tool', () => {
  // `tools.register()` 的原样路径不做 object-root 校验，绕过 defineTool 就等于把
  // 「空 schema 炸整个会话」重新引进来。注册形态必须是 `register(defineTool({…}))`。
  //
  // 判定取 register 的**实参文本**并按配对括号切出，不用固定字符窗口：description
  // 一长，`defineTool(` 就落在窗口外，合规代码被误报（本测试初版即如此）。
  const offenders = []
  let sites = 0
  for (const dir of readdirSync(PACKAGES)) {
    if (!statSync(join(PACKAGES, dir)).isDirectory()) continue
    for (const file of readdirSync(join(PACKAGES, dir))) {
      if (!file.endsWith('.js')) continue
      const source = stripComments(
        readFileSync(join(PACKAGES, dir, file), 'utf8'),
      )
      for (const match of source.matchAll(/\.register\(/g)) {
        sites += 1
        const argument = argumentTextAt(
          source,
          match.index + '.register'.length,
        ).trim()
        if (!argument.startsWith('defineTool('))
          offenders.push(`${dir}/${file}`)
      }
    }
  }
  // 反向自检：确实扫到了注册点，否则上面的循环可能整体空转。
  assert.ok(
    sites >= 3,
    `expected at least 3 register() call sites, got ${sites}`,
  )
  assert.deepEqual(
    offenders,
    [],
    `these call sites register a tool without defineTool:\n${offenders.join('\n')}`,
  )
})

test('probeToolSurface reports violations instead of throwing when the tool surface is malformed', async () => {
  const harness = harnessFor(probe)
  harness.apply()
  // 故意让 schemas() 返回线上那一条坏 schema。
  harness.services.tools.schemas = () => [
    { name: 'mop_probe_env', parameters: { type: 'object', properties: {} } },
    { name: 'legacy_probe', parameters: { type: null, properties: {} } },
  ]
  const text = await runTool(
    harness,
    'mop_probe_env',
    { mode: 'tools' },
    { agent: rootAgent() },
  )
  assert.match(text, /legacy_probe/)
  assert.match(text, /契约校验：1 条违规/)
})
