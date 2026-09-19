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

0.1.x 是 maintenance-only 历史线：只接安全、上游兼容、正确性与文档修复，不再增加 feature package。0.2 的收敛与 legacy package 迁移规则见 [docs/design/0.2-transition.md](docs/design/0.2-transition.md)。已发布包不通过 unpublish 做清理；compatibility / opt-in 包继续保留可解析的 npm 名称。

同一 release train 中 10 个公开 plugin/compatibility workspace + 套件包 `dsh-miopiik` 同号同发：

1. 发版前把全部 workspace `version` 改成同一号，并同步所有内部 `dsh-miopiik-*` dependency range 到 `^<x.y.z>`；随后刷新 `package-lock.json`。不要只 bump package version 而留下旧内部 range。
2. 更新 `CHANGELOG.md`、README 的默认 runtime / compatibility 口径与迁移说明。
3. 跑完整 release gate：`npm ci`、`npm run check`、`npm run lint`、`npm run format:check`、`bash tools/verify-crossrefs.sh`、`npm test`，并跑 pinned + upstream master 的真实 DSH Composition。
4. 对每个公开 workspace 执行 `npm pack --dry-run`，确认 files/bin/patch 均进入 tarball，且没有私有运行态文件。
5. 合并 release PR 后打 tag：`git tag v<x.y.z> && git push origin main v<x.y.z>`。
6. **按依赖顺序**本地发布，不能用目录字母序通配符：
   - 第一批（无 MiOpIIk workspace 依赖）：`dsh-miopiik-tool-recovery`、`dsh-miopiik-executor`、`dsh-miopiik-magic-keywords`、`dsh-miopiik-model-auth`、`dsh-miopiik-learn`、`dsh-miopiik-recall`、`dsh-miopiik-checkpoint`、`dsh-miopiik-diagnostics`；
   - 第二批（依赖 diagnostics）：`dsh-miopiik-capabilities`、`dsh-miopiik-run-stats`；
   - 最后发布套件包 `dsh-miopiik`。
7. 出 GitHub Release：`gh release create v<x.y.z> --generate-notes`。

> 注：自动发布 workflow（release.yml）因 GitHub workflow 文件解析问题从未生效，已于 0.1.13 移除；发布保持维护者本机手动执行。若日后需要自动化：重写 workflow 时注意先验证文件被 Actions 接受（`actions/workflows` API 列出且 name 正常），再打 tag 触发。

0.x 阶段允许 BREAKING CHANGE（minor 位）；1.0 后遵循 SemVer。
