# Changelog

所有对外可见的变更记录在本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 SemVer；同一 release train 中实际发布的 `dsh-miopiik-*` 包 + 套件包 `dsh-miopiik` 采用 **lockstep 版本**（同号同发）。

## [Unreleased]

### Changed

- 0.1.x enters maintenance mode: security, upstream compatibility, correctness and documentation only; no new feature package is planned for this line.
- Added the 0.2 transition contract: retain the published packages for compatibility while converging long-term ownership on recovery, policy and diagnostics; executor/recall/learn move toward native DSH capabilities and magic-keywords becomes optional legacy functionality.
- No runtime bundle membership changes are made by this maintenance step.
- **0.2 recovery migration (implementation branch):** `dsh-miopiik-tool-recovery` now owns event-driven `auto-turn` / `auto-error` persistence in addition to manual checkpoint/rewind/prune. The default preset stops mounting `dsh-miopiik-checkpoint`; the old package remains published/installable as a compatibility surface and stays a meta-package dependency for one migration window.
- **0.2 diagnostics migration (stacked implementation):** added `dsh-miopiik-diagnostics` as the single owner of capability probing and token run-stat logic. `dsh-miopiik-capabilities` / `dsh-miopiik-run-stats` become thin compatibility wrappers; default meta/preset mount only diagnostics while retaining the old packages as migration dependencies.

## [0.1.13] - 2026-08-28

### Added

- `dsh-miopiik-checkpoint`（新包，套件第 9 插件）：**里程碑自动检查点**——根会话（`delegationDepth=0`）每轮关闭时由 `agent/turn-stopping` 事件自动追加 `auto-turn` 行到 `.dsh/memory/checkpoints.md`（ISO 时间 / session / turn / 本轮 user 消息摘要，120 字符截断）；`agent/error` 事件记 `auto-error` 行；同 turn 多次触发（steer 重读）去重。记忆落盘由**结构事件驱动**，不再依赖 persona 自觉调 `mop_checkpoint`（弱模型不守提示词规则是初版反馈核心）；`mop_checkpoint` 保留为显式命名里程碑。子代理轮次不落盘（防 executor 高频轮次冲成噪音）。
- meta `dsh-miopiik`：聚合 patch 8→9 行；preset 新增 `dsh-miopiik-checkpoint` 行；persona checkpoint 文案随自动落盘机制更新（review.prompt.md 定稿源同步）。

### 备注

- 生产验证：重启后首个关闭轮次自动落盘第 1 条 auto-turn（session / turn / user 摘要与当前会话日志逐字吻合）。

## [0.1.12] - 2026-08-28

### Fixed

- `dsh-miopiik-recall`：**流式解压扫描，根治大会话超限 skip（0.1.11 冒烟实测）**——工作区历史中含 20M+ 的 `.jsonl.zstd` 大会话，原 `execFile` 64MB `maxBuffer` 整文件缓冲导致 `stdout maxBuffer length exceeded` 被 skip。改为 `zstd` 子进程管道 + readline 逐行扫描，命中即收、达上限即 kill，内存只驻留命中行；`maxLines` 提前终止行为新增测试覆盖。`mop_recall` 现可检索任意大小的历史会话。

### 备注

- 0.1.11 的 B1 修复（stopReason=error 判定）已发布但尚未加载验证：需重启 DSH web 后复测。

## [0.1.11] - 2026-08-28

### Fixed

- `dsh-miopiik-executor`：**B1 真因修复（第三轮，0.1.10 仍未生效的原因找到）**——子代理失败并不是 reject：DSH 以 `stopReason='error'` 的**成功 resolve** 返回失败结果（真实拒绝文案写在子会话日志的 turn/end error）。0.1.9/0.1.10 的 catch 只拦 reject，拦不到失败结果，故空 `[error]` 依旧。现在在正常返回路径上显式判定 `stopReason ∈ {error, failed}`，输出可读失败文案（stopReason + 子会话 id + result.error/message 原因，缺失时给「见子会话日志（常见：模型闸拒绝/深度超限/工具限制）」指引）。新增 2 条 stopReason=error 回归测试。

## [0.1.10] - 2026-08-28

### Fixed

