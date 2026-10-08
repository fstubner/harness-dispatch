# Operating harness-dispatch

How to tell what it is doing, what breaks and how to recover, what the status model
reports, and exactly what leaves your machine.

harness-dispatch runs on a developer's machine, not on a fleet. It is a local MCP
server that spawns agent CLIs as subprocesses; there is no cluster, no replica set,
and usually no operator other than the person using it. This document is written for
that shape, and says so where a section would otherwise imply infrastructure that does
not exist.

The failure modes below have all happened on real machines, and the most dangerous of
them are *silent*. A dispatch that runs in the wrong directory, a client that quietly
has no tools, a workspace sweep that deletes something it did not create: none of
these announce themselves.

## Signals

**Is it alive.** `GET /health` on the HTTP surface, when `serve` is running. It is the
only unauthenticated route, and answers with liveness, the service name, and the
version:

```bash
curl -s http://127.0.0.1:<port>/health
```

`<port>` is the one `serve` printed at startup. Everything else needs the bearer
token. For the stdio server (the usual case) there is no endpoint at all: the signal
is that the client shows the six tools.

**Is it configured correctly.** `harness-dispatch doctor` is the primary signal, and
it is designed to be run *before* anything is wrong. It exits non-zero when a check
fails, so it is usable as a gate:

```bash
harness-dispatch doctor --json
```

It covers: the binary, config load, harness detection on PATH, auth, billing
classification, route readiness, whether `git` is present, and whether any MCP client
on this machine points at a path that no longer exists. Each row is `ok`, `warn`
(passes, but wants something done, such as a client that is not registered yet) or
`fail`; only `fail` makes the exit code non-zero. The last line is a one-line verdict,
and `--json` carries it as `verdict`.

**What it is doing and what it costs.** `harness-dispatch status` (route readiness,
quota, circuit-breaker state) and `harness-dispatch usage` (per-route call counts,
tokens, billing kind). Both take `--json`. The call counts are lifetime totals, dated
`since` the day they began where that is known; next to them each route shows how it
has done over the **last 7 days** (`last 7d: 15/75 succeeded (20%), 43 rate-limited`),
read from the dispatch log. That recent figure is the one to check before delegating:
a route can be fine for life and failing this week. Counts are attempts, so a fallback
is its own.

