# dsh-session-policy

MiOpIIk's session-scoped rules and diagnostics for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Native-first: DSH already provides the primitives, so this package only adds the model-visible surface DSH **deliberately** withholds.

Depends on [`dsh-agent-rewind`](https://www.npmjs.com/package/dsh-agent-rewind) (the named recovery ledger), so one install brings both.

## Install

```bash
dsh plugin --profile <profile> add dsh-session-policy
```

Restart DSH afterwards.

## Tools

| Tool             | Parameters                                         | Behavior                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_rule`   | `action!` ∈ `inject` \| `show` \| `clear`, `text?` | Injects / shows / revokes a hard rule that applies **only to the calling session**, registered through `agent.ctx.systemPrompt.section`. Memory-only, zero files, revocable with one call.                           |
| `session_doctor` | `mode!` ∈ `seams` \| `stats`, `sessionId?`         | `seams`: probes DSH seam availability with **real non-destructive calls** and writes `.dsh/memory/capabilities.md`. `stats`: reads the `tokenUsage` projection (uncached input / cache read / cache write / output). |

No tool surface: rule cleanup on `agent/disposed` plus an `ctx.effect` backstop, and a one-shot seam probe for root sessions on `agent/created`.

## What each tool actually adds

**`session_rule`** — DSH's `systemPrompt.section()` is a plugin API, and the upstream README states plainly that _"there is no end-user prompt-editing API"_. The persistent alternative, `AGENTS.md`, is a **global, cross-session, on-disk** document; it cannot express "applies to this session only, and can be revoked right now". That gap is what this tool fills.

**`session_doctor(seams)`** — the native `cordis_inspect_*` tools report API _shape_ and state explicitly that they "cannot invoke business Service methods". This mode performs real non-destructive calls (`sessions.list()`, `sessionPersistence.open()` + `read()`) so a seam reports two evidence levels: `present` (the primitive exists) and `invoked-ok` (a real call succeeded). It also writes the manifest to disk so a whole team — and you — can inspect it, not just the one model that ran the query.

**`session_doctor(stats)`** — `dsh-token-meter` registers `tokenUsage`, `contextPressure` and `contextBreakdown`; `dsh-session-stats` registers `sessionStats`. Upstream documents both as `registers nothing model-facing`. This mode is the only model-visible path to those counters, and it works for any `sessionId` including child sessions and cold (disposed) ones.

> Honest scoping: `stats` is not filling a capability gap in the way the other two do — it is only adding a model-facing view over a reading DSH already exposes to clients and the compactor. If this package is ever cut to the bone, delete that mode first.

## Not in scope

Everything DSH already provides positively is out of scope, even when it could be done differently: subagent dispatch and lifecycle, Agent Teams and the shared task board, model authorization and allowlists, session persistence and crash recovery, session search and traces, skill catalog / discovery / loading, sandbox and approval policy, permission presets, compaction, plan mode, goals and todos, workflow orchestration, the Ralph loop, plugin inventory and config editing.

## Retired upstream conditions

Remove a piece as soon as DSH opens the corresponding door — never adapt it:

- DSH exposes a session-level prompt editing entry point → delete `session_rule`
- DSH adds a model-facing surface for token projections → delete `session_doctor(stats)`
- DSH adds a model-visible `sessions.fork` tool → delete `dsh-agent-rewind` entirely

## License

MIT