- `dsh-miopiik-executor`：**闸门拒绝原因回到调用者（0.1.9 验收 B1 复测仍 FAIL 的根因修复）**——0.1.9 只包住了 `run.result` 错误，实测闸拒发生在 `subagents.start()` 内部（子代理发布前），且 Cordis 包装的 reject error 常为空 message。现在 **start() 与 run.result 两个阶段都捕获**并构造可读错误（含子会话 id；空 message 时给出「无错误详情，常见原因为模型闸拒绝/深度超限」指引），工具结果不再出现空 `[error]`。
- `dsh-miopiik-recall`：**scope=session 恒空修复（0.1.9 验收 R4c）**——`sessionFiles` 解析出的 sessionId 已去 `session-` 前缀，而 `header.id/session.id` 为带前缀的完整 SessionId，严格相等永不命中。改为归一化比较（双方去前缀），并补带前缀形态的回归测试。

## [0.1.9] - 2026-08-27

### Fixed

- `dsh-miopiik-model-auth`：**授权对闸门即时生效（0.1.8 验收 B3）**——preset 在每 agent 上下文实例化插件，原实例级缓存导致「授权只更新工具面实例、子代理闸面实例仍持旧快照」。改为进程级共享缓存 + 文件 mtime 失效，工具面与闸面同源；种子条目 revoke 的进程内屏蔽同样跨实例共享。
- `dsh-miopiik-executor`：**子代理失败原因回传（B1）**——闸拒/会话失败不再以空 `[error]` 消失，错误 message + 子会话 id 一并返回调用者。
- `dsh-miopiik-executor`：**mop_dispatch 迁出插件、改由 preset 装配（C2）**——executor 插件实例与 preset 工具行分属不同注册作用域，`tools.get('subagent_planner')` 跨作用域取不到，导致「规划层未注册」。现由 preset 新增 `tool-subagent-dispatch` 行（与 subagent_planner 同级同机制：persona/模型/toolFilter 全在 preset 显式配置，规划层模型经 `&planner-model` 锚点与 planner 行同源，仍零默认零兜底）。
- `dsh-miopiik` preset：**补装配 `dsh-miopiik-recall` 行（D）**——0.1.8 仅更新了聚合 patch，preset 漏装导致 mop_recall 工具缺席；另补 `dsh-miopiik-recall/cordis.patch.yml` 供逐包安装路径使用。

## [0.1.8] - 2026-08-27

### Changed

- `dsh-miopiik-model-auth`：**授权收紧为工作区级**——allowlist 从全局文件（`~/.dsh/memory/global/model-allowlist.md`）迁至 `<workspace>/.dsh/memory/model-allowlist.md`；不同工作区互相隔离，同一模型换项目须重新授权；`mop_model_authorize/revoke/list` 均按当前会话 cwd 解析，`mop_model_list` 标注 allowlist 文件路径。`config.allowlistPath` 绝对路径仍可显式覆盖，相对路径相对工作区根解析。原全局文件已清空（撤回全部历史授权）。

### Added

- `dsh-miopiik-recall`（新包，套件第 8 个插件）：`mop_recall` 工具——会话级/工作目录级历史消息检索：扫描 `~/.dsh/sessions/<cwd-slug>/` 下所有会话日志（`.jsonl.zstd`，经 zstd 解压），返回 user/assistant 消息中匹配 query 的行（时间 + 会话 id + 角色 + 文本截断）与扫描/命中统计。参数：`query`（必填）、`scope`（workspace 默认 / session）、`caseSensitive`（默认忽略大小写）、`maxLines`（默认 50）。`Config.sessionsRoot` 可覆盖日志根。

## [0.1.7] - 2026-08-27

### Changed

- `dsh-miopiik-executor`：**零默认零兜底**——删除 Config 的 provider/model 静态默认、`policyPath` 决策文件读取与 `model="inherit"` 调用者继承通道；`mop_spawn_executor` 模型来源唯一 = 调用方显式 `model`+`provider`，缺失即抛错。`model-policy.md` 降级为审查层决策记录（D33 落盘供模板引用），executor 不再自动读取。
- `dsh-miopiik-executor`：`mop_dispatch` 去掉强模型兜底直 spawn（及 `orchestrationProvider/Model` 配置）——规划层模型唯一来源 = preset `tool-subagent-planner` 行显式配置；该行未注册即 fail-closed 报错，绝不伪造编排。
- preset：模型流契约措辞全面去「默认/兜底/继承」——审查层任务分配、硬规则第 4 条（弱模型路径）、规划层工作顺序第 5 条、模型流向唯一契约段同步为显式传参口径；「规划层永远跑强模型」改为「规划层模型由 preset subagent_planner 行显式配置」。
- 文档：review/planner 定稿源与 examples/miopiik 副本随措辞变更回填同步。

