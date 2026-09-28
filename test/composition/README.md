# Real DSH composition checks

These optional integration checks boot fixtures with the real DeepSeek Harness Cordis loader. They exercise retained recovery/diagnostics plugins, native subagent and session-query plugins, and the DSH token projection consumed by `mop_run_stats`.

## Run

```sh
npm run test:composition
```

The tests need a built DSH source checkout at `/opt/deepseek-harness` (or `DSH_HARNESS_ROOT=/path/to/harness`). `link-harness.mjs` creates local symlinks to that checkout and the workspace packages. It assumes the checkout provides DSH `0.1.7-rc.2` APIs.

The default push CI runs `npm run check`, lint, format, cross-reference validation, and unit tests. It does not build or boot an external DSH checkout; run `npm run test:composition` separately when that checkout is available.
