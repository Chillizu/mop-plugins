# Changelog

所有对外可见的变更记录在本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 SemVer；同一 release train 中实际发布的包采用 **lockstep 版本**（同号同发）。

## [Unreleased]

## [0.5.2] - 2026-10-21 (DSH 0.2.1 compatibility and maintenance-mode cleanup)

- `dsh-agent-rewind` and `dsh-session-policy`: align runtime peer dependencies and real composition tests with DSH `0.2.1-rc.2`. Keep named rewind, session-scoped rules, and diagnostic tools unchanged.
- `mop-probe` separately advances to `0.1.1` with the matching DSH peer contract; the read-only schema auditing tool is unchanged.
- Remove historical design/experiment documents from the **current tree** (retained in Git history), superseded CLI lab and DSH 0.2.0 spawn-fixture tests. Real Loader coverage now tests only maintained functionality.
- Simplify the three Cordis bundle patches, READMEs and CI; no legacy compatibility aliases or obsolete orchestration framework.
- The live profile's existing state, sessions, and local untracked archive are out of scope for this repository cleanup.

## [0.1.0] - 2026-10-13

**本仓库第一个独立发布的包**：`mop-probe` 走自己的版本线（`0.1.x`），不随
`dsh-session-policy` / `dsh-agent-rewind` 的 0.5.x lockstep 列车；后两者本次**无代码
变更**，故不发版。

### Added

- **`mop-probe@0.1.0`：部署探针。** 一个模型可见工具 `mop_probe_env`：
  `mode="env"` 报运行时/部署/会话/模型事实，`mode="tools"` 审计每个可见工具的
  JSON Schema 是否满足上游函数调用契约。

  起因是一次真实事故：某个挂在 agent preset 里的第三方探针以 `mop_probe_env` 注册了
  **空 schema**，deepseek API 直接拒收整个请求 ——
  `Invalid schema for function 'mop_probe_env': schema must be a JSON Schema of
'type: "object"', got 'type: null'` —— 该会话此后**每一轮都失败**，与轮次内容无关。
  DSH 的 `tools.register()` 原样路径不做 object-root 校验，所以这道判据只能由插件侧守。

  本包给出三层防线：注册形态唯一（一律 `defineTool()`，`test/mop-probe.test.js` 扫源码
  禁止绕过）、判据双向可用（扁平参数图与投影 schema 同判，CI 与运行时共用一份）、
  只读自检（读 `tools.schemas()`，发现违规**如实报告而不抛错**）。`test/composition/`
  新增真实 Loader 挂载 + 真实投影面实跑审计的验证。

  发布状态：**已公开发布**。`registry.npmjs.org` 上 `dist-tags.latest = 0.1.0`，
  全新目录 `npm install mop-probe@0.1.0` 实装成功（5 个文件、MIT、`dsh.bundle.patch` 在包内）。
  注意本包只声明 `@deepseek-ai/dsh-tools` 为 optional peer——它是 DSH 发行版自带的包、不在 npm，
  所以独立目录里直接 `import 'mop-probe'` 会报该 peer 缺失，这是预期形态，不是包缺陷。

  发布中的一次误判记在 `CONTRIBUTING.md`「npm 陷阱」第 3 条：发布后两三分钟内 registry 只显示
  `0.0.0-stage` 占位且公开安装 404，那是**传播延迟**，不是 2FA 卡住。

  发布前实测：web profile 真实工具面 **42 个工具全部通过契约校验**（object-root、
  无 null 类型、`required ⊆ properties`）。

  > 与已删除的第三方 `mop-probe` **不是同一份实现**：那是 `/tmp/mop-probe` 软链进 web
  > profile 的临时包；本包在工作区内重建并带契约门禁。

### Packaging

- `test/mop-probe.test.js` 的 schema 契约门禁并入 `npm test`：反例锚定线上那条
  `type: null`，正向覆盖全部 workspace 包的实际注册结果。
- `test/composition/cordis.with-mop-probe.yml`：探针的真实装载夹具（`tools` 行经
  `systemPrompt` 传递依赖才会 activate —— 少一行探针会一直 pending）。
- `README.md` / `packages/mop-probe/README.md`：套件从「两个包」更新为「三个包」，
  并写明 `mop_*` 前缀自 0.5.0 起**只**用于诊断探针这一个工具。
- `npm run check` 覆盖 `packages/mop-probe/` 的两个入口。

## [0.5.1] - 2026-10-13

### Fixed

