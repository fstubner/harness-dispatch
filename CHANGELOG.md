# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) and is
pre-1.0, so minor versions can carry behaviour changes.

## [Unreleased]

## [0.6.5] — 2026-08-22

Three findings from a fourth independent acceptance pass. The first is the one
with real consequences; the second is a regression 0.6.3 introduced.

### Fixed

- A pooled supervisor picks up config edits before claiming work. A supervisor
  outlives the server that spawned it by design, and it was also outliving that
  server's CONFIG: remove a route, restart, and dispatch within about five
  seconds, and the old supervisor claimed the job and ran the removed route,
  reporting plain success with nothing signalling the split. For that window
  `disabled:`, `allow_paid_usage` and safety profiles were not the controls they
  appear to be. Reloading is mtime-gated, so the steady-state cost is one stat
  per poll, and a malformed edit keeps the previous config rather than killing
  the supervisor.
- Applying twice no longer reports data loss. 0.6.3 added a guard for "changed
  files recorded but the patch is empty", which is the shape of a patch that
  lost something — and also the shape of a second `apply`, where the project
  legitimately matches the workspace already. It now checks whether those files
  actually reached the project and answers "already applied" when they did.
  Line endings are normalised for that comparison: `git apply` writes through
  the repository's eol settings, so an applied file routinely lands as CRLF
  against an LF workspace copy, and comparing raw bytes would have raised the
  false alarm on the platform it was reported from.
- The `EACCES` message from `serve` no longer blames privileges for a high
  port. Windows reserves whole port ranges, where elevation changes nothing;
  0.6.4 told anyone hitting one to fix something unrelated.

## [0.6.4] — 2026-08-22

The two non-blocking findings left over from 0.6.3's acceptance pass.

### Fixed

- A run in which the harness could not spawn ANY child process is reported as a
  failure, not a success. Codex's Windows sandbox refused every spawn on a deep
  path (`CreateProcessAsUserW failed: 5`), the delegate replied "Unable to read
  file." having read nothing, the process exited 0, and a lenient route returned
  `success: true` — counting a success in `usage`, leaving the breaker closed,
  after 57k tokens and 63 seconds. The router then kept choosing a route that
  could not do anything, which is the shape PRODUCT.md names as a counter-signal.
  The error now says what happened and what to try. Deliberately narrow: it
  matches the harness failing to START a process, not a tool call that failed —
  an agent hitting a permission error and working around it is normal work.
- `serve` on a busy port prints one actionable line instead of a stack trace. A
  listen failure arrives as an 'error' event rather than a rejected call, so with
  no handler Node rethrew it from the event loop: `node:events:486 throw er; //
  Unhandled 'error' event`. `EACCES` and `EADDRNOTAVAIL` are named too.

## [0.6.3] — 2026-08-22

**Upgrade if you use `workspace_policy: copy`.** A third independent acceptance
pass blocked the release on work being silently lost, in the feature whose whole
job is not losing it. Present in 0.6.0, 0.6.1 and 0.6.2.

### Fixed

- A `copy` dispatch returns a file the agent CREATED. It did not: the patch came
  back empty, `apply` said "the agent changed nothing" beside its own list
  saying the file was added, and `discard` then deleted the only copy. A copy
  workspace lives inside the project, so a created file appears on both sides of
  the comparison with identical content — once under
  `.harness-dispatch/.../workspace/` while git scans the project, once at its
  real path inside the copy. Rename detection paired the two and emitted nothing
  at all for that file. A MODIFIED file was unaffected, which is why this
  survived three releases and every live test: they all edited an existing file.
- `apply` refuses instead of reporting "nothing to apply" when the recorded
  changed-file list is not empty but the patch is. That combination means the
  patch lost something, and the reassuring message is the one a user acts on
  before discarding the workspace. It now names the files, says not to discard,
  and gives the path they are still sitting at.
- `discard` retries removing the workspace. The agent CLI has only just exited
  and Windows can still hold a handle on something it wrote — observed live as
  `EBUSY: rmdir ...\workspace` on a discard issued straight after a successful
  apply, where the same removal succeeded moments later. A failure here strands
  the workspace inside the user's project, which is the one place it must not be
  left.

## [0.6.2] — 2026-08-21

Three defects from a second independent acceptance pass, two of which
contradicted claims made in this changelog.

### Fixed

- `HARNESS_DISPATCH_CONFIG` is honoured by the CLI and the MCP server, not only
  by the detached job runner. With the variable set in the ambient environment,
  the server routed on auto-detected defaults while the runner it spawned loaded
  the file the variable named — the two halves of one dispatch working from
  different configs, with nothing reporting the split. Pointing it at a file that
  does not exist is now an error, which 0.6.0 claimed and only the runner
  delivered. Both processes resolve the path through the same function, so they
  cannot drift apart again.
