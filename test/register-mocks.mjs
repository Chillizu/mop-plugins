import { registerHooks, createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 只 stub harness 的**两个**包：@deepseek-ai/dsh-tools / dsh-llm。它们是 harness
// workspace 包（不在 npm），必须 stub 才能在无 harness checkout 的情况下 import。
// @deepseek-ai/dsh-session 与 schemastery 走**真实**实现（见根 devDependencies）：
// dsh-session 提供 buildForkSeed，冷路径 fork 的正确性依赖它，用 stub 会掩盖真实行为；
// schemastery 的真实实现能在 import 时抓住 Config 契约 bug。
const stubs = new Map([
  ['@deepseek-ai/dsh-tools', 'dsh-tools.js'],
  ['@deepseek-ai/dsh-llm', 'dsh-llm.js'],
])

// dsh-agent-rewind 静态硬 import `@deepseek-ai/dsh-session/fork` 的 buildForkSeed。
// 该包是根 devDependency，正常解析就够了；本回退只在**依赖尚未安装**（干净 clone 未跑
// npm install）时兜底到已安装 DSH 发行版里的**真实现**（同一 rc 版本 0.2.0-rc.2）——不是
// stub，语义与线上一致。正常解析优先命中，回退不生效。
const DSH_INSTALL_ROOTS = [
  process.env.DSH_MODULES_ROOT,
  join(
    dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    '@deepseek-ai',
    'dsh',
  ),
  join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
].filter(
  (root) => root && existsSync(join(root, 'node_modules', '@deepseek-ai')),
)

function resolveFromDshInstall(specifier) {
  if (!specifier.startsWith('@deepseek-ai/')) return null
  for (const root of DSH_INSTALL_ROOTS) {
    try {
      const require = createRequire(join(root, 'package.json'))
      return pathToFileURL(require.resolve(specifier)).href
    } catch {
      // 该 root 没有这个包（或子路径不在 exports 里）→ 试下一个
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) {
      return {
        url: new URL('./stubs/' + stubs.get(specifier), import.meta.url).href,
        shortCircuit: true,
      }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        const fallback = resolveFromDshInstall(specifier)
        if (fallback !== null) return { url: fallback, shortCircuit: true }
      }
      throw error
    }
  },
})
