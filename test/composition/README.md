# Real Loader integration tests

Run `npm run test:composition` against the DSH **0.2.1-rc.2** runtime. The harness is resolved from a built checkout at `DSH_HARNESS_ROOT` (if set), otherwise the installed `@deepseek-ai/dsh` distribution. `DSH_INSTALL_MODULES` can override the bundled package directory.

Tests assert the retained policy, rewind, and probe plugins activate on **real Cordis/ToolRuntime**; all six tools register with valid model-facing JSON Schemas, and token projections behave as expected. They intentionally **do not** test upstream subagent-spawn internals: those are not part of MiOpIIk's runtime contract.

CI installs the pinned DSH distribution rather than building upstream `master`. This keeps the integration gate aligned with the published runtime that these packages target.
