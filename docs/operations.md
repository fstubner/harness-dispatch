# Status, quota and observability

What the status model reports and why, and exactly what leaves your machine.

## Status Model

`status --json`, `/v1/status`, and `harness-dispatch://status.json` share the same
shape. Each route includes:

- route id and harness
- billing provider, surface, auth source, billing kind, paid-use flags, and confidence
- configured and effective safety profile
- effective workspace policy
- availability
- tier and model metadata
- quota score and local call count
- circuit breaker state — a tripped route's remaining cooldown is persisted to disk
  (one file per route under `~/.harness-dispatch/breaker_state/`), so a server
  restart mid-cooldown still excludes that route instead of retrying an exhausted
  one with a clean slate; a pre-0.5 single-blob `breaker_state.json` is migrated
  automatically on first read
- skip reason when a route is disabled, unavailable, paid-blocked, unknown-billing,
  safety-incompatible, or circuit-broken
- token limits when known

Safety profiles:

- `read_only`: inspect-only routes.
- `workspace_edit`: default; routes may edit files in the workspace without broad shell access.
- `full_auto`: permits routes that require shell/write automation beyond workspace-edit mode.

Workspace policy:

- `shared`: run directly in the caller's `workingDir`.
- `shared_locked`: run directly in `workingDir`, but serialize write-capable
  dispatches for the same directory across ALL processes — concurrent dispatches
  from separate server instances and detached job runners queue on a heartbeated
  cross-process lock rather than editing the directory at the same time.
- `copy`: copy the project into a workspace OUTSIDE it, run the agent there, and
  return the isolated workspace path plus changed-file metadata. Both isolated
  policies keep their workspaces under the system temp directory; nothing is
  written inside your project. Set `HARNESS_DISPATCH_WORKSPACES_DIR` to put them
  somewhere else — on the project's own volume, for instance, where a
  copy-on-write clone is possible.
- `git_worktree`: create a detached git worktree for the route and return the
  worktree path plus changed-file metadata. This starts from `HEAD`, so
  uncommitted source-workspace changes are not copied.

Known limitation of `copy`: a change to a file's permission bits alone — a
`chmod +x` that leaves the contents byte-identical — is neither reported nor
carried in the patch, because changed files are detected by comparing content
hash and size. Under `git_worktree`, git tracks the mode itself, so this
applies to `copy` only. If a delegated task makes a file executable, set the
bit again after applying.

Write-capable fanout is allowed only with `workspacePolicy: "copy"` or
`workspacePolicy: "git_worktree"`. These modes isolate project state and process
cwd. They are not hardened OS sandboxes: a route with broad shell permission can
still access the host unless the downstream harness or operating system enforces
that boundary.

Provider notes:

- Claude Code `claude -p` is classified as included plan usage. Anthropic announced a
  separate Agent SDK credit pool for it (2026-06-15) and paused that change before it
  took effect; the classification will move only if the split actually ships.
- Codex CLI/SDK uses the official Codex product surface unless a route is explicitly
  configured with an API key, in which case it is API billing.
- Cursor Agent CLI is classified as included usage with possible on-demand continuation.
- OpenAI-compatible `api.openai.com` routes are metered; known local runtimes are local;
  unknown loopback/custom endpoints require explicit billing metadata.

## Observability & Privacy

harness-dispatch contains **no phone-home telemetry** — nothing is ever sent to
the author or any third party. OpenTelemetry tracing is available for your own
use, but **it is off by default** — nothing OpenTelemetry-related initializes
unless you opt in:

- Enable it with `telemetry: { enabled: true }` in `config.yaml`, or the
  `HARNESS_DISPATCH_TELEMETRY=1` env var.
- Once enabled, traces export via OTLP/HTTP to `http://localhost:4318` (the
  standard local collector port) by default. If nothing is listening there,
  spans are simply dropped — no data leaves your machine.
- Traces only go somewhere else if *you* set `OTEL_EXPORTER_OTLP_ENDPOINT` to
  a remote collector.
- `OTEL_SDK_DISABLED=true` forces initialization off even if `telemetry:` is
  enabled in config.

