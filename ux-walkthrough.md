# UX walkthrough

## Primary job

**Delegate a coding task to another model and get usable work back**, without
the orchestrator having to hold the task in its own context or risk unexpected
spend.

The primary user is an **agent** calling MCP tools. The human paths below are
diagnostic — used when routing is not behaving as expected. Every step is
checkable: if it does not happen as written, that is a finding.

## Steps

### Flow 1 — First install (human)

1. `npm i -g harness-dispatch`.
2. Run `harness-dispatch status` in any directory.
   - **Expected:** every installed harness CLI is detected and listed with
     billing, safety, tier, model, quota, and capacity. No config file needed.
   - Verified 2026-08-18 from an empty directory: four routes detected with
     correct models and billing classification.
3. Run `harness-dispatch doctor`.
   - **Expected:** node version, config, routes, HTTP auth, billing policy,
     safety policy, and live-probe checks, each `ok` or `fail` with a reason.
   - **Expected:** the live probe is *skipped* by default and says so, because
     running it costs quota.
4. Register the MCP server with the calling agent.
   - **Expected:** `dispatch`, `job_status`, `usage` appear. Exactly three
     tools.

**Empty state:** no harnesses installed. `doctor` reports zero ready routes and
names what it looked for. It does not pretend to be usable.

### Flow 2 — Delegating a task (agent)

1. Call `dispatch` with a prompt and `workingDir`.
2. Fast task: returns `completed: true` with the full result inline.
3. Slow task: returns `completed: false` and a `jobId` before the MCP timeout.
   - **Expected:** nothing is lost to the timeout. The job keeps running.
4. Call `job_status` with the `jobId`.
   - **Expected:** `partialOutput` while running; full result once done.
5. Chain: call `dispatch` again with `contextJobs: [previous jobId]`.
   - **Expected:** the new delegate's prompt contains the earlier task and its
     output, framed as work to build on rather than as instructions.

**Error path:** an unknown or pruned `jobId` in `contextJobs` is reported in
the preamble as unavailable, not silently omitted.

**Error path:** a malformed `jobId` is rejected at the schema, and again in
`jobs.ts`, before any path is joined.

### Flow 3 — Several tasks at once (agent)

1. Dispatch N tasks in quick succession.
2. **Expected:** all return `jobId`s immediately; none block on the others.
3. **Expected:** at most `max_concurrent_runs` agent CLIs run at once; the rest
   are `slotQueued` and start as slots free, oldest first.
4. **Expected:** supervision costs at most 4 processes regardless of N.
5. **Expected with `workspace_policy: copy`:** the tasks genuinely run in
   parallel. Measured: 12 jobs of 9s finished in 11.7s against 108s serial.
6. **Expected with `shared_locked`:** they serialize, because that is what the
   policy promises.

### Flow 4 — Something is wrong (human)

1. A route is not being chosen. Run `status`.
   - **Expected:** the route's line says why — `skipped=safety_incompatible`,
     `breaker=open`, or absent from `Ready to route`.
2. Spend looks unexpected. Run `usage`.
   - **Expected:** per-route calls, successes, failures, and — only when
     non-zero — `rate_limited`, which is not folded into failures.
3. A route looks unreliable.
   - **Expected:** a busy route shows `rate_limited=N failed=0`. Being busy
     never accumulates a reputation for being broken.

### Flow 5 — Restart mid-flight

1. Dispatch a long task; kill the MCP server while it runs.
2. **Expected:** the job continues — it is a detached process with the job
   directory as its source of truth.
3. Restart and call `job_status` with the same `jobId`.
   - **Expected:** current state, and the full result when it finishes.
4. **Expected:** a route that was rate-limited before the restart is still in
   cooldown afterwards; breaker state persists.

## States

Every surface has to be right in these, not just the happy one:

| State | Expected |
|---|---|
| Empty — no harnesses installed | `doctor` reports zero ready routes and names what it looked for; it does not pretend to be usable |
| Empty — no jobs yet | `job_status` with no id returns an empty list, not an error |
| Loading — job running | `partialOutput` streams; status is `running` with a fresh heartbeat |
| Waiting — at concurrency limit | `slotQueued`, reported as queued and never as orphaned |
| Partial — some routes unusable | Usable routes still route; unusable ones say why on their own line |
| Error — dispatch failed | Failure recorded with a parsed message, not raw JSONL |
| Busy — route rate limited | `rate_limited=N`, breaker cools down, `failed` stays 0 |
| Degraded — all routes tripped | Dispatch reports no eligible route and why, rather than hanging |
| Interrupted — server killed mid-job | Job continues; result retrievable by `jobId` afterwards |

## Adversarial checks

| Input | Expected |
|---|---|
| `jobId: "../../etc/passwd"` | Rejected; nothing read outside the jobs root |
| 500 entries in `files` | Rejected at the boundary (cap 64) |
| A file outside `workingDir` under `copy` | Sent, but the isolation-widening is reported in the workspace notes |
| A symlink pointing outside the workspace | Not recreated in the copy; the drop is reported |
| `safety_profile: read_onlyy` | Ignored **and warned**, never silently downgraded to a looser default |
| `${VAR}` in `config.yaml` | Survives `configure`; never rewritten to the literal secret |
| Two dispatches, same `workingDir`, `shared_locked` | Serialized across processes, not just within one |

## Known gaps

- Cursor cannot serve `workspace_edit` on Windows; `status` says so and the
  README documents the override.
- The live dashboard is a compatibility alias and is not part of the primary
  flow.
