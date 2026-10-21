# Contributing / releases

This repository is in maintenance mode. Prefer DSH native APIs and delete an extension when upstream exposes equivalent model-facing behavior. Do not add compatibility layers for obsolete DSH builds.

## Supported runtime

- Node >= 22.15.
- DSH **0.2.1-rc.2**. Published DSH peer versions match this prerelease exactly to avoid silent mismatches across incompatible RCs.
- `dsh-session-policy` and `dsh-agent-rewind` share a lockstep release number. `mop-probe` has a separate version line.

## Gates

```bash
npm ci
npm run check
npm run lint
npm run format:check
npm test
npm run test:contract
npm run test:composition
```

Tests must cover **real** Harness Loader and ToolRuntime, not just mocks. Do not reintroduce the old independent subagent-spawn fixture: it tested upstream transport internals unrelated to our retained packages, and broke when DSH 0.2.1 changed its required Services. The retained bundles' real Loader and JSON Schema contracts remain covered.

## Publish

1. Bump `dsh-agent-rewind` and `dsh-session-policy` together; update their dependency range. Bump `mop-probe` separately when its package changes. Update the root manifest, lockfile, changelog and READMEs.
2. Run every gate. Inspect `npm pack --dry-run --workspace <package>` for each artifact; verify license and `cordis.patch.yml` are included.
3. Commit, merge the release branch into `main` and push. Tag releases distinctly: `v<policy-version>` for the policy pair and `mop-probe-v<probe-version>` for the probe.
4. Publish policy pair **in order**: `dsh-agent-rewind` first, then `dsh-session-policy`; publish `mop-probe` separately.
5. Verify npm registry `dist-tags` and install exact versions in a clean directory. Registry propagation can lag even after an apparently successful publish.

### Local npm publishing gotchas

The previous release found this machine's default npm cache could cause a publish to exit successfully without actually sending the request. Use a **writable** cache, e.g. `NPM_CONFIG_CACHE=/tmp/npmcache-mop-<release>` and verify `npm whoami` before publishing. Do not interpret an immediate registry 404 or placeholder `0.0.0-stage` as definitive failure; check the canonical registry with a cache-busting query and verify installation after propagation. A `409` may also mean a publish actually succeeded; inspect the registry before retrying. Avoid logging or committing npm authentication tokens.

Do not unpublish old packages; their tarballs preserve compatibility for old consumers. Historical design documents are recoverable from Git history.
