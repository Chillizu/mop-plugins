# MiOpIIk 计划树 — OMP 工作流迁移到 DSH

> 本文件是本计划树的**第一层**，也是整个项目的单一事实来源（对应 OMP 的 `local://PLAN.md` 语义：计划即执行规格、零设计决策交接）。
> 任何新会话（含未来执行层 subagent）只需读本文件即可无损理解项目状态。

## 1. 项目定位

把 oh-my-pi（OMP，can1357 的终端编程代理）的工作流思想、loop 逻辑与记忆体系迁移到 DeepSeek Harness（DSH，"一切皆插件"的 Cordis 框架），并融入用户（chillizu）自己的改进：三层 + 监督层工作流、固定通信协议、分级记忆、恢复工具包、魔法关键词。

## 2. 已确认决策（D1–D34）

| # | 决策 | 详情文档 |
|---|---|---|
| D1 | 总体架构 = 三层 + 监督层（审查层 / 规划层 / 执行层 / 监督层） | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D2 | 审查层 = 根会话，用户 preset `miopiik`（从 standard copy，persona 行 = 审查层 prompt 全文），直接对话用户 | 同上 |
| D3 | 规划层 = continuable 后台子代理，由 `subagent_planner` 工具行派发（config.persona = 规划层 prompt 全文 + toolFilter deny 用户直连/ralph/goal/web 工具） | 同上 |
| D4 | 执行层 = one-shot 子代理，`mop_spawn_executor` 自定义工具（内嵌 persona + toolFilter allow 最小集 + 可指定 model，无 subagent/workflow 工具） | 同上 |
| D5 | 监督层 = continuable 子代理，`subagent_supervisor` 工具行（persona + 只读 toolFilter），默认拓扑为**规划层的子**；沉默即通过 | 同上 + [通信协议](docs/design/communication-protocol.md) |
| D6 | 人格映射：全层用 OMP `default.md`（证据优先）；审查层叠加 `pragmatic.md`；弃用 `friendly.md` | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D7 | 通信走 DSH 树形原语：`send_message`（父→子）、`report`（子→父）；无兄弟直连（无 OMP 式 IRC） | [通信协议](docs/design/communication-protocol.md) |
| D8 | 执行层任务模板 = 用户实战的 `# Target / # Change / # Acceptance` 三段式 | [task-template](docs/design/templates/task-template.md) |
| D9 | 监督报告 = `[EXEC]` 五字段（目标/做了什么/进展/交付物/下一步）；监督层默认不回复，仅偏离时 report concern | [report-template](docs/design/templates/report-template.md) |
| D10 | 监督层可知性三通道：定期报告推送 + session_query 读日志 + `.dsh/progress/current.md` 落盘事实 | [通信协议](docs/design/communication-protocol.md) |
| D11 | Subagent 授权闸：派发默认经用户确认，可放行，可场景级禁停（评测场景禁 subagent） | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D12 | 记忆三级：全局记忆（用户偏好/系统信息/系统级改动）、项目记忆（进展/思路/长期需求）、recall（= DSH session_search 家族）；一期零新工具 | [memory-design](docs/design/memory-design.md) |
| D13 | 恢复工具包：`checkpoint` / `rewind`（fork 无损回溯，含冷会话）/ 规则注入；`/retry` **弃用**（请求级自动重试 = provider 原生 `llm/retry`）；run-stats = trajectory 原生 + `mop_run_stats` 可编程 token 出口（见 D18） | [recovery-toolkit](docs/design/recovery-toolkit.md) |
| D14 | 恢复工具与会话管理（fork/rewind）UI 落位：Web GUI「轨迹」页面——**按钮方向已弃**（`sessions.fork`=新会话，做不出就地回退）；checkpoint/rewind 收为 agent 工具 | 同上 |
| D15 | 魔法关键词：hook 检测 **ultrathink / workflowz**（正文散文）注入 notice；**orchestrate** 为规划层 persona 常驻契约段落（非 hook 触发） | [magic-keywords](docs/design/magic-keywords.md) |
| D16 | 验收纪律：预注册 PASS/KILL/NULL 量化门、契约先行（冻结契约 + golden fixtures）、归因分层 + 复算对账、独立验证 subagent | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D17 | 保留"上游模型当最终裁判"的中介报告模式（审查层产出结构化 md 报告供转交） | [report-template](docs/design/templates/report-template.md) |
| D18 | 补可观测性：agent 墙钟 / token / 工具调用统计（session-telemetry seam 上的 run-stats 插件），回应 DSH-test 评测硬缺口；**token 出口已落地** `dsh-miopiik-run-stats`（`mop_run_stats(sessionId)` 读 `sessionProjections` tokenUsage 累计桶，逐 turn/step 折叠、replace 不重复计）；墙钟 / 工具计数仍走原生 trajectory | [recovery-toolkit](docs/design/recovery-toolkit.md) |
| D19 | 模型路由（**已确认判别侧 / 成本待复测**，D29→D29v2）：审查/规划强模型、执行/监督廉价模型——D29 弱版 24 run 全门 PASS（H1 flash rewind 0%、H2 0 漏报、H3 0.60×）但弱判别；**D29v2 强版判别力已确认**：加难任务集 + 参考材料埋陷阱 + golden 收紧后，flash 执行层 20 任务真 rewind 0%（与 pro 持平，H1 PASS，执行层判别力不劣于 pro）；但注入缺陷仍零传播 → 监督侧 H2 判 NULL（契约 §3），H3 墙钟代理失真未证实。结论：**执行/监督用廉价模型（flash）成立（判别力充分）；成本侧已拆 H3-latency（墙钟）/H3-cost（token×价）且 token 出口 `mop_run_stats` 已落地，待 D29v3 用 token 复测**。审查层模型 = 用户 GUI 运行时自选（D19 仅建议强模型，非强制） | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D20 | 后台任务对齐 DSH jobs（job_list/output/kill + run_in_background）；长任务强制详细日志 + 结束 flag + ETA | [architecture-3-layer](docs/design/architecture-3-layer.md) |
| D21 | 计划树工作流：大项目先建树（第一层计划 / 第二层文档参考+对话记录简述 / 第三层设计细则），本树即约定实例 | [plan-tree-workflow](docs/design/plan-tree-workflow.md) |
| D22 | 简洁原则：后期插件实现时，提示词（特别是提示词）与代码必须保持简洁——只给事实与验收，不给方法说教 | 全树适用 + [lsp-extension](docs/design/lsp-extension.md) §6 |
| D23 | 动态 LSP（可选 S9）：在 DSH 既有 lsp seam 上扩展操作（一期 diagnostics+rename），按项目语言动态发现 server | [lsp-extension](docs/design/lsp-extension.md) |
| D24 | 规划层上下文管理：长命会话挂 DSH 自动压缩（阈值触发 + 工具结果剪枝）；规划层可**自主 compact**（状态折叠：写 [EXEC] 汇总 + 项目记忆落盘 → handoff 新会话续跑）；WATCHDOG 式落盘笔记对抗压缩丢失 | [architecture-3-layer](docs/design/architecture-3-layer.md) §7 |
| D25 | 落地形态（DSH 机制约束）：**单 preset `miopiik` + 两 delegation 工具行（planner/supervisor）+ `mop_spawn_executor` 灵活执行层**；子代理加入父级 preset（无 per-child preset 参数），planner/supervisor 用工具行 config 的 persona 覆盖 + toolFilter；executor 用 mop_spawn_executor（内嵌 persona/toolFilter + 可指定 model） | [architecture-3-layer](docs/design/architecture-3-layer.md) §8 |
| D26 | 命名约定（2026-08-26 全量改版）：发行名 = `dsh-miopiik-<feature>`（npm 无 scope，与 DSH 官方 `dsh-*` 对齐；7 包 + meta 包）；**模型工具名保持 `mop_<verb>`（下划线）不变**——persona、golden 装置、实验产物零波及，构成「发行名 / 工具名」两级约定。组合行 id 与插件 name 一致（= 包名）。旧名 `@chillizu/mop-<feature>` → `dsh-miopiik-<feature>` 一一对应（历史评审档案 docs/review/* 保留旧名不改，作时点记录） | 全树适用 |
| D27 | 能力探测（类型：实现；状态：已落地；证据：单测）——`dsh-miopiik-capabilities` 启动/按需探测 DSH seam 可用性（sessions/sessionPersistence/sessionQuery/systemPrompt/sandboxPolicy），写 `.dsh/memory/capabilities.md` 能力清单，防上游漂移（U2 教训） | [capabilities](docs/design/capabilities.md) |
| D28 | 审查层监督模型（类型：监督模型；状态：已落文档；证据：设计推定）——**用户即顶层监督者**（D2 显式化）；审查层里程碑后自 checkpoint（`mop_checkpoint` 默认打调用者）；审查层单点从结构缺陷降为可恢复薄弱环节 | [architecture-3-layer](docs/design/architecture-3-layer.md) §2 |
| D29 | D19 模型路由实验（类型：实验；状态：已跑；证据：D29 弱版本 24 run + D29v2 强版本 40 执行层/20 监督层 run + 双报告）——对比强/弱执行层模型 rewind 率 + 弱监督层漏报率。D29（弱判别）：24 run 全门 PASS 但 0 rewind + 注入缺陷零传播（弱判别，初步确认）。**D29v2（强版本判别力，判别已确认）**：任务集加难 + 陷阱埋进参考材料 + golden 收紧，flash/pro 执行层 20 任务**真 rewind 均 0%**（20/20 规避参考材料语义陷阱，H1 PASS）；但**传播缺陷仍为 0 → H2 判 NULL**（监督判别无从验证，契约 §3 明示 P=0 时 NULL）；H3 墙钟代理失真未证实（已拆 H3-latency/H3-cost + `mop_run_stats` token 出口，待 D29v3 复测）。raw golden 9 个 FAIL 全为 golden 装置缺陷（env 注入/readdir mock/任务依赖/返回消息断言位置），非模型能力。报告见 [d29v2-experiment-report](docs/review/d29v2-experiment-report.md) | [model-routing-experiment](docs/design/model-routing-experiment.md) |
| D30 | 模型授权闸（类型：实现；状态：已落地；证据：28 单测）——subagent 模型必须 ∈ 授权集（全局默认 ∪ allowlist `~/.dsh/memory/global/model-allowlist.md`），闸点在 `agent/request` 全局 waterfall（覆盖原生 subagent/workflow/ralph/mop_spawn_executor/continuable 全部派发路径）；`mop_model_authorize`/`mop_model_list` 管理；鉴权对象=资源(model)非动作 | [model-auth](docs/design/model-auth.md) |
| D31 | 监督层漏报水位（类型：实测发现；状态：已实测；证据：D29 §3.2 + D29v2）——D29 弱版监督层对细微（涌现）缺陷漏报 33%（2/6，flash/pro 持平，> D16 预注册 20% 红线）。决策：**接受为已知限制**（N=6 方向性证据）。**D29v2 复核**：执行层传播缺陷为 0（无坏活可查）→ 监督漏报率无分母，**无法复测/复用该 33% 结论**；「双模型交叉监督」缓解候选在 D29v2 因无传播样本获证，等待含传播缺陷的实验轮验证 | [d29v2-experiment-report](docs/review/d29v2-experiment-report.md) §3 |
| D32 | 轻量模式 = 三档 preset（类型：设计；状态：已定；证据：外部讨论 + 社区查证）——纠正「极简模式最好」（官方极简=基准测试用，非生产推荐）；审查层「只用 bash」**否决**（bash 是无差别管道：藏能力 + 丢 sandboxPolicy 细粒度，且砍掉体系在用的 read/grep/edit/session_search）；工具面已按职责收窄（执行 7/监督 6），真瘦身空间在 prompt+上下文。三档：miopiik-lite（单会话无 subagent 行）/ miopiik（现状）/ miopiik-full（四层+监督+授权闸全开），三档共享 persona + mop 插件；lite 无 subagent 行 = U3 场景级禁停机制化；升档路径写入审查层 persona。红线：不动 compaction（D24）、不动 session_query/记忆（D12/D10） | [lightweight-mode](docs/design/lightweight-mode.md) |
| D33 | 上游裁判输入通道（类型：过程原则；状态：已定；证据：上游模型实战 + D17）——审查层=体系内 CTO（当事人、有执行权、判错担责）；上游模型裁判=外聘审计（局外人、零利益相关、每轮重置、只有说服力）；其「清醒」=结构性清白（无沉没成本）。教训：给上游裁判的永远是一手产物 + 复算路径（仓库/源码/原始报告），不是中间层结论；2.5 汇报模板「证据等级：URL/日志/复算脚本」栏是最不能省的 | [report-template](docs/design/templates/report-template.md) §4 |
| D34 | 监督层红队 benchmark（类型：实验提案；状态：设计已定，待跑，D29v3 fallback 阶梯末级）——对监督层直接喂对抗生成坏活，测能力级判别力，解耦执行层 base rate；与系统级 H2（D29v3）分开，单独预注册 | [d29v3-experiment-design](docs/design/d29v3-experiment-design.md) §2 |
| D35 | 派发分流硬规则（类型：过程原则；状态：已定；证据：A/B 基准 mdtodo 导出复盘）——原「评测/对比等可控场景禁派发」豁免被模型援引跳过整条流水线（miopiik 会话 6e010d8f 全程单机执行，0 次派发/0 次 ask_user_question）。收窄为：禁派发豁免**仅限不产出工件的纯问答/诊断/检索讨论**；实现类任务无论大小一律走规划层→执行层；授权闸与 D33 模型确认合并为同一次 `ask_user_question`；任务书声明全自动时视为预授权 | [agent.cordis.yml](examples/miopiik/agent.cordis.yml) 硬规则1 + 任务分配 |
| D36 | 层级拓扑与深度预算（类型：设计；状态：已定；证据：ench1 复盘——maxDepth 写死 1 使规划层(depth1)派执行器必然 SubagentDepthError，三层退两层）——四层架构树 = 审查(0)→规划(1)→{执行×N，监督}(2)，depth 2 为叶子不再派发；极端第 3 层须用户经授权闸明示同意，默认横向加派不纵向加深。机制面：`mop_spawn_executor` maxDepth 改为调用者深度+1 相对浮动；能力清单头部新增「本会话层级」行供各层自查；审查/规划 persona 固化层级纪律 | [phase1-runbook](docs/design/phase1-runbook.md) §3.1 |
| D37 | 0.2 维护边界与运行时收敛（类型：维护策略；状态：已定）——0.1.x 冻结为 maintenance-only，不新增 feature package、不 unpublish 已发布包；0.2 将长期维护面收敛为 recovery / policy / diagnostics + `dsh-miopiik` 入口。executor / recall / learn 的通用运行时能力优先交还 DSH 原生 subsystem，magic-keywords 转 optional legacy；旧包至少保留一个 0.2 兼容阶段后再考虑 npm deprecation | [0.2-transition](docs/design/0.2-transition.md) |

## 3. 计划树索引

| 层级 | 文件 | 职责 |
|---|---|---|
| 第一层 | [PLAN.md](PLAN.md) | 总计划树根：目标、决策、索引、待确认项 |
| 第二层·文档参考 | docs/research/*（omp-report / dsh-report / omp-vs-dsh） | 本地保留，不入库（OMP/DSH 调研） |
| 第二层·对话记录 | docs/profile/*（conversation-notes / user-preference-profile） | 本地保留，不入库（会话记录 + 用户画像） |
| 第三层·设计 | [docs/design/architecture-3-layer.md](docs/design/architecture-3-layer.md) | 三层+监督层架构细则 |
| 第三层·设计 | [docs/design/communication-protocol.md](docs/design/communication-protocol.md) | 通信拓扑与消息模板 |
| 第三层·设计 | [docs/design/memory-design.md](docs/design/memory-design.md) | 记忆分级 spec |
| 第三层·设计 | [docs/design/recovery-toolkit.md](docs/design/recovery-toolkit.md) | retry/checkpoint/rewind/规则注入 |
| 第三层·设计 | [docs/design/recovery-toolkit-impl.md](docs/design/recovery-toolkit-impl.md) | 恢复工具包实施契约（阶段二：现状核验 + 构建清单 + 验收门） |
| 第三层·设计 | [docs/design/magic-keywords.md](docs/design/magic-keywords.md) | 三魔法关键词映射与 hook 设计 |
| 第三层·预设 | [docs/design/presets/review.md](docs/design/presets/review.md) | 审查层 preset 骨架 |
| 第三层·预设 | [docs/design/presets/planner.md](docs/design/presets/planner.md) | 规划层 preset 骨架 |
| 第三层·预设 | [docs/design/presets/executor.md](docs/design/presets/executor.md) | 执行层 preset 骨架 |
| 第三层·预设 | [docs/design/presets/supervisor.md](docs/design/presets/supervisor.md) | 监督层 preset 骨架 |
| 第三层·模板 | [docs/design/templates/task-template.md](docs/design/templates/task-template.md) | 执行层任务模板（三段式） |
| 第三层·模板 | [docs/design/templates/report-template.md](docs/design/templates/report-template.md) | 工作报告模板（[EXEC]）+ P0–P3 验收格式 |
| 第三层·约定 | [docs/design/plan-tree-workflow.md](docs/design/plan-tree-workflow.md) | 计划树工作流约定（本树自身的元规则） |
| 第三层·设计 | [docs/design/lsp-extension.md](docs/design/lsp-extension.md) | 动态 LSP 扩展设计（可选 S9） |
| 第三层·设计 | [docs/design/offline-degradation.md](docs/design/offline-degradation.md) | 离线降级设计（补哲学审计批评 5；只设计不实现） |
| 第三层·设计 | [docs/design/lightweight-mode.md](docs/design/lightweight-mode.md) | 轻量模式三档 preset 设计（D32：纠正极简神话 + 否决 bash-only + 红线） |
| 第三层·设计 | [docs/design/capabilities.md](docs/design/capabilities.md) | 能力探测设计（D27：seam 可用性清单，防上游漂移） |
| 第三层·设计 | [docs/design/model-routing-experiment.md](docs/design/model-routing-experiment.md) | 模型路由实验骨架（D29：D19 假设的预注册实验，已跑·弱判别） |
| 第三层·设计 | [docs/design/0.2-transition.md](docs/design/0.2-transition.md) | 0.1.x 维护边界、0.2 包生命周期与原生 DSH 收敛计划 |
| 第三层·设计 | [docs/design/model-auth.md](docs/design/model-auth.md) | 模型授权闸设计（D30：资源对象授权 + agent/request 全局闸点） |
| 第三层·规程 | [docs/design/phase1-runbook.md](docs/design/phase1-runbook.md) | 阶段一验收规程：四层跑通 + U2 spike（实施阶段用） |
| 第三层·审查 | [docs/review/completeness-omp-diff.md](docs/review/completeness-omp-diff.md) | 迁移完整性审查 + 相对 OMP 差别（阶段二后） |
| 第三层·审查 | [docs/review/philosophy-audit.md](docs/review/philosophy-audit.md) | 全套设计哲学审计（D1–D31 + 文档一致性）+ 漂移修复 + 缺口清单（learn/model-auth 已落地，离线降级设计已落/机制未实现，监督层 33% 漏报已升 D31） |
| 第三层·审查 | [docs/review/d29-experiment-report.md](docs/review/d29-experiment-report.md) | D29 模型路由实验报告（24 run，弱判别；§3.2 监督层涌现缺陷 33% 漏报） |

## 4. 待确认项（U1–U3）

| # | 待确认 | 默认方案 |
|---|---|---|
| U1 | 监督层拓扑 | 规划层的 continuable 子（send_message/report 原生双向）；备选：审查层的子（需转发，不推荐） |
| U2 | spike：子代理能否用 session_query 读父会话日志（授权规则实测） | 已实测（2026-08-14，见 [runbook §5.1](docs/design/phase1-runbook.md#51-实测记录2026-08-14阶段一验收样例判定--中间档)）：当时 session_search 被部署级禁用 → 两通道兜底；**现已启用全文搜索**（profile patch `openAt: first-search`，实测 20 hits），recall 三通道恢复 |
| U3 | 授权闸实现方式 | 一期 prompt 规则（派发前确认）；二期评估接 DSH 审批 seam |

## 5. 下一步（实施进度）

已完成：
1. **阶段一 preset+协议**：四 prompt 定稿、miopiik 组合、四层端到端跑通（A1–A4/A6 PASS，A5 中间档）✓
2. **阶段二恢复工具包**（D13/D14）：checkpoint / rewind（fork 无损，含冷会话）/ 规则注入 / 自动重试（原生）/ run-stats（原生 trajectory + `mop_run_stats` 可编程 token 出口）——已固化为 `dsh-miopiik-tool-recovery` 入 miopiik ✓
3. **记忆细化**（D12）：全局记忆 `~/.dsh/memory/global/` + persona 注入 + recall 全文搜索启用（profile patch，重启生效）✓
4. **魔法关键词 hook**（D15）：`dsh-miopiik-magic-keywords` 入 miopiik，正文检测 ultrathink/workflowz → notice 注入 ✓
5. **命名约定**（D26）：发行名 `dsh-miopiik-<feature>` / 工具名 `mop_<verb>` 两级 ✓
6. **能力探测**（D27）：`dsh-miopiik-capabilities` 探测 seam 可用性 → `.dsh/memory/capabilities.md` ✓
7. **审查层监督模型**（D28）：用户即顶层监督者 + 审查层自 checkpoint（写入 persona + architecture §2）✓
8. **冷会话 rewind 实测**（D13）：真实冷会话 readFrom + create(seed) 跑通（775 事件 → 边界 774 → seed 775 → 子会话）✓
9. **checkpoint 并发写锁**：CAS（replaceIfVersion）+ 冲突重试，杜绝并发写覆盖 ✓
10. **recall 全文搜索验证**（D12）：重启 dsh web 后 session_search 实测 2 hits ✓
11. **模型授权闸**（D30）：subagent 模型 ∈ 授权集（默认 ∪ allowlist），闸在 agent/request 全局 waterfall，28 单测过 ✓
12. **learn 机制**（D12 落地）：mop_learn 铸 skill 到 .dsh/skills/<name>/SKILL.md，19 单测过 ✓
13. **D29 模型路由实验**：24 run 完成，H1/H2/H3 门 PASS（弱判别），D19 回写「初步确认」，报告见 [d29-experiment-report](docs/review/d29-experiment-report.md)；顺带修复 dsh-miopiik-executor 两处上游契约漂移（signal/maxDepth——插件首次真实使用暴露，D27 教训升级：seam 探测 ≠ 工具冒烟）✓
14. **生产清洁度修复**（独立评审 93/78/82）：P0 同步 dsh-miopiik-executor signal/maxDepth 回仓库 + rewind 加 session 归属校验 + 输出截断 4000；P1 提示词层——7 工具 description 按「帮模型做选择」重写 + EXECUTOR_PERSONA 删悬空引用「2.2」+ 消除双真相（description 不写死默认模型）；P2 workflowz notice 文案兜底 + allowlist 缓存提示。30 单测过 ✓
15. **外部评审反馈收口**（DSH 生态契合 60% → 待机械补）：修 architecture §8 yaml 漂移（三 delegation 行 → 两行 + mop_spawn_executor）+ philosophy-audit §1/§3/§5 滞后（D19/D29 状态、离线降级设计已落）+ 双树（workspace/repo）对齐 + D29 产物 5 文档入库 + 升 D31（33% 漏报水位）；Config schema 已落地（dsh-miopiik-executor/magic-keywords/model-auth 三包）；bundle + 真实组合测试已落地 ✓
16. **生态形态层补全**（DSH 生态契合 60% → 形态层收口）：6 包声明 dsh.bundle patch + cordis.patch.yml（47bc72a）；README 改 bundle 安装方式 + 补 model-auth/learn 两包（8bb1cba）；另 3 包路径提命名常量（6cd20f1）；三档 preset 落地 miopiik-lite（d2c24c2）；**真实组合测试**（56265e8）落地并抓出真 bug——dsh-miopiik-executor `z.number().int()` 真实 schemastery 不存在（mock stub no-op 掩盖），改 `z.natural()`；3 真实组合 + 30 mock 全绿 ✓
17. **D18 token 出口 + H3 门重冻结**（外部评审 P1-4）：新包 `dsh-miopiik-run-stats`（`mop_run_stats(sessionId)` 读 `sessionProjections` tokenUsage 累计桶，live-first + coldSnapshot 兜底，not-found/投影不可用/全零桶三态）；H3 拆 H3-latency/H3-cost + DeepSeek V4 峰谷定价表 + 灰区/INCONCLUSIVE 口径写入 [model-routing-experiment](docs/design/model-routing-experiment.md) §3–§4；真实组合测试锚「tokenUsage 投影零桶」；44 mock + 4 组合全绿 ✓

待办（用户门控，需重启/实测）：
- **D29v2 强版本实验续跑**（类型：已跑；结论：H1 判别力确认 PASS / H2 NULL（传播=0）/ H3 墙钟代理失真未证实；raw golden 9 FAIL 全为 golden 装置缺陷待修）：执行层 40 run（flash+pro 真 rewind 均 0、20/20 规避参考材料陷阱）+ flash 监督层 20 run 完成（全部 PASS）。**遗留**：① 传播缺陷仍 0 → H2 无从判别，需重设缺陷注入口径（已定 D29v3 设计，见下）；② golden 装置需修（env 注入 MOP_MODEL_ALLOWLIST、readdir/listDir mock、任务依赖 t11↔t09、返回消息断言位置，D29v3 阻塞前置）；③ H3 需逐 run 精确墙钟（现已拆 H3-latency/H3-cost，token 走 `mop_run_stats`，见 D18/模型路由实验 §4）。报告见 [d29v2-experiment-report](docs/review/d29v2-experiment-report.md)
- **D29v3 监督层漏报率实验**（类型：Step 1 试跑完成，待 Step 2 跑批 50；P1-5）：根因 = 通道权威性（陷阱必须埋规范性通道 Change/规格正文，非咨询性参考材料）。四口径（A 规格内潜伏陷阱+双层契约 / A2 baseline-planted / B 涌现缺陷 / C 交叉监督）+ D34 红队 benchmark 独立实验；预注册门含 H0 前置（传播 P≥8 可行性 + P_target=20）+ 对照式 KILL（flash>20% 且 pro≤20% 才 KILL）+ H3-latency/cost；fallback 阶梯 A→B→A2→D34 写进契约。**Step 1 试跑（t01/t16 × 2 exec 模型，4 run）装置验证通过**：golden 全 PASS 无 rewind / 谓词 4/4 命中 / 监督 4/4 报出 / 无 divergence。**Step 1 发现 confound → H2 分母口径修正（design §8.5）**：flag-vs-silent 与执行模型强相关（flash 静默采纳 / pro 显式 flag 后采纳），主口径由「静默传播」改「全部传播」（P=命中谓词全部），flag-vs-silent 降为独立报表维度不进分母。**Step 2 前阻塞**：dsh-miopiik-executor 需返回 session id（token 四桶采集，H3-cost；用户已拍板改基建，不动 007a029）。设计见 [d29v3-experiment-design](docs/design/d29v3-experiment-design.md)；试跑记录 `.dsh/d29v3/results/runs.md`（本地 workspace）
- **工具面瘦身实验**（D32）：D29 方法跑 {执行 7 工具} vs {收窄}，门 = 首轮通过率 + token。**需 miopiik 会话 + 先冻结任务集/golden**；且 D32 已实测「隐藏 schema 不计入」削弱其省 token 动机，是否值得跑留待你定

## 6. 维护规则

- 本文件是单源事实；任何设计变更先改本文件对应决策行，再改详情文档；
- 双树方向：git-tracked 文档（PLAN.md、docs/design、docs/review）以 **repo 为权威**（git 有历史、push 落点），workspace 为镜像 + 本地独有文件（docs/research、docs/profile、.dsh）；改 repo 后立即 cp→workspace，改 packages 后立即 cp→live profiles（`~/.dsh/profiles/dsh-miopiik-*`；旧 `mop-*` 目录用 README「从旧名迁移」步骤清理）；
- 改决策行时，必须同步该决策承载文档的代码块（如 D25 改动需同步 architecture-3-layer §8 yaml），并在 philosophy-audit §2 登记漂移修复；**机制化**：executor persona 的「定稿源 ↔ 运行时副本」逐字同步由 `test/persona-sync.test.js` 钉死，改一处另一处不同步则测试失败；
- 会话发现的新偏好/教训 → 更新 [user-preference-profile](docs/profile/user-preference-profile.md)，重要结论升级为 PLAN.md 决策；
- 所有文档遵循用户风格：直接、简洁、无 Emoji、证据优先。