## [0.1.6] - 2026-08-27

### Added

- `dsh-miopiik-executor`：新增 `mop_dispatch` 工具（D36，弱模型分层唤起的结构性修复）——审查层（即便跑在弱模型上）收到实现类任务只需调这一条工具，即可在强模型上拉起规划层完成真正的规划/派发。优先复用 preset 的 `subagent_planner`（persona/toolFilter 不重复定义），未注册时兜底直 spawn 强模型规划层（新 Config `orchestrationProvider`/`orchestrationModel`，默认 `opencode-go/hy3`）；可选 `executionModel` 参数透传给规划层。
- `dsh-miopiik-executor`：`mop_spawn_executor` 双参省略时从 `.dsh/memory/model-policy.md` 读执行层模型兜底（一行 `provider/model`），文件缺失或解析不出即 fail-closed 抛错——与 D32 显式传参契约闭环。

### Changed

- preset：审查层任务分配新增 D36——实现类任务第一动作必须是 `mop_dispatch(task)`，审查层本人绝不写实现代码；硬规则新增第 4 条「弱模型兜底」：弱模型不做多步编排，一条调用交强模型规划层接管。
- preset：规划层工作顺序第 5 条改为每次 `mop_spawn_executor` **必须显式传 `model`+`provider`**（取自任务书 2.1，格式 `provider/model`）——executor 已 fail-closed，禁止省略、禁止臆测模型名。
- preset：模型字面量全部改为本部署真实模型（常规子代理 `opencode-go/mimo-v2.5`、规划层 `hy3`），移除不存在的 `deepseek-*` 误导性默认值；「执行层模型确认」选项去掉「跟随本会话模型」（成本放大误导），仅保留默认/自定义。
- 文档落地：examples/miopiik 副本与 `docs/design/presets/drafts/` 定稿源（review/planner）回填至与运行时副本逐字同步。

## [0.1.5] - 2026-08-26

### Added

- `dsh-miopiik-capabilities`：能力清单头部新增「本会话层级」行——按 delegationDepth 标注当前层（0=审查层/1=规划层/2+=执行·监督或更深）与层级预算（四层架构：审查(0)→规划(1)→执行·监督(2)；极端第 3 层须授权闸），各层自查位置。

### Changed

- preset：审查层硬规则新增「层级与深度预算」（D36）、规划层 persona 新增「层级纪律」——depth 2 为叶子不再派发，级联加深须先向审查层申请授权；runbook §3.1 固化层级拓扑表。

### Fixed

- preset：移除对上游 rc.2 已删除包 `@deepseek-ai/dsh-tool-session-query` 的幽灵行引用——该行导致 miopiik 预设挂载即失败（`agent-preset-invalid: failed to import loader entry`，切换秒退回上一预设），替换为解释性注释。
- preset：派发分流硬规则收窄（D35）——原「评测/对比等可控场景禁派发」豁免被模型援引跳过整条流水线（A/B 基准实测：实现类任务全程单机执行）。收窄为：豁免仅限**不产出工件的纯问答/诊断/检索讨论**；实现类任务无论大小一律走规划层→执行层；授权闸与 D33 模型确认合并为同一次 `ask_user_question`；任务书声明全自动时视为预授权。
- `dsh-miopiik-executor`：修复 `mop_spawn_executor` 的 `maxDepth` 语义错用——该参数是**绝对**深度上限而非相对层数，写死 1 使规划层（delegationDepth 1）派发必然 `SubagentDepthError: depth 2 exceeds maxDepth 1`，规划层被迫亲自下场写码（三层架构退化为两层，ench1 基准实测撞上）。改为随调用者深度浮动 `parentDepth + 1`：执行器恒为调用者的下一层叶子、不可再级联。

## [0.1.3] - 2026-08-26

### Changed

