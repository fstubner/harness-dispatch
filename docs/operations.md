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
counts, and a capped error string, for post-hoc debugging. It's local-only,
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

Routes rank on the `tier` and `weight` you set. Optionally, public Arena ELO
benchmark data can inform ranking and derive tiers automatically:

```yaml
leaderboard:
  enabled: true    # default false
```

Turning it on adds one GET to `api.wulong.dev` per process, refreshed daily.
It sends nothing about you or your prompts. It is off by default because a
benchmark maintained elsewhere should not quietly reorder the subscriptions
you are paying for, and because a routing tool should not need the network to
decide which of your local CLIs to run.
