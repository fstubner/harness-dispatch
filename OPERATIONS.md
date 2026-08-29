# Operating harness-dispatch

harness-dispatch runs on a developer's machine, not on a fleet. It is a local
MCP server that spawns agent CLIs as subprocesses; there is no cluster, no
replica set, and usually no operator other than the person using it. This
document is written for that shape, and says so where a section would otherwise
imply infrastructure that does not exist.

Two things make it worth writing down anyway. The failure modes below are real
— every one of them has happened on a real machine and most were found by
someone other than the author — and the most dangerous of them are *silent*.
A dispatch that runs in the wrong directory, a client that quietly has no
tools, a workspace sweep that deletes something it did not create: none of
these announce themselves.

## Signals

**Is it alive.** `GET /health` on the HTTP surface, when `serve` is running. It
is the only unauthenticated route, and answers with liveness, the service name,
and the version:

```bash
curl -s http://127.0.0.1:3333/health
```

Everything else needs the bearer token. For the stdio server (the usual case)
there is no endpoint at all: the signal is that the client shows the six tools.

**Is it configured correctly.** `harness-dispatch doctor` is the primary
signal, and it is designed to be run *before* anything is wrong. It exits
non-zero when a check fails, so it is usable as a gate:

```bash
harness-dispatch doctor --json
```

It covers: the binary, config load, harness detection on PATH, auth, billing
classification, route readiness, whether `git` is present, and whether any MCP
client on this machine points at a path that no longer exists.

**What it is doing and what it costs.** `harness-dispatch status` (route
readiness, quota, circuit-breaker state) and `harness-dispatch usage`
(per-route call counts, tokens, billing kind). Both take `--json`.

**What it did.** `~/.harness-dispatch/logs/dispatches.jsonl`, one JSON object
per dispatch: route, success, duration, tokens, task type, safety profile, the
routing reason, and the candidates the winning route beat. This is the record
to read when asking whether routing is choosing well, rather than whether it
ran.

**Per-job detail.** `~/.harness-dispatch/jobs/<jobId>/` holds the frozen
prompt, the manifest, `status.json`, and captured stdout/stderr. A running job
rewrites `status.json` every 15 seconds; that heartbeat is what distinguishes a
live run from an abandoned one.

**Tracing.** OpenTelemetry spans are emitted when `telemetry.enabled` is set in
config. Off by default.

Two known defects here, both found by an acceptance pass and neither yet fixed,
so do not rely on this signal:

- **Spans are never flushed.** `shutdownObservability()` is exported and called
  from nowhere, so a CLI dispatch exports nothing. Measured: 0 bytes to a local
  collector from a real run.
- **The exported resource attributes would carry the prompt.** OpenTelemetry's
  default process detector includes `process.command_args`, and for
  `harness-dispatch dispatch "<prompt>"` the prompt *is* an argv element. This
  is currently masked by the missing flush; fixing the flush alone would ship
  the leak.

## Alerts

There is nothing to page. Nobody is on call for a tool that runs on one laptop,
and inventing an alerting story here would be fiction. What follows is the
honest equivalent: the conditions worth noticing, and how you would notice
them.

| Condition | How it surfaces | What it means |
| --- | --- | --- |
| A route's circuit breaker is tripped | `status` / `usage` show `breakerTripped` | Repeated failures on one route; it is being skipped until the deadline expires (max 24h) |
| `doctor` exits non-zero | Exit code, and the failing check by name | Something in the chain is broken *now* — most often auth, a missing CLI, or a client entry pointing at a deleted path |
| A route is `paid_blocked` | `status`, and a refused dispatch naming it | The route has no billing backstop and needs an explicit `allow_paid_usage: true` |
| Jobs reported `orphaned` | `job_status` | The server that owned the run exited before it finished. The run is gone; the artifacts are not |
| Config warnings | `doctor` (fails), `status` (lists them) | A config entry had no effect — e.g. `services:` written as a list, which silently renames routes to array indices |

If you want any of this to actually page someone, `doctor --json` and
`status --json` are the two commands to wrap; both are stable, machine-readable
and exit-coded.

## Failure modes

Ordered by how much damage they do, not how often they happen.

**A dispatch runs in the wrong directory.** `workingDir` is not inferred. If it
is omitted the task runs wherever the *server* process happens to be, which is
almost never the project you meant. Relative paths are refused outright for
this reason — the caller and the server are different processes with different
working directories, so there is no correct relative value. An omitted value
produces a visible warning in the response.

