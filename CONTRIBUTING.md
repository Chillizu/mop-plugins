# Contributing

直接、简洁、无 Emoji、证据优先——文档与提交信息同样遵循。

## 开发环境

- Node >= 22.15（`engines` 约束）。
- `npm install --include=dev`（本仓库依赖 devTools：eslint / prettier；若环境设了 `NODE_ENV=production`，不带 `--include=dev` 会静默跳过它们）。

## 门禁（PR 前全部通过）

| 命令                             | 作用                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                  | 全部插件源码 `node --check` 语法门                                                                                 |
| `npm run lint`                   | eslint                                                                                                             |
| `npm run format:check`           | prettier（examples/miopiik/agent.cordis.yml 与 meta 的 preset/ 副本被 .prettierignore 排除，防格式化破坏逐字同步） |
| `bash tools/verify-crossrefs.sh` | 文档相对链接断链检查                                                                                               |
| `npm test`                       | 单测（mock seam；经 test/register-mocks.mjs 预载，勿裸跑 node --test）                                             |
| `npm run test:composition`       | 真实 Loader 组合测试，需要本机 harness checkout（见 test/composition/README.md 的 CI coverage boundary）           |

## 代码约定

- 每包单职责、fail-closed：seam 缺失时清晰报错而非炸加载；
- 文件写路径一律走 CAS（replaceIfVersion / createIfAbsent），不盲覆盖；
- 插件内注册的一切副作用必须归属当前 fiber（`ctx.effect` / 返回 disposer），stop/update 可回收；
- persona「定稿源 ↔ 运行时副本」逐字同步由 `test/persona-sync.test.js` 钉死；meta 包的 preset/ 副本与 examples/miopiik 的逐字一致由 `test/dsh-miopiik.test.js` 钉死。改一处必须同步另一处；
- 改动涉及设计决策时：先改 `docs/PLAN.md` 对应决策行 → 同步承载文档代码块 → 在 philosophy-audit §2 登记漂移修复（详见 PLAN.md §6 维护规则）。

## 版本策略（lockstep）

0.1.x 进入 maintenance-only：只接安全、上游兼容、正确性与文档修复，不新增 feature package。0.2 的收敛与 legacy package 迁移规则见 [docs/design/0.2-transition.md](docs/design/0.2-transition.md)。已发布包不通过 unpublish 做清理；默认 bundle 的移除属于 0.2 breaking 迁移，并须先有兼容路径与组合测试。

同一 release train 中实际发布的 `dsh-miopiik-*` 包 + 套件包 `dsh-miopiik` 同号同发（0.1.x 为 9 个插件包；0.2 开始新增收敛域包并保留兼容包）：

1. 发版前把全部 workspace `version` 改成同一号（meta 包依赖用 `^` range，无需逐包改）：
   `npm version <x.y.z> --workspaces --no-git-tag-version && git commit -am "chore(release): v<x.y.z>"`;
2. 更新 `CHANGELOG.md`；
3. 打 tag 并推送：`git tag v<x.y.z> && git push origin main v<x.y.z>`；
4. 本地逐包发布（9 子包在前、meta 包最后）：
   `for p in packages/dsh-miopiik-*; do (cd $p && npm publish --access public); done && (cd packages/dsh-miopiik && npm publish --access public)`；
5. 出 GitHub Release（草稿或正式均可）：`gh release create v<x.y.z> --generate-notes`。

> 注：自动发布 workflow（release.yml）因 GitHub workflow 文件解析问题从未生效，已于 0.1.13 移除；发布保持维护者本机手动执行。若日后需要自动化：重写 workflow 时注意先验证文件被 Actions 接受（`actions/workflows` API 列出且 name 正常），再打 tag 触发。

0.x 阶段允许 BREAKING CHANGE（minor 位）；1.0 后遵循 SemVer。
