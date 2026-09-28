# mop-plugins

MiOpIIk workflow and recovery extensions for DeepSeek Harness (DSH).

**定位：** MiOpIIk 提供自己的协作 persona、工作流约束、规则注入、检查点与恢复能力。子代理生命周期、会话级模型授权、会话检索、技能发现/加载、插件装配由 DSH 原生能力负责；MiOpIIk 只对执行层增加一条策略：`subagent_execute` 必须显式给出非空 `provider` 和 `model`，随后仍由 DSH 原生工具校验会话授权并运行子代理。

## 兼容版本

本次 `0.3.1` 按当前官方发布组合对齐：DSH 核心 `0.1.7-rc.2`；官方独立工具包 `@deepseek-ai/dsh-tool-subagent` 和 `@deepseek-ai/dsh-tool-session-query` 均为 `0.1.7-rc.2`。工具包的 npm 版本号与 DSH 核心版本号不同，依赖按各自发布版本锁定。`0.3.0` 的公开版本不可覆盖，已由 `0.3.1` 修正。

官方能力依据：[DSH subagent tool](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/tool-subagent)、[session-query subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-query.md)、[DSH skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)。

## 安装

```bash
dsh plugin --profile <profile> add dsh-miopiik
npx dsh-miopiik
```

安装后由 DSH 重载对应 profile。`dsh-miopiik` 套件会装配 MiOpIIk 的恢复、策略与诊断插件，以及官方会话查询插件；子代理模型设置由 DSH 宿主原生提供。preset 模板位于 `examples/miopiik/`。

从 `0.2.x` 升级时，先检查 profile 插件清单并移除旧的 `dsh-miopiik-executor`、`dsh-miopiik-model-auth`、`dsh-miopiik-recall` 行，再安装新版套件。此前发布的 npm 版本保留并标记为已被 DSH 原生能力取代；不能通过 npm 删除已发布版本。

## 工具与能力

| 来源           | 工具/能力                                                                                                                           | 归属                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| DSH 原生       | `subagent`、`subagent_fork`、`subagent_plan`、`subagent_supervise`、`subagent_execute`                                              | 通用派发、模型选择与子代理生命周期                                        |
| DSH 原生       | `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read`                              | 历史会话检索与读取                                                        |
| DSH 原生       | skill filesystem 自动生成的可用技能目录，以及 `skill` 加载工具                                                                      | 技能目录、发现和加载                                                      |
| MiOpIIk        | 执行策略守卫                                                                                                                        | `subagent_execute` 要求显式 `provider` + `model`；授权由 DSH 原生设置检查 |
| MiOpIIk        | `mop_checkpoint`、`mop_checkpoint_list`、`mop_checkpoint_prune`、`mop_rewind`、`mop_rule_inject`、`mop_rule_show`、`mop_rule_clear` | 检查点、恢复与会话规则                                                    |
| MiOpIIk        | `mop_probe_capabilities`、`mop_run_stats`                                                                                           | DSH seam 诊断与 token 用量投影                                            |
| MiOpIIk opt-in | `mop_learn`                                                                                                                         | 将可复用流程写为项目 skill；目录浏览和加载交给 DSH                        |

子代理名称采用 DSH 的 `subagent_*` 系列，不额外加项目统一前缀。执行层每次必须显式提供 `provider` 和 `model`；候选路由与授权名单来自 DSH 原生模型设置。

## 保留的包

- `dsh-miopiik`：聚合安装入口与 preset 初始化命令。
- `dsh-miopiik-tool-recovery`：MiOpIIk 专属 checkpoint、rewind、prune 和规则注入。
- `dsh-miopiik-policy`：仅要求 `subagent_execute` 明确提供路由；调用授权、执行与生命周期交给 DSH。
- `dsh-miopiik-diagnostics`：DSH 能力兼容探测和 token 投影读取。
- `dsh-miopiik-learn`：只保留 `mop_learn` 技能创作工具。
- `dsh-miopiik-magic-keywords`：可选的提示词关键词 notice 插件。
- `dsh-miopiik-capabilities`、`dsh-miopiik-run-stats`、`dsh-miopiik-checkpoint`：既有包名兼容入口；默认套件不装载这些行。

## 发布与开发

该仓库使用 npm workspaces，所有保留的公开包按同一版本发布。运行现有检查：

```bash
npm run check
npm run lint
npm run format:check
npm test
```

发布记录见 [CHANGELOG.md](CHANGELOG.md)。历史实验与迁移设计保留在 `docs/`，仅作为对应时期的记录，不代表当前运行时契约。
