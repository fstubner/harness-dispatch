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
   - Verified 2026-08-18 on a machine with all four harness CLIs installed.
     The count depends on what is installed, so a reader seeing fewer routes
     is not seeing a failure.
3. Run `harness-dispatch doctor`.
   - **Expected:** node version, config, routes, HTTP auth, billing policy,
     safety policy, and live-probe checks, each `ok` or `fail` with a reason.
   - **Expected:** the live probe is *skipped* by default and says so, because
     running it costs quota.
4. Register the MCP server with the calling agent.
   - **Expected:** `dispatch`, `job_status`, `cancel_job`, `retry_job`,
     `workspace`, `usage` appear. Exactly six tools.

**Empty state:** no harnesses installed. `doctor` fails the routes check with
`0 ready route(s). Looked for these harness CLIs on PATH: claude, codex,
cursor-agent, agy. Install one, or add a route to config.yaml (endpoints: need
no CLI).` It does not pretend to be usable.

> This previously read "names what it looked for" while the code printed only
> the count — a claim written from intent rather than from a run. An
> independent review caught it. The behaviour was the better one, so the code
> was changed to match; verified 2026-08-18 by running `doctor` with only
> `node` on PATH and every route disabled.

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
   parallel, up to `max_concurrent_runs`.
   - At the shipped default (`max_concurrent_runs: 4`): 12 jobs of 9s finish
     in **~31s** — three waves of four.
   - With the bound raised to 12: **11.7s**, against 108s serial.

   > The 11.7s figure was previously quoted without its precondition, which
   > made it unreproducible — an independent review measured 30.7s at defaults
   > and was right to call it. The default bound is 4 because agent CLIs are
   > memory-heavy (see PRODUCT.md constraints), so raising it is a deliberate
   > choice about your machine, not a hidden setting.
6. **Expected with `shared_locked`:** they serialize, because that is what the
   policy promises.

### Flow 4 — Something is wrong (human)

1. A route is not being chosen. Run `status`.
   - **Expected:** the route's line says why — `skipped=safety_incompatible`,
     `breaker=open`, or absent from `Ready to route`.
2. Spend looks unexpected. Run `usage`.
   - **Expected:** per-route calls, successes, failures, and — only when
     non-zero — `rate_limited`, which is not folded into failures.
   - **Including work done by detached job runners started by the running
     server.** This did not hold until 2026-08-19: dispatches run in child
     processes, and the server's counters were loaded at boot and never
     re-read, so `usage` answered zero on the surface this step points at.
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

### Flow 6 — Keeping isolated work (agent)

The second half of an isolated dispatch, and the only destructive operation in
the product. It had no flow here until 2026-08-30, and three separate defects
that destroy or hide a user's work lived in it — a walkthrough-driven pass
would have exercised none of them.

1. Dispatch with `workspace_policy: copy` (or `git_worktree`) into a git repo.
   - **Expected:** the project is untouched while the job runs.
2. Read the run's `notes`.
   - **Expected:** they name anything the workspace does NOT contain —
     directories excluded by name (`bin`, `dist`, `build`, `target`, `obj`,
     `.venv`), dropped out-of-tree symlinks, files that vanished mid-copy. The
     agent worked from that tree, so an omission changes what its answer means.
3. `workspace(jobId, "diff")`.
   - **Expected:** a patch of exactly what the agent changed, project-relative.
4. `workspace(jobId, "apply")`.
   - **Expected:** what `diff` showed is what lands, and nothing else.
5. Now the destructive cases. Between the dispatch and the apply, change a file
   the patch touches, **commit it**, and apply.
   - **Expected:** refused, naming the file. Committing is what the dirty-tree
     refusal tells you to do, so it cannot be the only guard.
   - This must hold for a file the agent **created** as well as one it
     modified. An added file has no recorded base, and skipping it left the
     whole protection off for exactly the change kind that creates new files.
6. Apply twice.
   - **Expected:** "already applied", not a second write and not a conflict
     with itself.
7. `workspace(jobId, "discard")` on work that was never applied.
   - **Expected:** refused unless forced; the only copy is in the workspace.
