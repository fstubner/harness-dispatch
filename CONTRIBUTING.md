# Contributing

Bug reports and pull requests are welcome. For a vulnerability, follow
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Build and test

You need Node.js `>=22.22.2` and npm. CI runs Linux, macOS and Windows on Node 24,
plus Linux on Node 22; Windows is a first-class target here, so a change that only
works on POSIX is not finished.

```bash
npm ci
npm run build        # TypeScript to dist/
npm run check        # typecheck, test typecheck, lint, tests, claims checker
npm run smoke        # end-to-end smoke test of the built package
```

`npm run check` is what CI runs. `npm test` builds first, because several tests import
`dist/`. Run one test file with `npx vitest run tests/<name>.test.ts` after a build.
`npm run test:coverage` adds coverage.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing how jobs, workspaces or routing
work. The short version: the job directory on disk is the source of truth, harness
behaviour lives in config rather than code, and every input from the calling agent is
validated at the boundary.

### Live agent smoke tests

`npm run smoke:agents` runs a real task through the harnesses you have installed. It is
opt-in because it spends quota. It creates a disposable project under
`.harness-dispatch/smoke-workspaces`, sends the harness a short prompt, and checks that
`node test.mjs` passes afterwards.

```powershell
$env:HARNESS_DISPATCH_LIVE_AGENT_SMOKE = '1'
npm run build
npm run smoke:agents -- --config config.yaml
```

Add `--allow-paid` to include routes that can bill, and `--safety full_auto` to include
Cursor's print-mode route. Set `HARNESS_DISPATCH_AGENT_SMOKE_ROOT` to put the
disposable workspaces somewhere else.

## The claims checker

`node scripts/check-claims.mjs` (part of `npm run check`, and it needs a build first)
reads the built schema and checks the prose in the repository against it:

- a repo-relative path written in a `.md`, `.ts` or `.mjs` file names a file that exists;
- a hints key or routing key written in prose (the `hints.` and `routing.` forms)
  is one the tool schema or the routing reply really carries;
- every config key is listed in the config reference in `docs/configuration.md`.

It checks that the things you name exist, not that what you say about them is true.
If you add a config key, add its row to the reference. A line that has to name a path
or key that does not exist can carry `claims-check-ignore`.

## Pull requests

- Use conventional commit subjects, as in `git log`: `fix: ...`, `feat(mcp): ...`,
  `docs: ...`, `chore: ...`. Describe what changed for the user, not the mechanism.
- A pull request that fixes a bug needs a test that fails before the fix and passes
  after it. Run the test against the old code to prove it fails; a test that passes
  either way proves nothing.
- A change in behaviour needs a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md),
  and the docs that describe the behaviour updated in the same pull request.
- Keep a pull request to one change. Mention nearby problems instead of fixing them.
- Documentation is plain prose. State what happens and what the limit is; do not
  soften a limit.

## Releases

A release is a separate, maintainer-only step with its own gate: an independent
acceptance record in [acceptance/README.md](acceptance/README.md), then a tag. The
procedure is in [RELEASING.md](RELEASING.md). Do not bump the version in a feature pull
request.
