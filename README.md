# mop-plugins

MiOpIIk：DeepSeek Harness（DSH）的**策略到执行适配层**。原生优先——DSH 已经正面提供的能力，本仓库永不实现。

对齐 DSH `0.2.0-rc.2`。

## 定位

MiOpIIk 起初想做「运行时机制的提供者」——自造 executor、模型授权闸、会话检索、检查点、技能创作。这条路线在 DSH 0.2 / 0.2.1 已被上游系统性收编：Agent Teams 提供命名成员 + durable 消息 + 共享任务板，`session-checkpoint-policy` 提供崩溃前落盘，会话检索、技能目录与加载、token 投影、审批与权限预设全部内建。继续维护这些等于与上游对着干，每轮对齐都是把删掉的东西再删一遍。

所以定位收缩为：

> **MiOpIIk 不是一个功能插件，是一层「策略到执行的适配层」。**
>
> - **策略**（本体）：证据优先、授权闸、成本敏感、独立验收等工作纪律，落在 preset / persona 与 DSH 原生配置里。**这部分不写代码**，它才是不可替代的东西。
> - **适配**（本仓库的两个包）：DSH **刻意**保持「有原语、无模型面」的少数几处，给模型开一条窄缝。

**任何「DSH 没有所以我实现一个」的冲动，先反问「上游是不是刻意不做」——是，就别做。**

### DSH 的刻意分离（这是尺子）

上游的定式是**原语与模型面分离**，而且分离是刻意的——README 自己写明：

| DSH 能力                      | 原生模型面              | 上游的明示                                  |
| ----------------------------- | ----------------------- | ------------------------------------------- |
| `sessions.fork`               | 无（只有 Web GUI 按钮） | 三层调用者全是宿主/客户端                   |
| `systemPrompt.section`        | **无**                  | 「there is no end-user prompt-editing API」 |
| `tokenUsage` / `sessionStats` | **无**                  | 「registers nothing model-facing」          |
| `cordis_inspect_*`            | **有**                  | ——                                          |

所以「补一层模型面」是正当的，但必须承认它是在给一扇刻意关上的门开缝：**只开确实需要的缝，缝要窄到不可再窄，永不复制原语（只调 `ctx.*`）。**

## 三个包

### `dsh-agent-rewind` — 会话的命名恢复账本

DSH 有 `ctx.sessions.fork(source, boundary)` 这个原语，但**没有任何模型可见的 fork 工具**（三层：宿主 Service → 宿主 Remote → Web GUI 按钮，都对模型关闭），也没有「把历史某一轮命名」的持久索引。这个包就补这一条缝。

| 工具                    | 参数                            | 行为                                                                                                                        |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agent_checkpoint`      | `label!`, `note?`, `sessionId?` | 取目标会话最后一个 `turn/end` 的 seq 作 inclusive 边界，追加一行到 `<cwd>/.dsh/memory/checkpoints.md`；超过阈值自动裁最旧行 |
| `agent_rewind`          | `sessionId!`, `label!`          | 按 label 查最新一条，校验归属后 fork 出子会话并返回其 id（热/冷两条路径）                                                   |
| `agent_checkpoint_list` | —                               | 列出可解析的现行格式检查点行                                                                                                |

无工具面：根会话每轮追加 `auto-turn` 行、出错追加 `auto-error` 行（恢复遥测——写失败只 warn，绝不让轮次关闭失败）。

**冷路径用 DSH 公开的 `buildForkSeed`** 构造 seed：它负责给未闭合的尾巴补合成闭合事件（`session/end-seed` + `step/end` + `turn/end`）。少了这一步会 fork 出结构未闭合的子会话。

> **与 npm 上的第三方包 `dsh-rewind` 不是同一件事**：那个是人在 Web 里敲的 `/rewind` 斜杠命令、用 git 快照恢复**工作区文件**；本包是**模型自己调用**的工具、用 DSH 原生 fork 恢复**会话事件流**。机制、调用者、恢复对象全都不同，互为补充。

### `dsh-session-policy` — 会话级硬规则 + 诊断

| 工具             | 参数                                   | 行为                                                                                                      |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session_rule`   | `action!∈inject\|show\|clear`, `text?` | 注入 / 查看 / 撤销**只在当前会话生效**的硬规则（经 `agent.ctx.systemPrompt.section`），零文件、可一键撤销 |
| `session_doctor` | `mode!∈seams\|stats`, `sessionId?`     | `seams`：**实调**探测 DSH seam 并落盘 `.dsh/memory/capabilities.md`；`stats`：读 `tokenUsage` 投影四桶    |