- **`agent_checkpoint` 在真实部署里 100% 失败。** DSH 的 `Session` **没有** 公开的 `.events`
  属性——事件只能经 `snapshotEvents()` 取得。旧实现读 `agent.session.events`，于是拿到
  `undefined`，被自身校验误判成「会话不可用」并报
  `agent_checkpoint: event stream of session <id> unavailable`，检查点永远写不下去。
  现经 `liveSessionEvents()` 统一取内存快照，并保留对更早 `Session` 形态 `.events`
  的兼容回落。

  为什么选已弃用的同步 `snapshotEvents()` 而不是 async 的 `sessionQuery.readSession`：
  持久化后端是**异步缓冲**的，durable log 可能落后于内存；而检查点要的是「**此刻**
  最后一个 `turn/end`」，慢一拍就会把边界记小、回溯到错的位置。live 会话优先取内存
  快照，durable 读只作为会话不再 live 时的回落。

- **测试替身比现实更宽松，掩盖了上面这个缺陷。** `test/harness-mocks.mjs` 的 `rootAgent()`
  曾返回 `{ id, header, events }`，凭空造出一个真实 `Session` 没有的 `.events`，
  让「读 live 会话事件流」的代码路径一路绿灯。现替身只提供真实 API
  （`snapshotEvents()` 有、`.events` 没有），并新增 `test/session-contract.mjs`：
  在**无 stub 的独立进程**里对真实 `Session` 类实测断言该契约（快照存在、`.events` 缺位、
  插件能从替身读出事件并定位边界），以 `npm run test:contract` 纳入门禁。

- 新增回归锚 `agent_checkpoint reads a live session only through snapshotEvents()`：
  先断言替身不得暴露 `.events`，再验证边界确实来自 `snapshotEvents()` 读到的事件流。

### Removed

- 清掉两个中途引入、实际无人使用的 devDependency（`@deepseek-ai/dsh-llm`、`zod`）。

## [0.5.0] - 2026-10-13

**破坏性重定位：原生优先（native-first）。** 本版删除绝大多数功能并重新切分包边界，理由是 DSH `0.2.0-rc.2` 已经原生提供它们。判据与取证见 [docs/design/0.5-repositioning.md](docs/design/0.5-repositioning.md)。

### 判定依据（逐条取证，非印象）

对已安装 DSH `0.2.0-rc.2` 的 `README.md` / `lib/types/*.d.ts` / 源码逐项核对，并用活运行时 `cordis_inspect_query(host, Tool, listTools)` 取「模型可见工具全集」作第一手判据：

- 原生模型可见工具里**没有**任何 fork / checkpoint / rewind / rule / token / probe 类工具 → 这几类是真实空档。
- `ctx.sessions.fork` 与宿主 Remote `session.fork({sessionId, atSeq?})` 都存在，但三层（Service → Remote → Web GUI 按钮）**都对模型关闭** → 恢复账本不可替代。
- `dsh-experimental-agent-team-profile`（用户 profile 已启用）提供命名成员、durable 消息、共享任务板，并显式 `disabled: true` 掉 `tool-subagent` / `tool-subagent-fork` → MiOpIIk 的「三层 + 监督层协作协议」整块定位已被取代。
- `dsh-session-checkpoint-policy` 是**崩溃前落盘**语义，与命名检查点不是一回事（勿混同）。
- `dsh-token-meter` 的 `tokenUsage` / `dsh-session-stats` 的 `sessionStats` 上游 README 明写 "registers nothing model-facing" / "None" → `session_doctor(stats)` 是唯一模型可见路径。
- `dsh-system-prompt` README 明写 "there is no end-user prompt-editing API" → 会话级规则注入是**刻意关闭**的门。

### Changed — 包边界重切（9 包 → 2 包）

| 包                                            | 职责                                                  | 模型可见工具                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `dsh-agent-rewind`（新，无 scope）            | 会话的命名恢复账本：共享 `.dsh/memory/checkpoints.md` | `agent_checkpoint` / `agent_rewind` / `agent_checkpoint_list` |
| `dsh-session-policy`（由 `dsh-miopiik` 改名） | 会话级硬规则 + 诊断                                   | `session_rule` / `session_doctor`                             |

- `dsh-session-policy` 声明 `dependencies: { "dsh-agent-rewind": "^0.5.0" }`，一条 `add dsh-session-policy` 两包一起装。
- 两个包均 `version 0.5.0`，lockstep。

### Changed — 命名统一（消灭 `mop_` 前缀）