**What it did.** `~/.harness-dispatch/logs/dispatches.jsonl`, one JSON object per
dispatch. It is the record to read when asking whether routing is choosing well, rather
than whether it ran. Its fields are listed under
[Observability and privacy](#observability-and-privacy).

**Per-job detail.** `~/.harness-dispatch/jobs/<jobId>/` holds the frozen prompt, the
manifest, `status.json`, and captured stdout/stderr. A running job rewrites
`status.json` every 15 seconds; that heartbeat is what distinguishes a live run from an
abandoned one.

**Tracing.** OpenTelemetry spans are available and off by default; see
[Observability and privacy](#observability-and-privacy).

## Alerts

There is nothing to page. Nobody is on call for a tool that runs on one laptop, and
inventing an alerting story here would be fiction. What follows is the honest
equivalent: the conditions worth noticing, and how you would notice them.

| Condition | How it surfaces | What it means |
| --- | --- | --- |
| A route's circuit breaker is tripped | `status` / `usage` show `breakerTripped` | Repeated failures on one route; it is being skipped until the deadline expires (max 24h) |
| `doctor` exits non-zero | Exit code, and the failing check by name | Something in the chain is broken *now*: most often auth, a missing CLI, or a client entry pointing at a deleted path |
| A route is `paid_blocked` | `status`, and a refused dispatch naming it | The route has no billing backstop and needs an explicit `allow_paid_usage: true` |
| Jobs reported `orphaned` | `job_status` | The process running the job stopped reporting progress and is gone, or a job waiting for a slot lost its server. The run is gone; the artifacts are not |
| Config warnings | `doctor` (fails), `status` (lists them) | A config entry had no effect, e.g. `services:` written as a list, which silently renames routes to array indices |

If you want any of this to actually page someone, `doctor --json` and `status --json`
are the two commands to wrap; both are stable, machine-readable and exit-coded.

## Failure modes

Ordered by how much damage they do, not how often they happen.

### A dispatch runs in the wrong directory

`workingDir` is not inferred. If it is omitted the task runs wherever the *server*
process happens to be, which is almost never the project you meant. Relative paths are
refused outright for this reason: the caller and the server are different processes
with different working directories, so there is no correct relative value. An omitted
value produces a visible warning in the response.

### A delegate edits files you did not expect

Safety profiles are ceilings, not requests: a route that cannot honour the requested
profile is skipped rather than run with more access (see
[safety profiles](configuration.md#safety-profiles-and-cursor)). The failure mode is
asking for more than you meant: `full_auto` grants shell. Under `copy` and
`git_worktree` the work happens outside your project and reaches it only through
`workspace apply`.

### Disk fills with abandoned workspaces or job bundles

Both are retained on purpose (24h for workspaces, 7 days for jobs) so their output can
still be inspected, and sweeps remove them afterwards. The sweeps delete only
directories they can prove they created: a workspace root carries a
`.harness-dispatch-root` marker, and a job directory must match the
`job-<timestamp>-<8 hex>` name the tool generates. If you point
`HARNESS_DISPATCH_WORKSPACES_DIR`, `HARNESS_DISPATCH_JOBS_DIR` or
`HARNESS_DISPATCH_STATE_DIR` at a directory of your own, that guard is what stands
between your files and a recursive delete.

### A client silently has no tools

An MCP client that cannot spawn its server does not report an error; it simply shows
nothing, which looks exactly like never having installed it. A renamed directory is
enough to cause it. `doctor` fails on it, and `harness-dispatch connect` writes the
entry rather than leaving you to paste one.

### A run outlives its server

Jobs run in a detached process, so a client timeout or a server restart does not kill
them. On Windows that also holds behind a launcher that kills the whole process tree
when the session ends: the supervisor that runs the job is started through WMI,
outside the launcher's job object. If WMI cannot be used the runner falls back to a
plain detached spawn, writes that to its spawn log, and a run started that way can be
killed with the session. `doctor`'s `job-runner` check starts a real probe under the
same launcher and fails when the probe is killed with its parent. The mechanism is
described in [ARCHITECTURE.md](../ARCHITECTURE.md#core-flow).

If the process running the job itself dies (a crash, a kill, a reboot), the job is
reported `orphaned` within 90 seconds. If the server dies while a job is waiting for a
concurrency slot and no supervisor is alive, that job is reported `orphaned` at the
next server start, deliberately reported rather than resumed, because silently running
an abandoned job against your repository is not a decision a restart should make. A job
that is waiting while every supervisor has died, but that was not abandoned by a
restart, is different: polling it with `job_status` starts a supervisor (when none is
alive and nothing is running) so the queue drains under the usual `max_concurrent_runs`
cap, and the job's reply says where it stands in the queue and what it is waiting on.

### A streamed request is interrupted

A `stream: true` request runs as a job like every other dispatch, and its id is in the
`x-harness-dispatch-job-id` response header (a fanout's arms each report theirs in the
response). If the connection drops, the run carries on and its result stays
collectable with `job_status`; `cancel_job` stops it.

### Quota exhaustion on one route

Repeated failures trip the breaker and routing moves on. Nothing is lost; the dispatch
falls back unless `--no-fallback` was passed. When the provider's message states when
the limit lifts (Codex's "try again at ...", Claude Code's "resets 1:30am
(Europe/Dublin)"), the route is skipped until then, at most 24 hours at a time. A
Codex run that fails because its Windows sandbox refused the repository commands skips
the route for 30 minutes.

That cooldown is route-wide on purpose, not per project: Codex's sandbox refuses
spawns intermittently and the cause has not been pinned to particular directories, so
one refusal pauses the route for every project. If you suspect the refusals cluster in
certain project folders, check the dispatch log: each row's `jobId` names a job folder
under `~/.harness-dispatch/jobs/`, and that job's `manifest.json` records the
`workingDir` it ran in.

### A harness goes silent

A CLI route with an idle limit (`idle_timeout_ms`) is stopped when it has printed
nothing on either stream for that long, and the failure says so, instead of holding a
concurrency slot until the job ceiling. Which routes ship with one, and why only those,
is in [Time limits](configuration.md#time-limits).

### A harness streams and then stops

Some CLIs emit progress and exit without an answer. When that run fails (a non-zero
exit, or a route that requires an answer to count as success), it is reported as what
it is (how many events streamed, the last one, the exit code) rather than handing you
the raw stream as if it were an error message. On a lenient route
(`success_requires_output: false`) a zero exit is still a success, and what it streamed
is the output.

## Recovery

### A tripped breaker

Wait for the deadline, or close it now with `harness-dispatch breaker reset <route>`.
Restarting the server does **not** clear it: breaker state is saved per route
(`breaker_state/<route>.json` under the state directory) precisely so that a restart
does not forget a cooldown. Deadlines are capped at 24 hours and a single success
closes it. `status` shows the remaining time.

### An orphaned or failed job

`retry_job <jobId>` re-runs it from its own record: the frozen prompt, files, working
directory and hints, optionally on a different route with `retry_job(jobId, service)`.
A model that only made sense for the old route is left behind and reported, so
retargeting is not defeated by a stale model name.

### A run going the wrong way

`cancel_job <jobId>` stops it within about a second, killing the agent CLI and its
children. Files already changed are *not* reverted; this stops further work, it is not
a rollback.

### Recovering a delegate's work

For an isolated dispatch: `workspace diff` to see the patch, `workspace apply` to land
it, `workspace discard` to drop it. `apply` refuses when the project has moved
underneath the run rather than producing a mangled merge, and refuses a second time
once applied. If `git` is missing the response still carries `workspaceRoot`, so the
changes are recoverable by hand.

### A broken config

The server stays up and reports the parse error; it does not fall back to defaults.
While the file does not load, every new dispatch is refused with that error, because a
background run would have to load it too. Fix the file and it reloads within a few
seconds. To see a working config instead, move the broken file aside and run
`harness-dispatch configure --print`, which previews one without writing (run against
the broken file itself, it reports the same parse error).

### A leaked HTTP token

`harness-dispatch auth rotate`. A running server picks up the new value, and the old
one stops working immediately. If the token comes from `HARNESS_DISPATCH_HTTP_TOKEN`
instead of the token file, rotate refuses, since rotating the file would change
nothing: change or unset the variable and restart `serve`.

The token file and the state directories are written owner-only (0600/0700) on Linux
and macOS. On Windows those modes are no-ops, so they are protected by your user
profile's default permissions, not by a mode.

### A client entry pointing at a path that no longer exists

`harness-dispatch connect` rewrites it; `connect --remove` takes it out. Both back the
file up next to itself first and merge rather than replace. `connect` needs the config
file it points clients at to exist: if you have none, run
`harness-dispatch configure --yes` first.

Neither replaces an entry you edited by hand without your say-so: run `connect` with
no `--clients` and it shows you the difference and asks, and `--force` overrides.
Naming a client with `--clients` is not treated as consent for that: it says which
client, not "overwrite whatever I put there".

### Reclaiming disk now

Delete `~/.harness-dispatch/jobs/` and the workspaces base: `%TEMP%\harness-dispatch\workspaces`
on Windows, `<tmp>/harness-dispatch-<uid>/workspaces` on Linux and macOS, or
`HARNESS_DISPATCH_WORKSPACES_DIR` if set. Nothing there is required for the server to
start; you lose the ability to inspect or apply past runs.

### Starting over

Remove `~/.harness-dispatch/` entirely. It holds the token, quota counters, breaker
state and job bundles, all regenerated on next use, and, unless you keep yours
elsewhere, your `config.yaml`: `configure` writes it there by default. Copy it out
first if you want to keep it.

## Status model

`status --json`, `/v1/status`, and `harness-dispatch://status.json` share the same
shape. Each route includes:

- route id and harness
- billing provider, surface, auth source, billing kind, paid-use flags, and confidence
- configured and effective safety profile
- effective workspace policy
- availability
- tier and model metadata
- quota score and local call count
- circuit breaker state. A tripped route's remaining cooldown is persisted to disk
  (one file per route under `~/.harness-dispatch/breaker_state/`), so a server
  restart mid-cooldown still excludes that route instead of retrying an exhausted
  one with a clean slate; a pre-0.5 single-blob `breaker_state.json` is migrated
  automatically on first read
- skip reason when a route is disabled, unavailable, paid-blocked, unknown-billing,
  safety-incompatible, or circuit-broken
- token limits when known

The three safety profiles (`read_only`, `workspace_edit` as the default, `full_auto`)
are defined in [Safety profiles and Cursor](configuration.md#safety-profiles-and-cursor).

Workspace policy:

- `shared`: run directly in the caller's `workingDir`.
- `shared_locked`: run directly in `workingDir`, but serialize write-capable
  dispatches for the same directory across ALL processes. Concurrent dispatches
  from separate server instances and detached job runners queue on a heartbeated
  cross-process lock rather than editing the directory at the same time.
- `copy`: copy the project into a workspace OUTSIDE it, run the agent there, and
  return the isolated workspace path plus changed-file metadata. Both isolated
  policies keep their workspaces under the system temp directory; nothing is
  written inside your project. Set `HARNESS_DISPATCH_WORKSPACES_DIR` to put them
  somewhere else, on the project's own volume for instance, where a copy-on-write
  clone is possible.
- `git_worktree`: create a detached git worktree for the route and return the
  worktree path plus changed-file metadata. This starts from `HEAD`, so
  uncommitted source-workspace changes are not copied.

Known limitation of `copy`: a change to a file's permission bits alone (a `chmod +x`
that leaves the contents byte-identical) is neither reported nor carried in the patch,
because changed files are detected by comparing content hash and size. Under
`git_worktree`, git tracks the mode itself, so this applies to `copy` only. If a
delegated task makes a file executable, set the bit again after applying.

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

## Observability and privacy

harness-dispatch contains **no phone-home telemetry**: nothing is ever sent to the
author or any third party. OpenTelemetry tracing is available for your own use, but
**it is off by default**, and nothing OpenTelemetry-related initializes unless you opt in:

- The OpenTelemetry packages are not part of a default install (they are
  optional peer dependencies). To use tracing, install them into the same
  `node_modules` as harness-dispatch, with the ranges below (the 0.x packages
  must match, so a bare `npm install @opentelemetry/instrumentation` is refused):

  ```sh
  npm install @opentelemetry/api@^1.9.1 @opentelemetry/sdk-trace-node@^2.10.0 \
    @opentelemetry/exporter-trace-otlp-http@^0.221.0 @opentelemetry/resources@^2.10.0 \
    @opentelemetry/instrumentation@^0.221.0 @opentelemetry/instrumentation-http@^0.221.0 \
    @opentelemetry/instrumentation-fs@^0.40.0
  ```

  Enabled without them, harness-dispatch stops with a message that says this.
  `npx` runs a throwaway copy, so use a normal (local or global) install if you
  want tracing.
- Enable it with `telemetry: { enabled: true }` in `config.yaml`, or the
  `HARNESS_DISPATCH_TELEMETRY=1` env var.
- Once enabled, traces export via OTLP/HTTP to `http://localhost:4318` (the
  standard local collector port) by default. If nothing is listening there,
  spans are simply dropped, and no data leaves your machine.
- Traces only go somewhere else if *you* set `OTEL_EXPORTER_OTLP_ENDPOINT` to
  a remote collector.
- `OTEL_SDK_DISABLED=true` forces initialization off even if `telemetry:` is
  enabled in config.
- Spans cover every dispatch: the background job runner, where MCP and HTTP
  dispatches run, exports them, and one-shot CLI commands flush theirs before
  exiting.

**The prompt is kept out of the spans.** OpenTelemetry's default process detector
exports `process.command_args`, and for `harness-dispatch dispatch "<prompt>"` the
prompt *is* an argv element. harness-dispatch therefore uses the default detectors
minus that one (`OTEL_NODE_RESOURCE_DETECTORS=env,host`) unless you set the variable
yourself. If you include `process` there, a CLI dispatch's prompt is exported with
every span.

Every dispatch also appends one JSONL line to a local dispatch log at
`~/.harness-dispatch/logs/dispatches.jsonl` (override the directory with
`HARNESS_DISPATCH_LOG_DIR`): route, success, duration, token counts, a capped error
string, task type, safety profile, the routing reason, the candidates the winning
route beat, which config file was loaded (`config`, so a run against a throwaway
config can be told from real use), and who asked: the MCP client's name and version, a
session id for the connection (one per stdio process or per HTTP MCP session; none for
a 2026-07-28 HTTP request, which has no connection), and the job id (`http` or `cli`
for the other surfaces). `status` and `usage` read the last 7 days of it to show each
route's recent success rate. It is for post-hoc debugging and for seeing which agents
use which routes. It is local-only, size-capped via single-file rotation, and never
sent anywhere.

Job artifacts (prompt, snapshotted files, stdout/stderr, result) live under
`~/.harness-dispatch/jobs/<jobId>/` and are pruned after 7 days of inactivity by
default. Set `retention: { jobs_days: N }` in `config.yaml` (or
`HARNESS_DISPATCH_JOB_MAX_AGE_MS` for a millisecond override) to change that window.
`0` means keep forever, and a running or queued job with a live heartbeat is never
pruned regardless of the window.

Prompts and outputs flow only to the harnesses/endpoints you configured.
**harness-dispatch makes no other network call by default.**

## Concurrency

At most **4 agent CLIs run at once**, machine-wide. Dispatches past that limit
wait in `queued` and start as slots free: you still get a `jobId` back
immediately and nothing is rejected or lost, only delayed. The bound exists
because agent CLIs are heavyweight processes, not fan-outable HTTP calls, so memory
is the limit, not cores. Change it with `max_concurrent_runs: N` in `config.yaml`.
`0` lifts the cap (jobs no longer queue for a slot) while still running them
through the supervisor pool, so runner processes stay bounded at 4 however many
jobs are in flight. Memory then scales with the harnesses you actually launch rather
than with a per-job wrapper. The CLI `dispatch` command runs in its own process and
is outside this cap.

## How a route is chosen

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
| `HARNESS_DISPATCH_DEPTH` | Set by harness-dispatch on every agent it starts: how many dispatches deep that agent is. An agent at depth 1 or more cannot start another: a delegate may not dispatch at all. Not meant to be set by hand. |
| `HARNESS_DISPATCH_INPROC_JOBS` | `1` runs jobs inside the server process instead of a detached runner, for tests. Such runs die with the server, and the concurrency cap does not apply. |