- `usage` shows token totals in its human output. They were reaching
  `usage --json` and the MCP tool but not the text a person actually types at, so
  the surface the 0.6.0 and 0.6.1 notes described was the one place they never
  appeared. A route whose harness reported nothing prints no token line at all,
  rather than a zero that would read as "nothing was spent".
- The "nothing was eligible" error names what actually happened instead of
  asserting all three of disabled, exhausted and circuit-broken. A route the
  operator deliberately blocked on billing was reported as a route health
  problem, printed beside a breaker blob reading `tripped:false, failures:0`.
  Breakers are now named only when one is genuinely tripped. The machine-readable
  `skippedRoutes` detail is unchanged — it was accurate all along.

## [0.6.1] — 2026-08-21

Two defects found by an independent acceptance pass against 0.6.0, both
contradicting something the release claimed.

### Fixed

- `usage` token totals were meaningless for Claude Code. Anthropic splits a
  turn's input across three sibling fields, and only the first — the uncached
  remainder — was read: a turn that consumed 55,213 input tokens was recorded as
  2, and a route showed 28 input tokens across 58 real calls. Cached input is
  now counted, via a new `input_extra`/`output_extra` list on a protocol's
  `usage` mapping whose entries are SUMMED, as against `input`/`output`, which
  are alternative spellings of one quantity and stay first-match-wins. 0.6.0
  advertised token totals; the number it printed was four orders of magnitude
  low.
- `configure` no longer drops an `api_key: ${VAR}` reference when the variable
  is not set in the current shell. The reference resolved to an empty string,
  which is indistinguishable from "this route has no key", so the route was
  re-emitted with no `api_key` line at all — and `configure --yes --force`
  wrote that over a working config, silently deleting the key. References are
  now recorded per route before interpolation, which is the only point at which
  an unset variable is still distinguishable from any other unset variable.

## [0.6.0] — 2026-08-21

The job lifecycle is complete: start, watch, **stop**, **retry**, and **resolve the
isolated result**. Every verb was exercised against real harness CLIs rather than
fakes. The MCP surface grows from three tools to six.

### Added

- **`retry_job`** — run a finished job's task again from its own record: the same
  prompt the delegate actually saw (context preamble included), files, working
  directory, hints and workspace policy. Pass `service` to send the retry to a
  DIFFERENT route, which is the usual reason to retry — the task was fine and the
  route was not. Returns a new jobId; the original is untouched, and retrying a
  still-running job is refused so two attempts cannot race on one directory.
- **Token totals in `usage`** — `inputTokens` and `outputTokens` per route, summed
  from what harnesses actually report. Deliberately not money: subscription CLIs have
  no per-call price, and pricing tokens would mean shipping a rate card that goes
  stale silently. Zero means the harness reported nothing, not that nothing was spent.
- **`workspace`** — inspect, keep or discard the isolated result of a job. `copy` and
  `git_worktree` dispatches already ran the agent in isolation and never touched your
  project, but there was no way to see the actual change, no way to keep it, and no
  cleanup but by hand — so isolated runs were effectively write-only. `action: "diff"`
  returns the real patch, `"apply"` applies it to your project (refusing when the
  project has uncommitted changes, because the patch was built against a clean base),
  and `"discard"` removes the workspace. The patch is always written to the job
  directory, so applying it by hand is available even when the automatic path declines.
- **`resource_weight`** on a route — the concurrency bound now counts CAPACITY, not
  jobs. `max_concurrent_runs` priced an HTTP call to a local endpoint the same as a
  whole Claude Code process, so four cheap endpoint calls could lock out a real
  dispatch. Defaults to 1.0 for CLI routes and 0.1 for endpoints; with every weight at
  1.0 the arithmetic is exactly the old count, so existing configs are unchanged.
- **`cancel_job`** — stop a dispatch you already started. Until now the product could
  start a 60-minute detached run and offer no way to stop it, so a misdirected agent
  kept spending subscription quota and editing a workspace until it finished or timed
  out. A queued job stops outright; a running one tears down within about a second,
  killing the agent CLI and its child processes. Two things it does not do: it does
  not revert files the agent already changed, and it does not count as a route
  failure — the caller changing their mind says nothing about whether the route works.

### Changed

- All three route shapes (`clis:`, `endpoints:`, `services:`) resolve their shared
  settings through one table instead of three hand-written lists. This retires the
  class of bug that produced five separate silent drops, where a correctly spelled,
  correctly valued setting was read by one route shape and ignored by another. A
  legacy `services:` entry naming a harness now also inherits that harness's
  `leaderboard_model` and `thinking_level`, which it previously lost.
- `HARNESS_DISPATCH_CONFIG` pointing at a file that does not exist is now reported by
  the server instead of being silently replaced with auto-detected defaults.
- `install-codex.mjs --config` resolves to an absolute path and is checked at install
  time. A relative path used to be stored as written and resolved later against a
  different working directory, which silently meant "no config".

