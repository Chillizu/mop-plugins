# Contributing

直接、简洁、无 Emoji、证据优先——文档与提交信息同样遵循。

## 开发环境

- Node >= 22.15（`engines` 约束）。
- `npm install` 安装 eslint、prettier，以及 **真实** 的 `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-tools` / `schemastery`。
  - 前两个是**真依赖**，不是可选：`dsh-agent-rewind/ledger.js` 静态 import `@deepseek-ai/dsh-session/fork` 的
    `buildForkSeed`（冷路径 fork 的正确性依赖它），用 stub 会掩盖真实行为。
  - 只有 `@deepseek-ai/dsh-tools` 与 `dsh-llm` 在测试里被 stub（见 `test/register-mocks.mjs`）——它们是
    harness workspace 包、不在 npm。stub 只在 harness checkout 缺失时生效。

## 门禁

| 命令                             | 作用                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run check`                  | 五个入口的语法检查                                                                  |
| `npm run lint`                   | ESLint（已 ignore `.dsh/**` 会话工作区）                                            |
| `npm run format:check`           | Prettier                                                                            |
| `bash tools/verify-crossrefs.sh` | 文档相对链接检查                                                                    |
| `npm test`                       | 单测；stub 两个 harness workspace 包，其余走真实现                                  |
| `npm run test:contract`          | 会话替身契约校验：**无 stub 独立进程**里对真实 `Session` 类实测，防替身比现实更宽松 |
| `npm run test:composition`       | 真实 DSH Cordis Loader 集成检查；按 `DSH_HARNESS_ROOT` 找源码，缺失时回退已装发行版 |

`npm test`、`test:contract` 与 `test:composition` 都必须绿。**不要**用只跑 `packages/` 的局部 eslint 当验收门——它不会覆盖测试。

## 代码约定

- **原生优先（第一原则）**：DSH 已提供的原语一律不重造、不包装、不平行实现。新增任何代码前先用
  `cordis_inspect_*` / 上游 README / `lib/types/*.d.ts` 取证证明 DSH 没有等价物；取证不到就不写。
- 只补「DSH 有原语、但**刻意**没有模型面」的缝。每条都必须能用一句话说清「DSH 有 X，模型调不到 X」；
  说不清就不该存在。若上游 README 明写某能力不开放给最终用户（如 `systemPrompt` 无 end-user 编辑 API），
  那是**刻意关闭的门**，开缝要窄到不可再窄，且永不复制原语（只调 `ctx.*`）。
- 上游吸收即退场：退场条件写在 `README.md` 与各包 README，DSH 一开对应入口就删，不留兼容层、不做 shim。
- 文件写路径一律走 CAS（`replaceIfVersion` / `createIfAbsent`），不盲覆盖。
- 插件副作用归属当前 fiber（`ctx.effect` / 返回 disposer），stop/update 可回收。
- **对 fork 用 `buildForkSeed`**，不要手工 `events.slice(0, seq+1)`：边界落在未闭合 turn 中间时，
  后者会产出结构未闭合的子会话（缺 `session/end-seed` / `step/end` / `turn/end`）。
- 能力探测的 `presenceOnly` 收**谓词函数**，不是布尔值——传预算好的布尔会被 `typeof fn === 'function'` 判成 false。
- **读 live 会话事件流只能用 `snapshotEvents()`**：真实 `Session` 没有公开的 `.events`，
  读它会拿到 `undefined`。已弃用的同步读是**有意**选择——持久化后端异步缓冲，durable log
  可能落后于内存，而边界必须取「此刻」的值。见 `test/session-contract.mjs`。
- **测试替身不得比现实更宽松**：替身只能暴露真实类型也有的成员。多给一个属性就会让
  整条代码路径假绿——`rootAgent()` 曾凭空提供 `.events`，掩盖了 `agent_checkpoint`
  在真实部署 100% 失败。改替身时同步跑 `npm run test:contract`。

## 版本与发布

两个公开包使用 **lockstep 版本**（同号同发）：`dsh-agent-rewind`（账本）与 `dsh-session-policy`（规则+诊断，
依赖前者）。发布顺序：**先账本，后策略包**。

1. 两个 workspace 同步版本号与内部依赖范围，刷新 `package-lock.json`。
2. 更新 `CHANGELOG.md`、两个包各自的 `README.md`、根 `README.md` 迁移说明。
3. 跑全部门禁（上表六条）。
4. `npm pack --dry-run --workspace <pkg>` 核对文件清单。
5. 提交变更，建立 `v<x.y.z>` tag 并推送。
6. 发布：

   ```bash
   export NPM_CONFIG_CACHE=/tmp/npmcache-mop   # 见下方「npm 陷阱」，必设
   npm publish --workspace dsh-agent-rewind
   npm publish --workspace dsh-session-policy
   ```

7. 若移除已发布包的功能，保留 npm 历史 tarball，并用 `npm deprecate` 指向替代能力与迁移版本。**不要 unpublish。**

0.x 阶段允许通过 minor 版本发布破坏性迁移；版本号遵循 SemVer。

## npm 陷阱（实测踩过，照做可省一轮排查）

1. **只读 cache 会让 npm 静默失败。** 本机 `~/.npm/_cacache` 可能是只读的，此时 `npm publish` /
   `npm deprecate` 只打一行 notice、**退出码仍是 0**，但请求根本没发出去。永远先
   `export NPM_CONFIG_CACHE=/tmp/npmcache-mop`（或任意可写目录）。核对手段：`npm whoami` 必须返回真实用户名。
2. **`curl` 读 registry 会命中 CDN 缓存，看到过期数据。** 普通 `curl` 可能返回几分钟前的 packument，
   于是「刚发布的版本看不到」→ 误判为发布失败或进了待审队列。权威读法带 token + 破缓存：

   ```bash
   TOKEN=$(grep -oP '_authToken=\K.*' ~/.npmrc)
   curl -s -H "Authorization: Bearer $TOKEN" -H 'Cache-Control: no-cache' \
     "https://registry.npmjs.org/<pkg>?t=$(date +%s%N)"
   ```

3. **`409 Cannot publish over previously staged version` 是误导性措辞。** 当该版本其实**已经发布成功**时也会报这句。
   先按第 2 条确认线上真实版本，再决定是否重发——不要据此认为存在待审队列。
4. **全新包会先拿到一个公开的 `0.0.0-stage` 占位版本**（npm staged publishing）。占位**不代表**发布未完成；
   以 `dist-tags.latest` 是否指向你的版本为准。
5. 验证发布成功的**唯一可信手段**是从公开 registry 真装一次，而不是读回执：

   ```bash
   mkdir -p /tmp/v && cd /tmp/v && npm init -y >/dev/null
   npm install dsh-session-policy@<version> --ignore-scripts
   ```
