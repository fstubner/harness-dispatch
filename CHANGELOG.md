# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) and is
pre-1.0, so minor versions can carry behaviour changes.

## [Unreleased]

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

- Live agent smoke tests no longer write circuit-breaker state into the real install,
  so a smoke failure cannot block a healthy route for real dispatches.

## [0.5.0] — 2026-08-20

Tagged, and **not yet on npm** — the registry still serves 0.4.0 pending a
trusted-publisher configuration. Everything below is available from the repository.

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

[Unreleased]: https://github.com/fstubner/harness-dispatch/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/fstubner/harness-dispatch/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fstubner/harness-dispatch/releases/tag/v0.4.0