### Removed

- The unused dashboard renderer (`renderDashboard`, `DashboardState`). Nothing in the
  product called it; the `dashboard` CLI alias maps to `status` and is unaffected.

### Fixed

- Copying a live working directory survives a file disappearing mid-copy. A working
  directory is being written to while it is read — an editor saving, a build watcher
  cleaning, another fanout arm — and any of those used to fail the whole dispatch with
  a raw ENOENT. A vanished file is now skipped and named in the workspace notes; a
  permission error or a full disk still fails loudly.
- Workspace copies ask the filesystem for a copy-on-write reflink
  (`COPYFILE_FICLONE`), which makes a clone near-instant and allocation-free on APFS,
  Btrfs/XFS and ReFS/Dev Drive, and falls back to an ordinary copy everywhere else.
- `workspace` on a `copy` job no longer emits a spurious deletion of the file it is
  editing, and no longer refuses to apply because of its own scratch directory. The
  workspace lives inside the project, which broke both.
- Live agent smoke tests no longer write circuit-breaker state into the real install,
  so a smoke failure cannot block a healthy route for real dispatches.

## [0.5.0] — 2026-08-20

Published to npm on 2026-08-21, with a signed provenance attestation from GitHub
Actions. Anyone on 0.4.0 should upgrade: that release writes resolved API keys into
`configure` output and can destroy a hand-written config.

### Security

- `configure` no longer writes resolved API keys into its output. Keys that came from
  a `${VAR}` reference round-trip as that reference; a literal key is redacted in
  `--print` (which people paste into bug reports) and preserved on disk.
- A dispatch asking for a lower safety profile can no longer be silently ignored. The
  keys that grant or restrict access are rejected by name when misplaced, on the MCP
  surface that actually ships — a previous guard existed only on a code path nothing
  called.
- Symlinks can no longer carry an agent out of an isolated (`copy`) workspace.
- Endpoint hostnames are redacted from status output.

### Added

- Chain delegated work: pass `contextJobs` and an earlier job's prompt and output are
  rendered into the new prompt directly, without routing them through the orchestrator's
  own context.
- `max_concurrent_runs` (default 4) bounds how many agent CLIs run at once,
  machine-wide. Extra dispatches queue and start as slots free; nothing is rejected.
- A route's capability floor can vary by requested safety profile, which lets Cursor
  serve read-only work on Windows instead of being skipped entirely.
- `usage` reports per-route call counts, quota, billing kind and breaker state,
  including work done by detached job runners in other processes.

### Changed

- Arena ELO scoring is opt-in (`leaderboard: { enabled: true }`). Routing defaults to
  the tier and weight you configured rather than a benchmark maintained elsewhere.
- Rate-limited calls are counted separately from failures, so a busy route does not
  accumulate a permanent record of being unreliable.
- `retention: { jobs_days: 0 }` means keep forever, and a running job with a live
  heartbeat is never pruned.

### Fixed

- Nothing is lost to a timeout. Every dispatch runs as a detached background job that
  survives a client timeout, a server restart, and the MCP call's own deadline.
- `workspace_policy: shared_locked` serializes across all processes, not just within
  one. Stale-lock takeover is atomic, so two dispatches can no longer both decide a
  lock is free and edit the same directory.
- Circuit-breaker cooldowns and failure decay survive process boundaries and upgrades;
  `status` and `dispatch` no longer disagree about whether a route is available.
- The OpenAI-compatible HTTP endpoint is backed by a persisted job, so a client that
  times out mid-run can still retrieve the result.
- A rate limit is detected from HTTP status context rather than any occurrence of the
  digits 429 in an agent's output, which used to block healthy routes.
- Bad input gets one actionable line instead of a stack trace or a silent default —
  a missing `--config`, a malformed YAML file, an unknown route id, a typo'd setting.
- `configure --yes --force` no longer deletes harnesses the user added.
- On macOS and Linux, timing out an agent CLI also stops the shells and test runners
  it spawned.

## [0.4.0] — 2026-07-25

First release under the `harness-dispatch` name (previously `harness-router`). Bumped
the MCP surface to three tools: `dispatch`, `job_status`, `usage`.

Known issues in this release, fixed in 0.5.0: `configure` writes resolved API keys into
its output, and `configure --yes --force` can delete user-added harnesses.

[Unreleased]: https://github.com/fstubner/harness-dispatch/compare/v0.6.5...HEAD
[0.6.5]: https://github.com/fstubner/harness-dispatch/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/fstubner/harness-dispatch/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/fstubner/harness-dispatch/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/fstubner/harness-dispatch/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/fstubner/harness-dispatch/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/fstubner/harness-dispatch/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/fstubner/harness-dispatch/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fstubner/harness-dispatch/releases/tag/v0.4.0
