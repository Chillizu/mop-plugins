# MiOpIIk preset 示例

此目录是脱敏、可重建的 MiOpIIk preset，与 npm 套件中的 `preset/` 保持一致。它不包含凭据、个人模型列表或私有本地路径。

## 安装

```bash
dsh plugin --profile <profile> add dsh-miopiik
npx dsh-miopiik
```

源码开发时，可直接复制此目录至 `${DSH_HOME}/.agent-presets/miopiik/`。安装后重载对应 DSH profile。

## 能力归属

DSH 原生提供 `subagent*` 派发与模型设置、`session_*` 会话查询，以及 skill filesystem/catalog/load。MiOpIIk preset 提供 persona 和调用纪律；恢复插件提供 checkpoint、rewind、prune、规则注入；诊断插件提供能力探测与 token 投影读取。`mop_learn` 是可选的技能创作入口。

默认不包含自有 executor、模型授权闸或 recall 插件。升级 `0.2.x` 时先从 profile 清单移除 `dsh-miopiik-executor`、`dsh-miopiik-model-auth` 和 `dsh-miopiik-recall` 旧行，再添加 `dsh-miopiik`。