8. Repeat with `HARNESS_DISPATCH_WORKSPACES_DIR` pointed inside the project,
   which README recommends for reflinks.
   - **Expected:** everything above behaves identically. The workspaces
     directory is this tool's own scratch space and must not read as the user's
     uncommitted work.
9. Take `git` off PATH and try `diff`.
   - **Expected:** a message naming git as the requirement, not a raw errno.

## States

Every surface has to be right in these, not just the happy one:

| State | Expected |
|---|---|
| Empty — no harnesses installed | `doctor` reports zero ready routes and names what it looked for; it does not pretend to be usable |
| Empty — no jobs yet | `job_status` with no id returns an empty list, not an error |
| Loading — job running | `partialOutput` streams; status is `running` with a fresh heartbeat |
| Waiting — at concurrency limit | status reads `queued`; `slotQueued` is a separate boolean on the job record, not the status string. Never reported as orphaned while any supervisor is alive to run it |
| Waiting — but nothing is left to run it | a server start with no live supervisor reports it `orphaned`, saying it was never started and naming `retry_job`. It is not resumed: running an abandoned job unattended in its original working directory is not a decision a restart should make |
| Partial — some routes unusable | Usable routes still route; unusable ones say why on their own line |
| Error — dispatch failed | Failure recorded with a parsed message, not raw JSONL |
| Busy — route rate limited | `rate_limited=N`, breaker cools down, `failed` stays 0 |
| Degraded — all routes tripped | Dispatch reports no eligible route and why, rather than hanging |
| Interrupted — server killed mid-job | Job continues; result retrievable by `jobId` afterwards |

## Adversarial checks

| Input | Expected |
|---|---|
| `jobId: "../../etc/passwd"` | Rejected; nothing read outside the jobs root |
| A prompt near the command-line limit | Refused with a message naming the limit and what to do, BEFORE spawning — never the raw "The command line is too long." The route is not charged. The budget is measured against cross-spawn's real escaping, not estimated; two releases shipped a wrong estimate, once too loose and once too tight |
| `hints.model` naming a configured route | Steers routing; the route runs its own model, and `routing.modelHintDropped: true` says so. `modelHintMatched: false` alone is NOT this case — it is documented as "forwarded blind" |
| `service: "a"` with `hints.model: "a"` | Same drop, same report. This path is separate in the code and had neither until 2026-08-23 |
| `service: "a"` with `hints.model: "b"` (another route's id) | Forwarded as a real model request — the caller already chose the route, so the value can only be a model |
| `hints.model: ""` | Rejected at the boundary. It used to win against the route's configured model, so the harness ran with no model flag and the response reported `model: ""` |
| A delegate's answer that discusses `CreateProcessAsUserW` | Reported as the success it was. The environment detector overrides a successful exit, so it keys on the harness's own diagnostic form on two separate lines, not on the phrase appearing in prose |
| 500 entries in `files` | Rejected at the boundary (cap 64) on BOTH the MCP and HTTP surfaces. HTTP accepted unbounded lists until 2026-08-19 |
| A file outside `workingDir` under `copy` | Sent, but the isolation-widening is reported in the workspace notes |
| A symlink pointing outside the workspace | Not recreated in the copy; the drop is reported |
| `safety_profile: read_onlyy` | Ignored **and warned** on both surfaces, never silently downgraded to a looser default |
| `safteyProfile` (letters transposed) | Rejected with the near-miss message on HTTP; accepted SILENTLY on MCP, which then runs at the default `workspace_edit` — i.e. more access than was asked for. `tools.ts` documents the asymmetry; the row above generalised past it until 2026-08-30 |
| `${VAR}` in `config.yaml` | Survives `configure` as a reference; never rewritten to the literal secret. The reference is RELOCATED into the route's own `api_key:` — the top-level `api_keys:` block itself is not re-emitted. Functionally lossless (the key resolves identically on reload), but the block does not survive verbatim, and this row claimed it did until 2026-08-19 |
| Two dispatches, same `workingDir`, `shared_locked` | Serialized across processes, not just within one |

## Known gaps

- Cursor cannot serve `workspace_edit` on Windows; `status` says so and the
  README documents the override.
- The live dashboard is a compatibility alias and is not part of the primary
  flow.