Every dispatch also appends one JSONL line to a local
dispatch log at `~/.harness-dispatch/logs/dispatches.jsonl` (override the
directory with `HARNESS_DISPATCH_LOG_DIR`) — route, success, duration, token
counts, a capped error string, which config file was loaded (`config`), and who
asked: the MCP client's name and version, a per-connection session id, and the
job id (`http` or `cli` for the other surfaces). `status` and `usage` read the
last 7 days of it to show each route's recent success rate. For post-hoc debugging and for seeing which agents use which
routes. It's local-only,
size-capped via single-file rotation, and never sent anywhere. Job artifacts
(prompt, snapshotted files, stdout/stderr, result) live under
`~/.harness-dispatch/jobs/<jobId>/` and are pruned after 7 days of inactivity by
default — set `retention: { jobs_days: N }` in `config.yaml` (or
`HARNESS_DISPATCH_JOB_MAX_AGE_MS` for a millisecond override) to change that
window. `0` means keep forever, and a running or queued job with a live
heartbeat is never pruned regardless of the window.

At most **4 agent CLIs run at once**, machine-wide. Dispatches past that limit
wait in `queued` and start as slots free — you still get a `jobId` back
immediately and nothing is rejected or lost, only delayed. The bound exists
because agent CLIs are heavyweight processes, not fan-outable HTTP calls: a
measured burst of 13 concurrent runs exhausted memory and failed half of them.
Change it with `max_concurrent_runs: N` in `config.yaml`. `0` lifts the cap —
jobs no longer queue for a slot — while still running them through the
supervisor pool, so runner processes stay bounded at 4 however many jobs are in
flight. Memory then scales with the harnesses you actually launch rather than
with a per-job wrapper.

Prompts and outputs flow only to the harnesses/endpoints you configured. **The
router makes no other network call by default.**

### How a route is chosen

Routing is: **tier, then weight x capability, then fallback.**

1. Routes are grouped by `tier` (lowest number first). The lowest tier with an
   eligible route wins; a higher tier is used only when no lower-tier route is
   eligible (disabled, unavailable, circuit-broken, blocked by billing or route
   policy, or already tried for this request).
2. Within that tier, the route with the highest `cli_capability x
   capabilities[task_type] x quota x weight` wins. Nothing else enters the score
   but a few explicit adjustments: a cost penalty under the `standard` route
   policy, a bonus when `hints.model` names the route or its model, and a bonus
   for declared large context under `preferLargeContext`.
3. If the pick fails, the router excludes it and tries the next best, up to
   `maxFallbacks` more times.

So `tier:` and `weight:` in your config are the whole ordering. There is no
benchmark or leaderboard input: an earlier version could fetch public Arena ELO
scores to re-rank routes and derive tiers, but it was off by default and never
changed a logged decision, so it was removed. A `leaderboard:` block or a
`leaderboard_model:` key in an old config still loads and is reported as removed,
with no effect.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HARNESS_DISPATCH_CONFIG` | Path of the config file to load instead of `<state dir>/config.yaml` (`~/.harness-dispatch/config.yaml` by default). `--config` wins over it. A `config.yaml` in the current directory is never loaded unless named here or with `--config`. |
| `HARNESS_DISPATCH_STATE_DIR` | Root of all state (default `~/.harness-dispatch`): config, jobs, breaker state, quota counters, logs, token. |
| `HARNESS_DISPATCH_HOME` | Directory holding the HTTP token file only (default: the state root). |
| `HARNESS_DISPATCH_HTTP_TOKEN` | HTTP bearer token. Overrides the token file; `auth rotate` refuses while it is set. |
| `HARNESS_DISPATCH_JOBS_DIR` | Where job bundles live (default `<state root>/jobs`). |
| `HARNESS_DISPATCH_JOB_MAX_AGE_MS` | Job retention in milliseconds; overrides `retention.jobs_days`. |
| `HARNESS_DISPATCH_WORKSPACES_DIR` | Where `copy` and `git_worktree` workspaces are made (default: under the system temp directory). |
| `HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS` | Age after which a project's old workspaces are deleted on its next isolated dispatch. Positive milliseconds; default 24 h. A run still in progress is never deleted, however old; the age counts from when it finished. |
| `HARNESS_DISPATCH_LOG_DIR` | Directory of the local dispatch log. |
| `HARNESS_DISPATCH_TELEMETRY` | `1` or `true` turns on OpenTelemetry tracing. |
| `HARNESS_DISPATCH_DEPTH` | Set by harness-dispatch on every agent it starts: how many dispatches deep that agent is. An agent at depth 2 cannot start another (a delegate may delegate once). Not meant to be set by hand. |
| `HARNESS_DISPATCH_INPROC_JOBS` | `1` runs jobs inside the server process instead of a detached runner — for tests. Such runs die with the server, and the concurrency cap does not apply. |
