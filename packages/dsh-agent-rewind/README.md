# dsh-agent-rewind

Agent-driven session rewind for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): name a recovery point, then let the **model** fork the session back to it.

## Why this exists

DSH has the primitive — `ctx.sessions.fork(source, boundary)` — but **no model-visible way to call it**. Every caller today is host or client code:

- host Service `ctx.sessions.fork`
- host Remote `session.fork({ sessionId, atSeq? })`
- the Web GUI branch button

So an agent can _ask you_ to branch a session, but it cannot branch one itself, and there is no durable index saying "this is the boundary I want to come back to". This package supplies exactly that, and nothing else.

## Install

```bash
dsh plugin --profile <profile> add dsh-agent-rewind
```

Restart DSH afterwards, or install `dsh-session-policy` which depends on this package.

## Tools

| Tool                    | Parameters                      | Behavior                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_checkpoint`      | `label!`, `note?`, `sessionId?` | Records a named recovery point: the target session's last completed turn boundary (`turn/end` seq, inclusive) is appended to `<cwd>/.dsh/memory/checkpoints.md`. When the file holds more current-format checkpoints than the configured limit (default 200), the oldest are pruned automatically. |
| `agent_rewind`          | `sessionId!`, `label!`          | Looks up the newest checkpoint for that label, verifies it belongs to the session, then forks a child session at that boundary and returns its id.                                                                                                                                                 |
| `agent_checkpoint_list` | —                               | Lists every parseable current-format checkpoint (label / session / seq / note).                                                                                                                                                                                                                    |

No tool surface: on a root session, each closed turn appends an `auto-turn` line and a failed turn appends `auto-error`. This is recovery telemetry — a write failure only warns, and never fails turn shutdown.

A checkpoint is meaningful only **across** turns, so call `agent_checkpoint` at the start of the turn after the work you want to be able to return to.

## Design notes

- **Named checkpoints are not the same thing as `@deepseek-ai/dsh-session-checkpoint-policy`.** That package flushes the event log to durable storage before a model request or a side effect (crash durability). This one records human/agent-chosen _named_ boundaries you can deliberately rewind to.
- **The cold path uses DSH's own `buildForkSeed`.** When a boundary falls inside an open turn, the fork seed must be closed with synthetic events (`session/end-seed` + `step/end` + `turn/end`); slicing the raw prefix instead produces a structurally unclosed session. `buildForkSeed` is the first-party way to get that right, and it is imported from `@deepseek-ai/dsh-session/fork` — the same specifier the first-party `dsh-api-session-controller` uses.
- **Not the same thing as the third-party `dsh-rewind` package.** That one is a human-typed `/rewind` slash command that restores _workspace files_ from git snapshots. This one is a _model-invoked_ tool that restores a _session branch_ through DSH's native fork. Different mechanism, different caller, different thing restored — they complement each other.
- **The checkpoint line format is a compatibility contract**: `- [ISO] label | session=<sid> | seq=<n> [| note]`. Pruning only ever removes lines that parse as current-format checkpoints; comments, blank lines, legacy lines and prose are preserved in place.

## Retired upstream condition

If DSH ever ships a model-visible tool for `sessions.fork`, this package should be deleted outright rather than adapted. It exists only to open one deliberately-closed door.

## License

MIT