历史上包名用 `miopiik`、工具名用 `mop_` 前缀——**同一个词的两个缩写并存**，纯冗余。现统一：工具名前缀 = 所属包职责，与 DSH 官方先例同形（包 `dsh-tool-session-query` → 工具 `session_*`）。

| 0.4.x                                                  | 0.5.0                                                   |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `mop_checkpoint`                                       | `agent_checkpoint`                                      |
| `mop_rewind`                                           | `agent_rewind`                                          |
| `mop_checkpoint_list`                                  | `agent_checkpoint_list`                                 |
| `mop_rule_inject` / `mop_rule_show` / `mop_rule_clear` | `session_rule(action:"inject"\|"show"\|"clear", text?)` |
| `mop_probe_capabilities`                               | `session_doctor(mode:"seams")`                          |
| `mop_run_stats(sessionId)`                             | `session_doctor(mode:"stats", sessionId)`               |

包名**不用**无前缀的 `agent-rewind` / `agent-checkpoint`：npm 上均已被同类项目占用（`agent-rewind` 的描述即 "Flight recorder + undo button for AI agents"），按「不代替已存在的」原则避开。

### Removed（8 个包，不做兼容 shim）

- 删除 `dsh-miopiik-tool-recovery`、`dsh-miopiik-diagnostics`、`dsh-miopiik-learn`、`dsh-miopiik-magic-keywords`、`dsh-miopiik-capabilities`、`dsh-miopiik-checkpoint`、`dsh-miopiik-run-stats`、`dsh-miopiik-policy`。已发布版本保留在 npm，但不提供转发包；升级须先清理 profile 旧行。
- 模型可见工具 11 → 5：删除 `mop_learn`（原生 `write` + `dsh-skill-filesystem` 已覆盖，写后下一模型步骤即入目录）、`mop_checkpoint_prune`（并入 `agent_checkpoint` 自动裁剪）、`mop_probe_capabilities` / `mop_run_stats`（并入 `session_doctor` 两个 mode）、`mop_rule_*` 三个（并入 `session_rule`）。
- **`dsh-miopiik-policy` 整体删除**：它守的 `subagent_execute` 是 **preset 里的行**，不是插件能力。preset 配置归用户、本套件不再代管 → 守卫默认空转。按原生优先原则，「为不存在的行准备的守卫」就是重叠面。需要强制显式路由时用 DSH 原生 `modelSelectionSettings` + `allowedModels` 白名单。
- **不再挂载 `@deepseek-ai/dsh-tool-session-query`**：DSH Agent Teams profile 已自带协作面。该包也不再列为 optional 依赖（声明却不挂载会产生幽灵依赖），需要时一行 `add` 自行加回。
- **不再代管 agent preset**：DSH 0.2 起 preset 是 `@deepseek-ai/dsh-agent-preset` 的声明行，旧的 `$DSH_HOME/.agent-presets/<id>/` 目录已无人读取。删除 `preset/`、`examples/miopiik/` 与 `bin/dsh-miopiik-init.mjs`。

### Fixed

- **冷路径回溯产生未闭合子会话**：`agent_rewind` 的冷会话分支原来直接把 `events.slice(0, seq+1)` 当 seed 交给 `sessions.create`，而**热路径**走 `sessions.fork` → 内部用 `buildForkSeed` 补合成闭合事件。当边界落在 turn/step 中间时，冷路径 fork 出的子会话结构未闭合（缺 `session/end-seed` / `step/end` / `turn/end`，未匹配的 tool call 也没有结果）。现改用 DSH 公开的 `@deepseek-ai/dsh-session/fork` 的 `buildForkSeed`（与第一方 `dsh-api-session-controller` 同一导入路径），`inheritedEventCount` 只计继承前缀。两条成对回归锚：边界未闭合（补 3 条）与边界恰好闭合（只补 fork 切割标记）。
- **检查点静默丢失**：旧 `appendCheckpoint` 在 `checkpoints.md` 不以换行结尾时会把新行粘在末行尾部，该行无法被解析、检查点静默失效。现补分隔换行。
- **能力清单谎报在场**：`probe` 的 `presenceOnly` 以 `typeof fn === 'function'` 判定，而「成对原语」判据传的是预算好的布尔 → 被一律判成 false；且 `sessionQuery.filterSessions/filterEvents` 只检查前者。现改为接收**谓词**并要求两者都在。
- `agent_checkpoint` 显式传空 `sessionId` 不再静默打到自己会话，改为报错；事件流不可读时报错而非当作 seq 0。
- `agent_rewind` 归属校验改为前缀不敏感（冷会话也生效）；fork 目标取检查点记录的真实 session id。
- `session_rule` 的 `show` / `clear` 也要求存在调用会话；`inject` 先 dispose 旧 section 再注册，注册失败时状态清干净。
- `session_doctor(stats)` 全零桶时输出 `allZero: true` + `note`（提示应判 INCONCLUSIVE 而非 PASS）；`sessionProjections` 在场但缺 `snapshot()` 时给出可诊断错误而非原始 `TypeError`。
- 测试基建三处真空通过：`import only declared modules` 未归一化子路径导入；`release-version` 的 `publicWorkspaceManifests()` 按 `^dsh-` 过滤会漏掉 scoped 包；两个既有测试均缺反向自检。

