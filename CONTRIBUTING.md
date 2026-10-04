# Contributing

直接、简洁、无 Emoji、证据优先——文档与提交信息同样遵循。

## 开发环境

- Node >= 22.15（`engines` 约束）。
- `npm install --include=dev` 安装 eslint、prettier 和真实 schemastery。

## 门禁

| 命令                             | 作用                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run check`                  | 插件源码语法检查                                                                             |
| `npm run lint`                   | ESLint                                                                                       |
| `npm run format:check`           | Prettier；preset YAML 的源与打包副本保留逐字一致                                             |
| `bash tools/verify-crossrefs.sh` | 文档相对链接检查                                                                             |
| `npm test`                       | 单测；通过 `test/register-mocks.mjs` stub DSH workspace 模块                                 |
| `npm run test:composition`       | 可选真实 Loader 集成检查；需要 DSH 0.2.0-rc.2 源码 checkout，见 `test/composition/README.md` |

## 代码约定

- DSH 已有的子代理、模型设置、会话查询、技能目录/加载能力由 DSH 原生实现承担；不要重新添加平行工具。
- MiOpIIk 保留工作流 persona、恢复、规则注入、诊断和明确的技能创作能力。
- 文件写路径一律走 CAS（`replaceIfVersion` / `createIfAbsent`），不盲覆盖。
- 插件副作用归属当前 fiber（`ctx.effect` / 返回 disposer），stop/update 可回收。
- preset persona 源与运行副本由 `test/persona-sync.test.js` 核对；示例与 npm preset 逐字一致由 `test/dsh-miopiik.test.js` 核对。

## 版本与发布

同一 release train 的 8 个保留公开包（7 个插件/兼容包 + `dsh-miopiik` 套件）使用 lockstep 版本：

1. 所有公开 workspace 同步更新版本号和内部依赖范围，再刷新 `package-lock.json`。
2. 更新 `CHANGELOG.md`、README 和迁移说明。
3. 运行 `npm run check`、`npm run lint`、`npm run format:check`、`bash tools/verify-crossrefs.sh`、`npm test`；有 DSH checkout 时另跑真实组合测试。
4. 对每个 workspace 运行 `npm pack --dry-run`，核对文件清单。
5. 提交变更，建立对应 `v<x.y.z>` Git tag 并推送。
6. `npm publish --workspaces --access public` 发布 lockstep workspace；依赖包在 suite 之前发布。
7. 若移除已发布包的功能，保留 npm 历史 tarball，并用 `npm deprecate` 指向替代能力和迁移版本。不要 unpublish 历史版本。

0.x 阶段允许通过 minor 版本发布破坏性迁移；发布包的版本号遵循 SemVer。