**A delegate edits files you did not expect.** Safety profiles are ceilings,
not requests: a route that cannot honour the requested profile is skipped
rather than run with more access. The failure mode is asking for more than you
meant — `full_auto` grants shell. Under `copy` and `git_worktree` the work
happens outside your project and reaches it only through `workspace apply`.

**Disk fills with abandoned workspaces or job bundles.** Both are retained on
purpose (24h for workspaces, 7 days for jobs) so their output can still be
inspected. This project has lost a disk to leaked scratch directories once —
2,605 orphaned directories, 0 bytes free on a 931 GB volume — which is why the
sweeps exist. Both now delete only directories they can prove they created: a
workspace root carries a `.harness-dispatch-root` marker, and a job directory
must match the `job-<timestamp>-<8 hex>` name the tool generates. If you point
`HARNESS_DISPATCH_WORKSPACES_DIR`, `HARNESS_DISPATCH_JOBS_DIR` or
`HARNESS_DISPATCH_STATE_DIR` at a directory of your own, that guard is what
stands between your files and a recursive delete.

**A client silently has no tools.** An MCP client that cannot spawn its server
does not report an error; it simply shows nothing, which looks exactly like
never having installed it. On the author's machine this state lasted months
after a directory rename. `doctor` fails on it now, and
`harness-dispatch connect` writes the entry rather than leaving you to paste
one.

**A run outlives its server.** Jobs run in a detached process, so a client
timeout or a server restart does not kill them. If the server dies while a job
is *running*, the job dies with it and is reported `orphaned` within 90
seconds. If it dies while a job is waiting for a concurrency slot, that job is
reported `orphaned` at the next server start — deliberately reported rather
than resumed, because silently running an abandoned job against your repository
is not a decision a restart should make.

**Quota exhaustion on one route.** Repeated failures trip the breaker and
routing moves on. Nothing is lost; the dispatch falls back unless
`--no-fallback` was passed.

**A harness streams and then stops.** Some CLIs emit progress and exit without
an answer. That is reported as what it is — how many events streamed, the last
one, the exit code — rather than handing you the raw stream as if it were an
error message.

## Recovery

**A tripped breaker.** Wait, or restart the server. Deadlines are capped at 24
hours and a single success closes it. `status` shows the remaining time.

**An orphaned or failed job.** `retry_job <jobId>` re-runs it from its own
record — the frozen prompt, files, working directory and hints — optionally on
a different route with `retry_job(jobId, service)`. A model that only made
sense for the old route is left behind and reported, so retargeting is not
defeated by a stale model name.

**A run going the wrong way.** `cancel_job <jobId>` stops it within about a
second, killing the agent CLI and its children. Files already changed are *not*
reverted; this stops further work, it is not a rollback.

**Recovering a delegate's work.** For an isolated dispatch: `workspace diff` to
see the patch, `workspace apply` to land it, `workspace discard` to drop it.
`apply` refuses when the project has moved underneath the run rather than
producing a mangled merge, and refuses a second time once applied. If `git` is
missing the response still carries `workspaceRoot`, so the changes are
recoverable by hand.

**A broken config.** The server keeps running the last config that loaded and
reports the parse error; it does not fall back to defaults and does not exit.
Fix the file and it reloads within a few seconds. `harness-dispatch configure
--print` regenerates a valid one without writing.

**A leaked HTTP token.** `harness-dispatch auth rotate`. A running server picks
up the new value, and the old one stops working immediately.

**A client entry pointing at a path that no longer exists.**
`harness-dispatch connect` rewrites it; `connect --remove` takes it out. Both
back the file up next to itself first and merge rather than replace.

Neither replaces an entry you edited by hand without your say-so: run `connect`
with no `--clients` and it shows you the difference and asks, and `--force`
overrides. Naming a client with `--clients` is not treated as consent for that
— it says which client, not "overwrite whatever I put there". (An acceptance
pass found this sentence promising a guard that only `--remove` implemented,
while `connect` printed the hand-written entry it was about to destroy and then
destroyed it. Both now behave as described.)

**Reclaiming disk now.** Delete `~/.harness-dispatch/jobs/` and the workspaces
base (`%TEMP%/harness-dispatch/workspaces` unless overridden). Nothing there is
required for the server to start; you lose the ability to inspect or apply past
runs.

**Starting over.** Remove `~/.harness-dispatch/` entirely. It holds the token,
quota counters, breaker state and job bundles — all regenerated on next use.
Your `config.yaml` lives in the project, not there.