### Kept（未变契约）

- `checkpoints.md` 行格式 `- [ISO] label | session=<sid> | seq=<n> [| note]` 未变；历史检查点继续可读、可回溯。
- `seq` 仍是 **inclusive** 边界；`inheritedEventCount` 只计继承前缀，`buildForkSeed` 的合成闭合事件在它之外。
- 自动检查点阈值默认 200，只裁可被现行正则解析的行；注释/空行/旧格式/散文永不删除。

### Validation

- `npm run check`、`npx eslint packages test tools`、`npx prettier --check .`、`tools/verify-crossrefs.sh` 全绿。
- `npm test` 覆盖两个包的 5 个工具、事件面、纯 helper 与真实 Loader 挂载。
- `npm run test:composition` 经真实 DSH Cordis Loader 挂载两包并断言 5 个工具在场。

## [0.4.1] - 2026-10-13

### Fixed

- 修复套件 patch 挂载 `@deepseek-ai/dsh-tool-session-query` 行、却没有依赖支撑导致的启动降级：`0.4.0` 假定该能力由 DSH 0.2 宿主内置，但 `0.2.0-rc.2` 只把该包发布在 npm、不随 harness 安装，于是 profile 启动报 `dsh: warning: 1 entry did not activate` / `dsh-tool-session-query (@deepseek-ai/dsh-tool-session-query): failed to import`，会话查询工具始终不装载。现恢复为套件依赖并锁定 `^0.2.0-rc.2`（与宿主同版本，不嵌套旧 `0.1.7` runtime）。
- preset 的 workflow 引擎行从已停止发布的 `@deepseek-ai/dsh-workflow-worker-thread` 改为 DSH 0.2 官方使用的 `@deepseek-ai/dsh-workflow-ptc`。前者在 npm 上最高只有 `0.1.5-rc.3`、没有 0.2.x，也不存在于 `0.2.0-rc.2` 安装中，该 row 无法导入。
- 新增回归测试：patch 与 preset 引用的官方模块必须来自 DSH 宿主内置清单，或声明为套件依赖。

### Validation

- 单元测试全绿；并在隔离 `DSH_HOME` 下用 DSH `0.2.0-rc.2` 实际启动 profile，确认 `0.4.0` 的 `failed to import` 告警消失。

## [0.4.0] - 2026-10-04

### Changed

- 对齐 DSH `0.2.0-rc.2` 的真实 Loader 服务图，Composition fixture 补齐 `session-projection` 与新版 sandbox provider。
- `dsh-miopiik` 不再直接依赖原生 `dsh-tool-subagent` / `dsh-tool-session-query`，避免在 DSH 0.2 宿主中嵌套安装旧 0.1.7 runtime。
- MiOpIIk 的 DSH peer contract 更新为 `^0.2.0-rc.2`；内部 MiOpIIk 包统一升至 `0.4.0`。
- Composition 的 pinned DSH snapshot 更新到官方 `dsh-v0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`)。
- Loader smoke 不再在无 scoped preset Context 的 leaf fixture 中开启 `modelSelectionSettings`；正式 preset 继续通过 Host scope 提供该能力。

### Validation

- 单元测试、语法检查、ESLint、Prettier 与 DSH `0.2.0-rc.2` 真实 Loader Composition 全绿。

## [0.3.1] - 2026-09-28

### Fixed

- 修正 `0.3.0` 删除策略适配器后 `subagent_execute` 可静默继承父路由的问题。新增极薄 `dsh-miopiik-policy`，通过 DSH 官方 `tools.guard()` 要求显式、非空的 `provider` 与 `model`；会话授权、路由校验与子代理运行仍全部由 DSH 原生工具负责。
- 套件及所有保留包统一升至 `0.3.1`。npm 不允许覆盖已发布的 `0.3.0`，该版本保留为历史版本并由 `0.3.1` 修正。

## [0.3.0] - 2026-09-28

