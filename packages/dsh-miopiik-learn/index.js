import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'

export const name = 'dsh-miopiik-learn'
export const inject = ['tools', 'fs', 'sandboxPolicy']

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// skill 落点（D12，docs/design/memory-design.md）：项目 .dsh/skills/<name>/，须与 skill-filesystem 发现目录对齐。
const SKILLS_REL_DIR = '.dsh/skills'

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'mop_learn',
      description:
        'Mint a reusable procedure as a skill: write a SKILL.md (frontmatter name/description + body) under the project .dsh/skills/<name>/ (discovered by skill-filesystem). Land the learn/skill 分流 discipline from D12.',
      parameters: {
        name: { type: 'string', required: true },
        description: { type: 'string', required: true },
        content: { type: 'string', required: true },
        replace: { type: 'boolean' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const name = (args.name || '').trim()
        if (!NAME_RE.test(name))
          throw new Error(
            `mop_learn: invalid skill name "${name}" (kebab-case, no leading hyphen)`,
          )
        const description = (args.description || '').trim()
        if (!description) throw new Error('mop_learn: description required')
        if (/[\r\n]/.test(description))
          throw new Error('mop_learn: description 必须为单行（禁止换行）')
        if (!(args.content || '').trim())
          throw new Error('mop_learn: content required')
        const replace = args.replace === true
        const agent = exec.agent
        const cwd =
          agent &&
          agent.session &&
          agent.session.header &&
          agent.session.header.cwd
        if (!cwd) throw new Error('mop_learn: session cwd unavailable')
        const dir = join(cwd, SKILLS_REL_DIR, name)
        // description 用 JSON.stringify 序列化为 YAML 双引号串：引号/冒号/#/--- 等
        // 特殊字符不会破坏 frontmatter（skill-filesystem 用真 YAML 解析器，已核实）。
        const body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${args.content.trim()}\n`
        const target = await ctx.fs.resolve(join(dir, 'SKILL.md'), { cwd })
        const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
        // 无覆盖保护：skill 是持久化记忆资产，静默覆盖危险。默认 createIfAbsent；
        // 显式 replace:true 才用 CAS（replaceIfVersion @ 观测版本）覆盖，并发改动报
        // FS_STALE_VERSION 而非静默吞掉他人产出。
        const info = await ctx.fs.stat(target)
        const exists = info !== undefined
        if (exists && !replace) {
          throw new Error(
            `mop_learn: skill "${name}" already exists at ${dir}/SKILL.md — ` +
              `pass replace:true to overwrite（保护既有产物，避免静默破坏）`,
          )
        }
        try {
          await ctx.fs.writeText(
            target,
            body,
            exists
              ? { kind: 'replaceIfVersion', version: info.version }
              : { kind: 'createIfAbsent' },
            // P3-10（issue #3）：透传 exec.signal，工具取消时写路径可中止
            exec.signal,
            policy,
          )
        } catch (error) {
          if (error && error.code === 'FS_NOT_OBSERVED') {
            throw new Error(
              `mop_learn: skill "${name}" was created concurrently — re-run to inspect before replacing`,
            )
          }
          if (error && error.code === 'FS_STALE_VERSION') {
            throw new Error(
              `mop_learn: skill "${name}" changed since read — re-read then retry replace`,
            )
          }
          throw error
        }
        return exists
          ? `skill replaced: ${name} -> ${dir}/SKILL.md`
          : `skill minted: ${name} -> ${dir}/SKILL.md`
      },
    }),
  )
}
