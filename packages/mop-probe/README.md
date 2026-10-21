# mop-probe

MiOpIIk 的**部署探针**：把「这次请求为什么会被上游拒绝」变成一次可查的调用。

模型可见工具恰 **1** 个：`mop_probe_env`。

| mode      | 做什么                                                                |
| --------- | --------------------------------------------------------------------- |
| `"env"`   | 运行/部署/会话/模型事实（node、profile、sandbox mode、cwd、模型路由） |
| `"tools"` | 审计**每个可见工具**的 JSON Schema 是否满足上游的函数调用契约         |
| `"all"`   | 两者都跑                                                              |

## 它为什么存在（事故溯源）

2026-10-13，`web` profile 上一个挂在 agent preset 里的第三方探针包，以 `mop_probe_env`
注册了工具，而它的 `parameters` 是**空 schema**。DSH 的 `tools.register()` 原样路径
**不做 object-root 校验**，于是这个空 schema 一路走到 deepseek API，被上游直接拒绝：

```
Invalid schema for function 'mop_probe_env': schema must be a JSON Schema of
'type: "object"', got 'type: null'.
```

后果不是「这个工具不能用」，而是**该会话此后每一轮都失败**——请求在构造阶段就被拒，
与轮次内容、与 agent 的推理都无关。插件侧代码全绿，错误却只能从 API 报文里看见。

所以本包把判据钉在**本仓库能管住的一侧**：

1. **注册形态唯一**：所有工具一律 `ctx.tools.register(defineTool({ … }))`。
   `defineTool()` 内部走 `parameterSchemaSpecToJsonSchema()`，**结构上保证**
   `{type:'object', properties:{…}}`；零参工具退化成 `properties:{}`，绝不是
   `null`/`type:null`。`test/mop-probe.test.js` 有一条测试扫全部 workspace 源码，
   禁止任何 `.register()` 调用绕过 `defineTool`。
2. **判据双向可用**：`toolSchemaViolations()` 同时吃
   `defineTool` 的**扁平参数图**与 `tools.schemas()` 投影出的 **JSON Schema**，
   CI 测试与运行时 `mode:"tools"` 共用同一份判据，不允许两处各写一套。
3. **只读自检**：`probeToolSurface()` 读 `tools.schemas(scope)`——模型面权威投影，
   只白名单 `name`/`description`/`parameters` 三个字段，正是在这里判等于在线上判。
   发现违规时**如实报告而不是抛错**：探针自身失效时，最不该做的就是再制造一次会话失败。

## 与 `dsh-session-policy` 的分工

| 包               | 探什么                                       | 失败形态                 |
| ---------------- | -------------------------------------------- | ------------------------ |
| `session_doctor` | DSH **seam 可用性** → 落 capabilities 清单   | 功能降级（某能力不可用） |
| `mop_probe_env`  | **这次请求能不能被上游接受** + 进程/会话事实 | **整轮会话直接失败**     |

判据不同、失败面不同，故不合并：seam 探测是「缺什么能力」，schema 审计是「什么在炸会话」。

## 安装

```bash
dsh plugin --profile <name> add <本包路径或发布坐标>
```

本包**不进任何 preset**，也不随 `dsh-session-policy` 连带安装（后者 patch 里没有它）。
诊断工具按需挂载：`cordis.patch.yml` 只有一行 `insert`，不想要就摘掉那一行。

## 设计约束

- **只 inject `tools`**。探针是只读的：不写文件、不碰 sandbox、不开会话，所以不声明
  `fs` / `sandboxPolicy` / `sessions`。少 inject 一条，就少一处上游漂移面。
- **工具面最窄**：1 个工具、1 个必填参数（`mode`）。它自己的 schema 由 `defineTool`
  产出，因此天然满足它自己所审计的那条契约——探针不能是它自己的反例。
- **零凭据**：`mode:"env"` 只报进程/档位事实（`DSH_PROFILE`、sandbox mode、cwd、
  模型路由），不读取也不回显任何凭据或 token。
- **版本独立**：诊断工具不参与 `dsh-session-policy` / `dsh-agent-rewind` 的 lockstep
  发布列车（那两个包 `0.5.x` 同版本；本包 `0.1.x` 独立走）。见
  `test/release-version.test.js` 的 `LOCKSTEP_ROOTS`。
