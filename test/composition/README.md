# Real DSH composition checks

These optional integration checks boot fixtures with the real DeepSeek Harness Cordis loader. They exercise the two retained packages (`dsh-session-policy` = session rules + diagnostics, `dsh-agent-rewind` = named recovery ledger), the native subagent rows, and the DSH token projection that `session_doctor(mode="stats")` reads.

## Run

```sh
npm run test:composition
```

The harness may come from either place, preferred in this order:

1. a built DSH source checkout at `/opt/deepseek-harness` (or `DSH_HARNESS_ROOT=/path/to/harness`);
2. the installed DSH distribution (`@deepseek-ai/dsh/node_modules/@deepseek-ai`, override with `DSH_INSTALL_MODULES`).

`link-harness.mjs` links the real harness packages into `test/composition/node_modules` and the workspace plugin imports into the repo-root `node_modules` (including `@deepseek-ai/dsh-session`, whose `buildForkSeed` the ledger imports statically from its real path). It re-points its own dangling symlinks, so it is safe to call repeatedly.

If neither harness is available the suite fails in `before()` with a clear error instead of a bare `ERR_MODULE_NOT_FOUND`. Unit coverage for the same packages lives in `test/*.test.js`; `npm test` resolves the same `@deepseek-ai/dsh-session` build through `test/register-mocks.mjs` and needs no checkout.

The default push CI runs `npm run check`, lint, format, cross-reference validation, and unit tests. It does not build or boot an external DSH checkout; run `npm run test:composition` separately when that checkout is available.
