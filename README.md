# mop-plugins

[![CI](https://github.com/Chillizu/mop-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Chillizu/mop-plugins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-miopiik)](https://www.npmjs.com/package/dsh-miopiik)

MiOpIIk 的 DeepSeek Harness（DSH）插件集。

> **Maintenance direction (0.1.x → 0.2):** 0.1.x is now a maintenance line. No published package is being removed or unpublished. The 0.2 plan reduces long-term ownership to recovery, policy and diagnostics, while delegating generic executor/session-search/skill runtime mechanics to native DSH. See [MiOpIIk 0.2 transition plan](docs/design/0.2-transition.md).

**English**: MiOpIIk is a single-responsibility plugin suite for the DeepSeek Harness — checkpoint/rewind recovery, **event-driven auto checkpoints** (every root-session turn lands a recovery line), historical-session recall, controlled executor subagents with a **zero-default model contract**, a **workspace-scoped model authorization gate**, seam-capability probing, token telemetry, and a four-layer (reviewer/planner/supervisor/executor) agent workflow preset. Install all of it with one command: `dsh plugin --profile web add dsh-miopiik`.

## 架构总览

```mermaid
graph TD
    U[用户] -->|任务 / 独立验收| R[审查层 Reviewer<br/>主会话 · miopiik preset]
    R -->|2.1 任务下达| P[规划层 Planner<br/>continuable 子代理 · 强模型]
    R -.->|接收 [EXEC] 报告| S[监督层 Supervisor<br/>沉默即通过 · 弱模型]
    P -->|契约文件 + 并行派发| E1[执行层 Executor ×N<br/>one-shot · mop_spawn_executor]
    E1 -->|交付 + 验收对照| P
    P -->|[EXEC] 周期汇报| R
    S -.->|[CONCERN] 仅路径偏离时| R
```

四角色职责、通信协议与设计决策见 [`docs/PLAN.md`](docs/PLAN.md)。

## 快速安装：给 Agent 的一键提示词

把下面这段原样复制给另一个 Agent（或你自己的新会话），它会按本 README 的「安装」章节执行。提示词要求它先逐项取得你的确认再动手、装完做只读验证、失败原样上报，不含自创命令。手动安装见[安装](#安装)。

```text
你是安装助手。目标：把公开仓库 Chillizu/mop-plugins（DeepSeek Harness 插件集）
安装到用户的 DeepSeek Harness。

0. 事实源：先读
   https://raw.githubusercontent.com/Chillizu/mop-plugins/main/README.md ，
   以其「安装」章节为准。不要自创命令、不要臆造路径；README 没写的操作不要做。

1. 动手前逐项询问并取得用户明确确认；未获确认前不安装、不写文件、不改 profile、
   不重启服务：
   - 是否授权安装本插件集（是/否）？
   - 目标 Harness 是哪个（web / headless / 其它）？对应 profile 名是什么？
   - 安装来源：npm 套件包（推荐，无需 clone）还是源码？源码安装时 clone/checkout
     到哪个目录？该目录是否已存在？
   - 是否允许修改 profile 配置（`dsh plugin add` 会写 profile）？
   - 是否同时安装 miopiik preset（复制 examples/miopiik 为
     ${DSH_HOME}/.agent-presets/miopiik）？完整四层工作流需要它；只装插件层可跳过。
   - 是否允许重启 Harness 服务以加载插件与 preset？

2. 确认完成后，按 README「安装」章节执行，优先方式一（套件包）：
   `dsh plugin --profile <profile> add dsh-miopiik` 装插件层 +
   `npx dsh-miopiik` 装 preset（用户未同意 preset 则跳过此步）。
   仅当用户明确选择源码安装时，才 clone 仓库并改用
   `dsh plugin --profile <profile> add link:./packages/...` 按本文当前逐包清单安装默认运行时包、
   再 `cp -r examples/miopiik "${DSH_HOME}/.agent-presets/miopiik"`。
   不跳过、不自造参数、不改动包内文件。

3. 安装后验证（只读，不额外改动）：
   - 核对默认运行时行已进入 profile（`dsh plugin list` 或 `dsh.profile.bundles`）；0.2 recovery 合并后独立 `dsh-miopiik-checkpoint` 不再是默认挂载行；
   - 重启后确认实际加载：Web UI 设置→插件清单出现 `dsh-miopiik-*`；装了 preset 则用
     `standingKeyFor('miopiik')` 验证挂载；
   - 可选 smoke：按 examples/miopiik/README.md 的「最小 smoke task」跑一遍
     （probe capabilities → checkpoint → list）；
   - 可选：在仓库根跑 `npm test` 验证本仓库测试；若缺 Node 依赖，先说明，
     不要擅自 `npm install`；
   - 任一环节失败：原样报告错误与已执行步骤，不要擅自多方案重试或改动其它插件。

4. 全程不修改模型选择/路由，不碰 preset 之外的配置、设计文档、契约、实验产物；
   不 commit、不 push。
```

## English Quickstart

MiOpIIk is a single-responsibility plugin suite for the DeepSeek Harness: checkpoint/rewind recovery + event-driven auto checkpoints (`dsh-miopiik-tool-recovery`; the old `dsh-miopiik-checkpoint` package is a 0.2 compatibility surface), historical-session recall (`dsh-miopiik-recall`), controlled one-shot executor subagents with a zero-default model contract (`mop_spawn_executor`), a workspace-scoped model authorization gate, two-evidence-level seam probing, token telemetry, magic keywords, and a four-layer reviewer/planner/supervisor/executor workflow preset.

```bash
# 1) plugins — default runtime suite with one command
dsh plugin --profile web add dsh-miopiik

# 2) preset — the four-layer workflow (copies to ${DSH_HOME}/.agent-presets/miopiik)
npx dsh-miopiik

# 3) restart DSH, then validate the mount
#    standingKeyFor('miopiik')
```

Smoke task (no credentials needed): start a session on the `miopiik` preset and ask for
`mop_probe_capabilities` → read `.dsh/memory/capabilities.md`, then `mop_checkpoint`
with a label, then `mop_checkpoint_list`.

## 范围

本仓库包含重建 MiOpIIk 插件层与 preset 的全部材料：

- **插件层**：9 个 0.1.x 已发布兼容包 + 0.2 新增 `dsh-miopiik-diagnostics` 收敛域（`packages/`）+ 测试 + 设计文档。
- **MiOpIIk agent preset**：persona 与 Cordis 组合行（planner / executor / supervisor 工具编排）。脱敏可重建模板在 [`examples/miopiik/`](examples/miopiik/)（复制为 `${DSH_HOME}/.agent-presets/miopiik/` 即可）；定稿 persona 的 draft 源在 [`docs/design/presets/drafts/`](docs/design/presets/drafts/)（`executor.prompt.md` 逐字同步进 `dsh-miopiik-executor` 的 `EXECUTOR_PERSONA`，其余 persona 由 `persona-sync` 测试与 `examples/miopiik` 副本保持一致）。

不在库的只有作者私有运行态：API 凭据、模型 allowlist 内容（工作区级 `<workspace>/.dsh/memory/model-allowlist.md`，0.1.8 起不再使用全局文件，详见 [`docs/design/model-auth.md`](docs/design/model-auth.md)）、用户偏好与调研笔记（`docs/profile/`、`docs/research/`）。这是有意的脱敏边界——新部署需自行配置凭据，并用 `mop_model_authorize` 在自己的工作区建立 allowlist。

DSH 兼容矩阵见 [`docs/design/dsh-compat.md`](docs/design/dsh-compat.md)。

## 插件清单（9 插件 + 1 套件包）

> 下表保留 **0.1.x 已发布包的兼容清单**。0.2 默认装配已开始收敛：自动 checkpoint 由 `dsh-miopiik-tool-recovery` 承担；capabilities + run-stats 的实现由新 `dsh-miopiik-diagnostics` 统一拥有。三个旧包仍保留为可安装兼容入口，但不再由默认 meta/preset 挂载。 `dsh-miopiik-magic-keywords` 与 `dsh-miopiik-learn` 也从 0.2 默认面退出，改为显式 opt-in。

| 包                                                                   | 类型     | 工具 / 行为                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dsh-miopiik`](packages/dsh-miopiik/)                               | **套件** | 保留 0.1.x 兼容依赖并挂载 0.2 默认运行时面 + `npx dsh-miopiik` 初始化 miopiik preset                                                                                                                                                                                               |
| [`dsh-miopiik-tool-recovery`](packages/dsh-miopiik-tool-recovery/)   | 恢复     | `mop_checkpoint`（记录目标会话 turn 边界 + git note）、`mop_rewind`（fork 到 checkpoint，含冷会话）、`mop_checkpoint_list`、`mop_checkpoint_prune`（按 `keep` 裁剪，dry-run 默认，`keep=0` 高风险）、`mop_rule_inject` / `mop_rule_show` / `mop_rule_clear`（会话级硬规则注入） |
| [`dsh-miopiik-executor`](packages/dsh-miopiik-executor/)             | 执行     | `mop_spawn_executor`（一次性执行层子代理，**零默认零兜底**：model+provider 必须显式成对给出，省略/只给一边即抛错，无 Config 默认、不继承调用者；逐次指定 `timeoutMs` 硬超时）                                                                                                   |
| [`dsh-miopiik-magic-keywords`](packages/dsh-miopiik-magic-keywords/) | hook     | 正文检测 `ultrathink` / `workflowz`（排除 code fence / inline code）→ `form: notice` 上下文消息注入（Config: `notices` dict）                                                                                                                                                   |
| [`dsh-miopiik-model-auth`](packages/dsh-miopiik-model-auth/)         | 授权闸   | `mop_model_authorize` / `mop_model_revoke` / `mop_model_list` + `agent/request` 硬闸；**allowlist 工作区级**（`<workspace>/.dsh/memory/model-allowlist.md`，0.1.8+，跨工作区隔离；Config: `allowlistPath` 可显式覆盖）                                                          |
| [`dsh-miopiik-capabilities`](packages/dsh-miopiik-capabilities/)     | 探测     | `mop_probe_capabilities`（探测 DSH seam 可用性，清单含「在场 / 实调」双证据与环境行 → `.dsh/memory/capabilities.md`）                                                                                                                                                           |
| [`dsh-miopiik-learn`](packages/dsh-miopiik-learn/)                   | 学习     | `mop_learn`（把可复用流程铸成 `.dsh/skills/<name>/SKILL.md`，被 skill-filesystem 发现）、`mop_learn_list`（只读枚举已铸 skill 名称）                                                                                                                                            |
| [`dsh-miopiik-run-stats`](packages/dsh-miopiik-run-stats/)           | 遥测     | `mop_run_stats`（D18 可编程 token 出口：读 session 累计四桶 uncached/cacheRead/cacheWrite/output，不计算价格/成本）                                                                                                                                                             |
| [`dsh-miopiik-recall`](packages/dsh-miopiik-recall/)                 | 记忆/兼容 | `mop_recall`（0.2 native-first：默认经 DSH `sessionQuery.filterSessions/filterEvents` 读逻辑会话语料库；`caseSensitive=true`、seam 缺失或失败时回退 0.1.x zstd scanner；公开参数与输出习惯保持兼容）                                                                           |
| [`dsh-miopiik-checkpoint`](packages/dsh-miopiik-checkpoint/)         | 记忆     | **里程碑自动检查点**（0.1.13）：根会话每轮关闭由 `agent/turn-stopping` 事件自动追加 `auto-turn` 行到 `.dsh/memory/checkpoints.md`，`agent/error` 记 `auto-error`；同 turn 去重，子代理轮次不写；`mop_checkpoint` 手动显式命名里程碑仍可用且互补                                 |

## 工具安全行为与限制

- `mop_spawn_executor` `Config.strict`（默认 `false`，行为不变）：`true` 时执行层工具面收为 `[read, glob, grep, edit, todo_write]`——去掉 `bash` 与 `write`，面向不可信任务/来宾场景；`edit` 保留以符合 persona「只 append 不覆盖」硬规则。作用域：只收紧 executor 子代理自身的工具面，不改变主会话与全局工具权限。
- `mop_spawn_executor` `timeoutMs`：可选（毫秒），缺省无超时、行为不变。超时经 AbortController 中止子代理并返回 `[aborted] executor timed out after {N}ms`（末尾仍带 `[executor-session: {id}]`）。限制：仅 per-call 参数，无 Config 级默认；不调用 `run.dispose()`，进程内资源清理仍归 provider/tool 层。
- `mop_model_revoke`：从**工作区 allowlist**（`<workspace>/.dsh/memory/model-allowlist.md`）移除 `provider/model`，与 `mop_model_authorize` 对称；拒绝撤销当前默认模型（隐式授权、不在 allowlist），对不存在项幂等返回。限制：全量重写经进程内 `withAuthLock` 串行化，跨进程并发 revoke+authorize 存在丢行窗口（文档化接受，属低频运维操作）。
- `mop_learn_list`：只读枚举 `.dsh/skills/` 下实际含 `SKILL.md` 的 skill 名称（排序），空/目录不存在返回 `(no skills)`。限制：不读内容、不读 frontmatter description、不写任何文件。
- `mop_checkpoint_prune`：`keep` 必填（非负整数）；`confirm` 必须为布尔，仅严格 `true` 才写，缺省/false 一律 dry-run（返回将删数量与 label 清单）。只删 `parseCheckpointLine` 能识别的现行行，注释/空行/旧格式行/普通文本原位保留。`keep=0` 清空全部现行行，高风险、仍需 `confirm:true`。限制：旧格式行永不裁剪；不生成备份文件。
- `mop_recall`：0.2 默认通过 DSH 原生 `sessionQuery` 的 provider-independent filters 只读检索 live-preferred 逻辑会话语料库，不要求全文 FTS 索引、也不依赖私有日志目录；`caseSensitive=true` 或原生 seam 不可用时才走旧 zstd 流式扫描。两条路径都不修改会话；`maxLines` 仍为全局返回上限。
- 自动检查点（0.2 默认由 `dsh-miopiik-tool-recovery` 承担）：只写 `<cwd>/.dsh/memory/checkpoints.md`，仅根会话（`delegationDepth=0`）生效，子代理轮次不写；落盘失败仅 warn、绝不阻断轮关闭。`dsh-miopiik-checkpoint` 保留为迁移期兼容包。

## 安装

三级路径，按需选择其一；**同一 profile 内勿混用**（尤其勿把套件包与逐包安装叠加，重复插入同名行属于未定义组合）。

### 方式一（推荐）：套件包一条命令

```bash
# 插件层：一条命令安装套件；当前 0.2 收敛分支默认运行时挂载 5 行，兼容/可选包仍随依赖保留但不再单独挂载
dsh plugin --profile web add dsh-miopiik

# preset 层（完整四层工作流需要）：初始化 miopiik preset 到 ${DSH_HOME}/.agent-presets/miopiik
npx dsh-miopiik               # 目标已存在则拒绝覆盖；--force 覆盖（别名 dsh-miopiik-init 同义）
```

`dsh plugin add` 会把声明了 `dsh.bundle.patch` 的包并入 profile 的 bundles 列表并自动解析依赖；重启后 `standingKeyFor` 挂载验证。

### 方式二：逐包安装（按需取用）

每包已声明 `dsh.bundle.patch`，npm 名即包名：

```bash
dsh plugin --profile web add \
  dsh-miopiik-tool-recovery \
  dsh-miopiik-executor \
  dsh-miopiik-model-auth \
  dsh-miopiik-diagnostics \
  dsh-miopiik-recall

# 0.2: do not also add dsh-miopiik-checkpoint with tool-recovery.
# The old package is compatibility-only; mounting both would duplicate auto-checkpoint events.
# Likewise, do not add capabilities/run-stats alongside diagnostics in the default 0.2 profile; the old packages are standalone compatibility entries.
# Optional legacy/workflow helpers are explicit opt-in:
# dsh-miopiik-magic-keywords / dsh-miopiik-learn
```

需要完整四层工作流时再装 preset（脱敏模板在本仓库 `examples/miopiik/`）：

```bash
cp -r examples/miopiik "${DSH_HOME}/.agent-presets/miopiik"
```

重启后 `standingKeyFor('miopiik')` 验证挂载；smoke 步骤见 [`examples/miopiik/README.md`](examples/miopiik/README.md)。

### 方式三：源码 clone/link（开发者）

```bash
git clone https://github.com/Chillizu/mop-plugins && cd mop-plugins
dsh plugin --profile web add \
  link:./packages/dsh-miopiik-tool-recovery \
  link:./packages/dsh-miopiik-executor \
  link:./packages/dsh-miopiik-model-auth \
  link:./packages/dsh-miopiik-diagnostics \
  link:./packages/dsh-miopiik-recall
```

免发布/pnpm 的等价做法：把包目录放到任意位置（如 `~/.dsh/profiles/dsh-miopiik-*`），在 `~/.dsh/profiles/node_modules/` 下建同名 symlink（`ln -sfn ~/.dsh/profiles/dsh-miopiik-executor ~/.dsh/profiles/node_modules/dsh-miopiik-executor`），preset 行写裸包名 `dsh-miopiik-<feature>`——这样 Web UI 插件列表显示的是包名而非文件路径（`@deepseek-ai/dsh-*` 依赖同样靠 `~/.dsh/profiles/node_modules` 的 fallback 解析）。bundle 方式可被 `dsh plugin list/remove` 管理。

### 从旧名迁移（2026-08 前安装的本地环境）

1. 用新包名重装（方式一/二/三任一），再 `dsh plugin remove` 掉旧 `@chillizu/mop-*` 行；
2. 删除旧 symlink 与空 scope 目录：`rm ~/.dsh/profiles/node_modules/@chillizu/mop-* && rmdir ~/.dsh/profiles/node_modules/@chillizu 2>/dev/null`；
3. preset 行名同步为新包名（重新执行 `cp -r examples/miopiik ...` 最省事）；
4. 重启后 `standingKeyFor('miopiik')` 复验。工具名 `mop_*` 未变，会话记忆/checkpoints 文件无需迁移。

## 版本演进与验收（0.1.6 → 0.1.13）

完整逐版记录见 [CHANGELOG.md](CHANGELOG.md)；缺陷闭环摘要：

| 版本   | 内容                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.6  | 六缺陷初版验收（子代理模型不可预测 / memory 空转 / 弱模型不守规则），确立回归基线                                                   |
| 0.1.7  | **零默认零兜底模型契约**：`mop_spawn_executor` 必须显式 `model`+`provider`，无 Config 默认、无继承、无决策文件兜底                  |
| 0.1.8  | **授权收紧为工作区级**：allowlist 迁至 `<workspace>/.dsh/memory/model-allowlist.md`，撤回全部全局授权；recall 首发（D 缺陷发现）    |
| 0.1.9  | B3（授权对闸门即时生效，共享缓存+mtime 失效）、C2（mop_dispatch 迁至 preset 装配）、D（preset 补 recall 行）                        |
| 0.1.10 | B1 二轮修复（start 阶段错误回传）+ recall scope=session 前缀归一化（R4c）                                                           |
| 0.1.11 | B1 三轮真因：失败是 `stopReason='error'` 的**成功 resolve** 而非 reject → 正常返回路径显式判定                                      |
| 0.1.12 | recall 流式解压，根治 20M+ 大会话 maxBuffer 超限 skip；**四缺陷全数验收 PASS**                                                      |
| 0.1.13 | **里程碑自动检查点**（`dsh-miopiik-checkpoint`）：记忆落盘由 `agent/turn-stopping` 事件驱动，不再依赖 persona 自觉；memory 缺口闭环 |

每版验收证据归档于工作区 `acceptance-*.md`（0.1.8 / 0.1.9 / 0.1.12-FINAL / 0.1.13）。

## 设计（计划树）

完整设计/决策见 [`docs/PLAN.md`](docs/PLAN.md)：三层 + 监督层工作流、固定通信协议、分级记忆、恢复工具包、魔法关键词、模型授权闸，逐条带验收证据。

## 命名约定

- 包 / 插件 name / 组合行 id：`dsh-miopiik-<feature>`（npm 无 scope，与 DSH 官方包的 `dsh-` 风格对齐；2026-08 起由旧名 `@chillizu/mop-<feature>` 全量改名，一一对应）
- 工具：`mop_<verb>`，下划线小写动词（如 `mop_spawn_executor`、`mop_run_stats`），保持不变——与 DSH 内置工具（`session_search`、`send_message` 等）的 snake_case 风格一致；persona、实验 golden 装置不受改名影响
- preset id：小写 `miopiik`

### 模型路由切换（miopiik preset）

examples/miopiik 的 provider/model 用 YAML 锚点收敛为唯一定义点（真实 Loader 组合测试覆盖）：

| 层                         | 模型                                                                                                                                          | 定义位置                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 审查层（主会话）           | 用户自己的模型路由                                                                                                                            | preset 不干预                                                       |
| 常规子代理 / fork / 监督层 | `&flash-model`（示例 opencode-go/mimo-v2.5）                                                                                                  | `tool-subagent` 行 agentOptions（锚点定义处，改一处全跟随）         |
| 规划层                     | `&planner-model`（示例 hy3，与 dispatch 同源）                                                                                                | `tool-subagent-planner` / `tool-subagent-dispatch` 行（唯一手写处） |
| 执行层                     | **零默认零兜底**：`mop_spawn_executor` 每次调用**必须**显式 `model`+`provider` 成对给出，省略或只给一边即抛错（无 Config 默认、不继承调用者） | per-call 参数；未授权模型由模型闸（`dsh-miopiik-model-auth`）拒发   |

换 provider 时改锚点定义处的 `&dsh-provider` 与上述 model 即可；不引入环境变量插值等未证实特性。规划层强模型须先在工作区 `mop_model_authorize` 授权（0.1.8 起授权为工作区级）。