### Changed

- 对齐 DSH `0.1.7-rc.2` 当前 API，并锁定配套官方 `dsh-tool-subagent` 与 `dsh-tool-session-query` 插件版本。
- 移除重复实现的 MiOpIIk executor、模型授权闸和 recall 插件；改用 DSH 原生子代理、模型设置与会话查询。
- 移除 `mop_learn_list`，技能目录和加载由 DSH 原生 skill catalog / `skill` 工具提供；保留 `mop_learn` 作为项目技能创作入口。
- preset 改用 `subagent_plan`、`subagent_supervise`、`subagent_execute`，不固定 provider/model；`0.3.1` 加回仅要求执行层显式填写路由的策略守卫。
- 保留 MiOpIIk 的恢复、规则注入、诊断、token 投影、关键词插件及旧包兼容入口。
- 本次发布包含破坏性迁移；旧 npm 版本保留并弃用，需从现有 profile 清除旧 executor/model-auth/recall 行.

## [0.2.0] - 2026-09-19

### Changed

- 0.1.x enters maintenance mode: security, upstream compatibility, correctness and documentation only; no new feature package is planned for this line.
- Added the 0.2 transition contract: retain the published packages for compatibility while converging long-term ownership on recovery, policy and diagnostics; executor/recall/learn move toward native DSH capabilities and magic-keywords becomes optional legacy functionality.
- No runtime bundle membership changes are made by this maintenance step.
- **0.2 recovery migration (implementation branch):** `dsh-miopiik-tool-recovery` now owns event-driven `auto-turn` / `auto-error` persistence in addition to manual checkpoint/rewind/prune. The default preset stops mounting `dsh-miopiik-checkpoint`; the old package remains published/installable as a compatibility surface and stays a meta-package dependency for one migration window.
- **0.2 diagnostics migration (stacked implementation):** added `dsh-miopiik-diagnostics` as the single owner of capability probing and token run-stat logic. `dsh-miopiik-capabilities` / `dsh-miopiik-run-stats` become thin compatibility wrappers; default meta/preset mount only diagnostics while retaining the old packages as migration dependencies.
- **0.2 optional-surface reduction (stacked implementation):** `dsh-miopiik-magic-keywords` and `dsh-miopiik-learn` leave the default meta/preset runtime. Both remain installable, tested packages and stay as migration dependencies; users opt in explicitly when they want hidden keyword notices or the legacy learn workflow.
- **0.2 recall migration:** `mop_recall` is now native-first over DSH `sessionQuery.filterSessions/filterEvents` for the normal case-insensitive path, eliminating dependence on the private `~/.dsh/sessions` layout during ordinary use. `caseSensitive=true`, a missing native seam, or a non-cancellation native failure retains the streaming zstd scanner as a compatibility fallback.
- **0.2 executor policy hardening:** `mop_spawn_executor` is formally treated as a policy adapter over DSH native `ctx.subagents.start`, not a parallel runtime. Public routing/timeout/output contracts stay stable; every published `SubagentRun` is now disposed after success, child failure, cancellation or timeout, and cleanup failures are surfaced instead of silently leaking resources.

### Compatibility

- The default meta/preset runtime shrinks from the historical nine mounted plugin rows to five: `dsh-miopiik-tool-recovery`, `dsh-miopiik-executor`, `dsh-miopiik-model-auth`, `dsh-miopiik-diagnostics`, and `dsh-miopiik-recall`.
- `dsh-miopiik-checkpoint`, `dsh-miopiik-capabilities`, and `dsh-miopiik-run-stats` remain published compatibility packages; `dsh-miopiik-magic-keywords` and `dsh-miopiik-learn` remain explicit opt-ins. No 0.1.x npm package is unpublished or registry-deprecated by 0.2.0.
- All 10 plugin/compatibility workspaces plus the `dsh-miopiik` suite ship lockstep at `0.2.0`; internal MiOpIIk dependency ranges move to `^0.2.0`.

### Validation

- Ordinary CI passes syntax checking, ESLint, Prettier, documentation cross-reference checks, and the complete unit test suite for the converged stack.
- Real DSH Composition passed against both the pinned compatibility commit `47f943859bef60e4160492346772ded9b24f765a` and upstream `master` after the recovery, diagnostics, optional-surface, native-first recall, and executor-policy migrations.

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

[0.2.0]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.2.0
[0.1.3]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.3
[0.1.2]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.2
[0.1.1]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.1
[0.1.0]: https://github.com/Chillizu/mop-plugins/releases/tag/v0.1.0
