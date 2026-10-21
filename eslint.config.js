import js from '@eslint/js'
import globals from 'globals'

export default [
  // `.dsh/**` 是会话期工作区（记忆、检查点、recon 调查产物），不属于源码。
  // 它已在 .gitignore 里；lint 也必须排除，否则会报一堆与仓库无关的错误。
  { ignores: ['node_modules/**', 'docs/**', '.local/**', '.dsh/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.builtin, ...globals.node },
    },
  },
]
