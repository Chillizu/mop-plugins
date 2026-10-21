# mop-plugins (MiOpIIk)

Three small, **native-first** extensions for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Targets DSH **0.2.1-rc.2**. DSH owns Agent Teams, subagents, search, skills, approvals, Worktrees, Ralph, and orchestration; this repository does not reimplement them.

## Packages

| Package                                                       | Version | Model-facing tools                                          | Why it exists                                                                                                                    |
| ------------------------------------------------------------- | ------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`dsh-agent-rewind`](packages/dsh-agent-rewind/README.md)     | 0.5.2   | `agent_checkpoint`, `agent_rewind`, `agent_checkpoint_list` | Named, Agent-readable checkpoint ledger and Session fork at a recorded boundary; distinct from DSH crash recovery.               |
| [`dsh-session-policy`](packages/dsh-session-policy/README.md) | 0.5.2   | `session_rule`, `session_doctor`                            | Reversible rules for the calling Session, plus runtime capability and token projection diagnostics. Installs `dsh-agent-rewind`. |
| [`mop-probe`](packages/mop-probe/README.md)                   | 0.1.1   | `mop_probe_env`                                             | Optional read-only audit of the model-visible JSON Schema surface, including invalid object roots.                               |

The **six tools** are optional; no custom executor, model router, Agent Teams implementation, memory engine, or replacement of DSH built-ins is shipped. `mop-probe` is deliberately separate, so ordinary Sessions do not need diagnostic tools.

## Install

```bash
# Session policy + named checkpoint/rewind ledger (two packages, one command)
dsh plugin --profile web add dsh-session-policy@0.5.2

# Optional, independent deployment/schema probe
dsh plugin --profile web add mop-probe@0.1.1
```

After changing a running profile, restart the DSH process that owns it (for example, `systemctl --user restart dsh-web.service` if installed as a user service).

Both policy and rewind can also be installed independently. Their `dsh.bundle.patch` entries contribute only the two required host plugins; they do not modify DSH presets or permissions. `mop-probe` contributes one row.

## Scope and guarantees

- **Named rewind** uses DSH's Session Fork primitives; fork creates a **new Session**, and it does not restore working-tree files. Auto-checkpointing writes concise turn/error records to `.dsh/memory/checkpoints.md`, with bounded pruning.
- **Session rules** are scoped to the calling Session and can be injected, viewed or cleared through `session_rule`. They are not a substitute for DSH host permissions.
- **Diagnostics** use DSH Services and token usage projections; a missing token projection is an unknown result, not zero consumption.
- **Tool audit** examines the exposed JSON Schema and reports violations without blocking the agent. It is not a guarantee that arbitrary tools are safe to execute.

If upstream exposes an equivalent model-facing function, retire ours rather than add another compatibility layer.

## Test

```bash
npm ci
npm run check
npm run lint
npm run format:check
npm test
npm run test:contract
npm run test:composition
```

Composition tests use the **real** Cordis Loader from an installed DSH distribution or a built DSH checkout; see [`test/composition/README.md`](test/composition/README.md). Publishing guidance is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## History and maintenance

MiOpIIk originally experimented with a multi-layer Agent architecture, but DSH 0.2.x absorbed almost all of it. This repository is now in **maintenance mode**: bug fixes and compatibility checks only. Older design trees, experiment plans, and superseded compatibility notes were removed from the current checkout to avoid being mistaken for runtime documentation; they remain available in Git history (see commit history through 2026-10-13). The local `.local/miopiik-archive/` is intentionally ignored and was not touched by this cleanup.

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)