- preset：执行层模型不再硬编码（D33）——审查层在**派首个规划层前**经 `ask_user_question` 向用户确认一次执行层模型（先 `mop_model_list` 构造动态选项：默认模型／跟随本会话模型／自定义），决策落盘 `.dsh/memory/model-policy.md`（用户表示"以后别问"则记 `auto` 静默沿用），并随模板 2.1 新增的「执行层模型」字段传给规划层；规划层按字段传参（`provider/model` 显式传／「继承」省略 model 交由 D32／缺失向审查层索要）。取代 0.1.2 的固定 `deepseek-v4-flash` 指引，后续新增任何模型无需改 persona。

## [0.1.2] - 2026-08-26

### Added

- `dsh-miopiik-model-auth`：`mop_model_list` 升级为模型发现面——经 `llm` 服务枚举本部署可路由的 providers × models，逐条标注 `[默认]`/`[已授权]`；单 provider 枚举失败被隔离呈现，seam 缺失仅失去枚举不崩（D31）。
- `dsh-miopiik-model-auth`：新增 `Config.allowlist`（`provider/model` 行数组）——组合层静态预授权种子，免去每次会话的 authorize 往返；非法条目 apply 即抛错。运行期 revoke 对种子同样生效，但重启后随配置重新并入（永久移除须改配置）（D31）。
- `dsh-miopiik-executor`：动态默认模型（D32）——`mop_spawn_executor` 省略 `model`/`provider` 时整对继承调用者当下实际使用的模型（经 `agent/request` waterfall 采样，FIFO 上限 256 会话）；显式传参永远最高优先级（只给其一时另一字段按字段回退 Config 固定值，不与采样混搭）；`Config.followCallerModel: false` 可关闭回到静态默认。

### Changed

- examples/miopiik 规划层 persona：派发执行切片必须显式传 `model: deepseek-v4-flash`，守住「规划强模型 / 执行廉价模型」的层间成本结构（否则 D32 继承会让执行器跑到 pro）。

## [0.1.1] - 2026-08-26

### Fixed

- 套件包 bin 主键改为与包同名（`dsh-miopiik`）：`npx dsh-miopiik` 此前按包名解析会 404；原 `dsh-miopiik-init` 保留为别名。文档统一改用 `npx dsh-miopiik`。

## [0.1.0] - 2026-08-26

首个公开版本（npm 首发 + 市场可发现形态）。

### Added

- 7 个单职责插件包（发行名 `dsh-miopiik-<feature>`）：
  - `dsh-miopiik-tool-recovery`：checkpoint / rewind / prune / 会话级规则注入（D13/D21）。
  - `dsh-miopiik-executor`：受控一次性执行层子代理 `mop_spawn_executor`（persona + 工具白名单 + 硬超时；`Config.strict` 可去 bash/write）（D25）。
  - `dsh-miopiik-magic-keywords`：ultrathink / workflowz 正文检测 → notice 注入（D15）。
  - `dsh-miopiik-model-auth`：模型授权闸，subagent 拉模型必须 ∈ allowlist（D30）。
  - `dsh-miopiik-capabilities`：DSH seam 探测，能力清单含「在场 / 实调」双证据与环境行（D27）。
  - `dsh-miopiik-learn`：`.dsh/skills/` 技能铸造与只读枚举（D12）。
  - `dsh-miopiik-run-stats`：会话累计 token 四桶可编程出口（D18）。
- 套件包 `dsh-miopiik`：一条 `dsh plugin --profile <p> add dsh-miopiik` 插入全部 7 行；附 bin 初始化四层工作流 preset（`npx dsh-miopiik`）。
- `examples/miopiik/`：脱敏 agent preset 模板（三层 + 监督层工作流，planner/supervisor delegation 行 + toolFilter 边界）。

### Security

- planner delegation 行 toolFilter deny 追加 `mop_model_authorize` / `mop_model_revoke`，收口子代理自授权环。

### Changed

- **BREAKING**（相对未发布的旧本地名）：包名由 `@chillizu/mop-*` 全量改为 `dsh-miopiik-*`；工具名 `mop_*` 保持不变。迁移步骤见 README「从旧名迁移」。

[0.1.3]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.3
[0.1.2]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.2
[0.1.1]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.1
[0.1.0]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.0
