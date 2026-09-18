# DSH 兼容矩阵（mop-plugins）

> 目的：把「插件 peer dependency 用 `*`」这一已知妥协，替换为**可核对的版本/commit 矩阵**。
> DSH 官方仍处 developer preview，seam 语义可能破坏性变动；本文件记录每个 seam
> 的最低验证版本，配合 CI 的 pinned gate + master drift-warning leg 对抗漂移。

## 1. 已验证版本

| 项 | 值 |
|---|---|
| harness 版本 | `0.1.0-rc.5` |
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`（本仓库 CI 的 PINNED 值） |
| Node | `>=22.15`（`registerHooks` + `node --test` glob 需 22+） |
| pnpm（harness 构建） | `11.7.0` |

## 2. 各包依赖的 seam（inject 联合）

| 包 | inject（硬依赖） | 可选 ctx.get | 事件 |
|---|---|---|---|
| dsh-miopiik-tool-recovery | tools, fs, sandboxPolicy, sessions, sessionPersistence | — | agent/disposed |
| dsh-miopiik-executor | tools, subagents | — | — |
| dsh-miopiik-magic-keywords | —（纯 hook） | — | agent/pre-step |
| dsh-miopiik-model-auth | tools | agentDefaultModel | agent/request |
| dsh-miopiik-capabilities | tools, fs, sessions, sessionPersistence, sessionQuery, systemPrompt, sandboxPolicy | — | agent/created |
| dsh-miopiik-learn | tools, fs, sandboxPolicy | — | — |
| dsh-miopiik-run-stats | tools | sessions, sessionProjections, sessionProjectionCache | — |
| dsh-miopiik-recall | tools | — | — |
| dsh-miopiik-checkpoint | — | — | agent/inbox/claimed, agent/turn-stopping, agent/error |

seam 联合：`tools / fs / sandboxPolicy / sessions / sessionPersistence / sessionQuery / systemPrompt / subagents`。
这是 `test/composition/cordis.miopiik-example.yml` 挂载 smoke fixture 所需的最小服务集。

## 3. peer dependency 用 `*` 的成因

- DSH 是 pnpm workspace，其包声明 `workspace:^` 依赖；npm 直接消费会报
  `EUNSUPPORTEDPROTOCOL`，无法用 npm 安装 harness 包。
- 因此 mop 包的 `peerDependencies` 用 `*`，运行时经 bundle/profile 落到 harness 自身
  pnpm 装的 node_modules（见 `test/composition/README.md`「Why symlinks」）。
- 风险被两层缓解：① 本矩阵记录最低验证版本；② composition CI 有 pinned gate + master
  drift-warning leg，seam 破坏性变动会在 master 腿告警。

## 4. CI 覆盖

| 腿 | ref | 作用 | 失败语义 |
|---|---|---|---|
| pinned | `47f9438…`（上表） | 可复现 gate：mop 对已知快照的回归 | 阻断 |
| master | harness HEAD | 上游 seam 漂移预警 | 仅告警（continue-on-error） |

## 5. 升级 pinned 快照的规程

1. 本地 `npm run test:composition`（`DSH_HARNESS_ROOT` 指向新 harness checkout）全绿。
2. 记录新 harness 版本 + commit SHA，更新本文件 §1。
3. 更新 `.github/workflows/composition.yml` 的 `dsh_ref` PINNED 值。
4. 若某 seam 契约变化导致 mop 代码需改，按「活规则」评估是否攒陷阱（d29v3-experiment-design.md §8.3）。