`session_rule` 补的缝：`AGENTS.md` 是**持久 + 跨会话 + 全局**语义，替代不了「本会话生效 + 可撤销」。

`session_doctor(seams)` 相对原生 `cordis_inspect_*` 的真实增量：后者只给 **API 形状**且明文「cannot invoke business Service methods」；本工具给出**实调证据**（真调 `sessions.list()`、`sessionPersistence.open()+read()`）并把清单**落盘**供全队与人类复核。

### `mop-probe` — 部署探针（工具面契约审计）

| 工具            | 参数                    | 行为                                                                                             |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `mop_probe_env` | `mode!∈env\|tools\|all` | `env`：进程/部署/会话/模型事实；`tools`：审计每个可见工具的 JSON Schema 是否满足上游函数调用契约 |

**它是一次真实事故的产物**：2026-10-13，某个挂在 agent preset 里的第三方探针以 `mop_probe_env` 注册了空 schema，被 deepseek API 拒收——`Invalid schema for function 'mop_probe_env': schema must be a JSON Schema of 'type: "object"', got 'type: null'`——**该会话此后每一轮都失败**，与轮次内容无关。DSH 的 `tools.register()` 原样路径不做 object-root 校验，所以这道判据只能由插件侧自己守。

本包给出三层防线：注册形态唯一（一律 `defineTool()`，`test/mop-probe.test.js` 扫源码禁止绕过）、判据双向可用（扁平参数图与投影 schema 同判，CI 与运行时共用一份）、只读自检（读 `tools.schemas()` 且**报错不抛错**）。

与 `session_doctor` 的分工：后者探 DSH **seam 可用性**（失败=功能降级），本包探**这次请求能否被上游接受**（失败=整轮会话炸）。详见 [packages/mop-probe/README.md](packages/mop-probe/README.md)。

## 命名

**工具名前缀 = 所属包职责**，包名与工具名一一对应。

- 账本包 → `agent_*`，策略包 → `session_*`，探针包 → `mop_*`（0.5.0 起消灭的 `mop_` 前缀**只**用于诊断探针一个工具；它是独立包、不进 preset、不参与会话策略套件）。
- 这与 DSH 官方先例同形：包 `dsh-tool-session-query` → 工具 `session_*`。
- 包名保留 `dsh-` 前缀。**不要**用无前缀的 `agent-rewind` / `agent-checkpoint`——npm 上均已被同类项目占用，按「不代替已存在的」原则避开。

## 安装

```bash
dsh plugin --profile <profile> add dsh-session-policy
```

`dsh-session-policy` 声明依赖 `dsh-agent-rewind`，一条命令两个包一起装好。重启后由 DSH 重载 profile。

### 从 0.4.x 升级（破坏性）

0.5.0 删除了 8 个包、改动了全部工具名。**必须先清理旧行**：

1. 从 profile 插件清单移除（若存在）：`dsh-miopiik-tool-recovery`、`dsh-miopiik-diagnostics`、`dsh-miopiik-learn`、`dsh-miopiik-magic-keywords`、`dsh-miopiik-capabilities`、`dsh-miopiik-checkpoint`、`dsh-miopiik-run-stats`、`dsh-miopiik-policy`、`dsh-miopiik-executor`、`dsh-miopiik-model-auth`、`dsh-miopiik-recall`
2. 删除遗留 preset 目录（DSH 0.2 已不再读取）：`$DSH_HOME/.agent-presets/miopiik/`
3. 再 `add dsh-session-policy`

