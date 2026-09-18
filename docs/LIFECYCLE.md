# MiOpIIk lifecycle and 0.2 convergence

This document defines what MiOpIIk owns long-term and what should be delegated back to DeepSeek Harness (DSH).

## Maintenance policy

- **0.1.x is the stable DSH compatibility line.** It receives security fixes, critical bugs, upstream compatibility fixes, and documentation corrections. It should not grow new standalone feature packages.
- **0.2.x is the convergence line.** It reduces the public maintenance surface while preserving compatibility for existing npm users.
- Existing published packages are not removed or unpublished as part of the transition. Packages that leave the default suite first become compatibility or optional packages for at least one minor line.
- DSH-native facilities are preferred when they provide the same primitive with equivalent safety. MiOpIIk should own workflow policy and contracts, not duplicate runtime infrastructure.

## Target ownership

| Current package | 0.2 role | Direction |
|---|---|---|
| `dsh-miopiik` | Recommended entry point | Keep. Own preset installation, compatibility assembly, and migration guidance. |
| `dsh-miopiik-tool-recovery` | Core: recovery | Keep and expand only within recovery: named checkpoint, rewind, prune, rule injection. |
| `dsh-miopiik-checkpoint` | Merge target: recovery | Fold automatic checkpoint behavior into the recovery domain. Keep the old package as a compatibility shim before any removal. |
| `dsh-miopiik-model-auth` | Core: policy | Keep. Evolve toward model/delegation policy rather than a broader runtime. |
| `dsh-miopiik-capabilities` | Merge target: diagnostics | Fold into a diagnostics domain with compatibility/self-test responsibility. |
| `dsh-miopiik-run-stats` | Merge target: diagnostics | Fold into diagnostics as a thin presentation/export layer over DSH telemetry. |
| `dsh-miopiik-executor` | Compatibility | Stop expanding the custom executor runtime. Prefer DSH native subagent primitives and retain only MiOpIIk execution policy/contracts. |
| `dsh-miopiik-recall` | Compatibility | Prefer DSH native session-query tools for new deployments. Retain `mop_recall` only as a transition path while compatibility requires it. |
| `dsh-miopiik-learn` | Optional / workflow concept | Do not grow another skill infrastructure. Keep the useful "completed work -> reusable skill" workflow concept and target DSH's native skill system. |
| `dsh-miopiik-magic-keywords` | Optional legacy | Remove from the future default suite. Keep independently installable for users who explicitly want the behavior. |

## 0.2 target surface

The long-term DSH adapter should converge on three domains plus one entry package:

```text
dsh-miopiik
├── recovery
│   ├── checkpoint
│   ├── auto-checkpoint
│   ├── rewind
│   ├── prune
│   └── rule injection
├── policy
│   ├── model authorization
│   ├── routing contract
│   └── delegation policy
└── diagnostics
    ├── capability probe
    ├── compatibility self-test
    └── token / run stats
```

The names of the eventual domain packages are intentionally not frozen by this document. The responsibility boundaries are.

## What MiOpIIk owns

MiOpIIk should own:

- task decomposition and delegation policy;
- explicit model-routing and authorization contracts;
- reviewer / planner / executor / supervisor responsibilities;
- task and acceptance contracts;
- checkpoint, recovery and handoff semantics;
- cost/quality evaluation and diagnostics;
- portable workflow state that can later be consumed by adapters other than DSH.

## What DSH should own

Prefer upstream DSH for:

- session persistence and indexed session querying;
- subagent process/runtime behavior;
- background job lifecycle and cancellation;
- generic tool timeout policy;
- skill registry, discovery and loading;
- token-usage projections and low-level telemetry collection;
- provider invocation and filesystem primitives.

## Migration rules

1. **No big-bang removal.** A package leaving the default suite first gets a documented replacement path.
2. **Preserve tool names where useful.** Compatibility shims may keep `mop_*` names while forwarding to native facilities.
3. **Do not duplicate upstream primitives just to preserve implementation ownership.** Preserve MiOpIIk semantics instead.
4. **Measure before deleting.** Recovery and recall have public-distribution usage signals; migration must retain clear installation and upgrade guidance.
5. **Keep adapters thin.** If a DSH breaking change requires touching many MiOpIIk packages, treat that as evidence that the boundary is still too wide.

## Planned sequence

### 0.1 maintenance

- document lifecycle and compatibility boundaries;
- fix security / critical correctness / DSH breakage only;
- keep the current nine-package meta installation behavior unchanged;
- avoid new standalone packages.

### 0.2 convergence

- merge automatic checkpoint behavior into recovery;
- add a diagnostics domain for capability and run-stat surfaces;
- migrate the default preset away from the custom executor runtime where native subagent contracts suffice;
- migrate new recall usage to native session-query tools;
- remove magic-keywords and learn from the default suite while keeping explicit opt-in compatibility.

### Later

Once one full minor line has provided compatibility and migration guidance, reassess whether old package shells can be frozen permanently or deprecated at the registry level.