**工具改名对照**：

| 0.4.x                                                  | 0.5.0                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `mop_checkpoint`                                       | `agent_checkpoint`                                                                           |
| `mop_rewind`                                           | `agent_rewind`                                                                               |
| `mop_checkpoint_list`                                  | `agent_checkpoint_list`                                                                      |
| `mop_rule_inject` / `mop_rule_show` / `mop_rule_clear` | `session_rule(action:"inject"\|"show"\|"clear", text?)`                                      |
| `mop_probe_capabilities`                               | `session_doctor(mode:"seams")`                                                               |
| `mop_run_stats(sessionId)`                             | `session_doctor(mode:"stats", sessionId)`                                                    |
| `mop_checkpoint_prune(keep, confirm)`                  | 删除；`agent_checkpoint` 超 `maxCheckpoints`（默认 200）自动裁剪，回报 `; pruned <k> oldest` |
| `mop_learn`                                            | 删除（原生 `write` + `dsh-skill-filesystem` 已覆盖）                                         |

`checkpoints.md` 的**行格式未变**（`- [ISO] label | session=<sid> | seq=<n> [| note]`），历史检查点继续可读、可回溯。

## 退场条件（硬约束）

上游一开就拆，不留兼容层：

- DSH 给 `sessions.fork` 加模型可见工具 → `dsh-agent-rewind` 整体删除
- DSH 开放会话级提示编辑入口 → `session_rule` 删除
- DSH 给 token 投影加模型面 → `session_doctor(stats)` 删除
- DSH 在注册期校验工具参数 schema（拒绝空/非 object-root）→ `mop_probe_env(mode="tools")` 删除
- ~~DSH 提供「必须显式选路由」模式~~ → `dsh-miopiik-policy` **已于 0.5.0 提前删除**（它守的 `subagent_execute` 是 preset 里的行、不是插件能力；preset 配置归用户）

**每次 DSH 升级的标准动作**：重跑证据核对，被吸收的条目删除。

## 不进入的领域

以下都是 DSH 已经**正面提供**的能力，本仓库永不实现——即使看起来「可以做得更好」：

子代理派发与生命周期、Agent Teams 协作与任务板、模型授权与白名单、会话持久化与崩溃恢复、会话检索与 trace、技能目录/发现/加载、沙箱与审批策略、权限预设、压缩与上下文管理、计划模式、目标与 todo、工作流编排、Ralph 循环、插件清单与配置编辑。

判据：**上游已经做了，做得差也是上游的事。**

## 可选：恢复跨会话检索工具

本仓库不挂载 `@deepseek-ai/dsh-tool-session-query`（它提供模型可见的 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`），因为 DSH 的 Agent Teams profile 已自带协作面、与本定位重叠。它仍是官方包，需要时自行加回：

```bash
dsh plugin --profile <profile> add @deepseek-ai/dsh-tool-session-query
```

## 开发

```bash
npm run check              # node --check 全部入口（含 mop-probe）
npm run lint               # eslint（已 ignore .dsh/** 会话工作区）
npm run format:check       # prettier
npm test                   # 单元测试（stub 掉 harness 私有包）
npm run test:composition   # 真实 DSH Loader 挂载验证
```

真实加载器验证按 `DSH_HARNESS_ROOT` 找 DSH 源码 checkout，缺失时回退到已安装的 DSH 发行版，见 [test/composition/README.md](test/composition/README.md)。

发布记录见 [CHANGELOG.md](CHANGELOG.md)。[docs/](docs/) 下的设计文档是历史决策记录，描述的是当时实现，**不代表当前运行时契约**。
