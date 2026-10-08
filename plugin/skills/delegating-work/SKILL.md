---
name: delegating-work
description: Use when a coding task could run on another AI harness instead of consuming your own context/quota — implementing, fixing, reviewing, or planning work in a project via the harness-dispatch MCP server (dispatch/job_status/cancel_job/retry_job/workspace/usage tools). Covers when to delegate, required arguments, and how the inline-or-check grace window works.
metadata:
  short-description: Delegate coding tasks via harness-dispatch
---

# Delegating Work Through harness-dispatch

harness-dispatch routes bounded coding tasks to the best available harness
(Claude Code, Codex, Cursor, Antigravity, or configured endpoints) with
billing- and safety-aware policy. Delegating preserves your own context and
quota for orchestration. You stay responsible for reviewing results.

## When to delegate

Delegate: self-contained implementation tasks, bug fixes with clear repro,
second-opinion code reviews, mechanical sweeps, investigations that need a
lot of file reading. Don't delegate: conversational questions, tasks needing
your session's context, irreversible external actions (deploys, publishing).

## Non-negotiable arguments

On EVERY `dispatch` call that starts work:

- `workingDir`: absolute path to the project root the task is about. If
  omitted, the task runs in the router server's own directory (wrong repo)
  and the response carries a `warning`. Never rely on the default.
- `hints.taskType`: `execute` (writes code/runs commands), `plan` (design,
  no edits), `review` (critique, no edits), or `local` (trivial/mechanical,
  prefers free local endpoints). Omitting it degrades routing quality.

Also set `hints.safetyProfile: "read_only"` for review/plan tasks so
write-capable permission is never granted unnecessarily.

## How a dispatch resolves (inline or check — never lost)

Every `dispatch` starts the task as a background job immediately, then waits
a short grace window (default 25s, tune with `graceSeconds`):

- Finished in time → the response has `completed: true` and the full result
  inline. Done.
- Still running → `completed: false` plus a `jobId`, `nextPollSeconds`, and
  `instructions`. Do other work or wait about `nextPollSeconds`, then call
  `job_status` with that `jobId`: while `status` is `"running"` you get
  `partialOutput` (live tail); once `"completed"` or `"failed"` you get the
  full result.
  Results persist on disk (`~/.harness-dispatch/jobs/<jobId>/`), so checking
  late loses nothing — and an MCP client timeout on the original `dispatch`
  call loses nothing either, since the run never depended on that call
  staying open.

`nextPollSeconds` grows with the job's age: about 15 seconds for a job that
has just started, doubling at each check, up to 5 minutes. Real CLI work often
runs for minutes, so expect the check-later path for it. `graceSeconds: 0` on
`dispatch` skips the inline wait entirely; `job_status` with no `jobId` lists the 20 most recent background dispatches,
newest first, each with its `workingDir` and the start of its prompt
(`promptPreview`) so you can pick out your own among other sessions' jobs.

## Stopping work

Call `cancel_job` with the `jobId` when a run is going the wrong way, went to
the wrong directory, or has been superseded. Give a `reason` — it is recorded
on the job, so whoever reads it later (often you, after a restart) can tell a
deliberate stop from a mysterious death.

A job still waiting for a slot stops outright. A running one tears down within
about a second, killing the harness CLI and its child processes; poll
`job_status` to see it land.

Two things cancelling does NOT do, and both matter before you rely on it:

- **It does not undo work.** An agent that already edited files leaves those
  edits behind. Cancelling stops further work; it is not a rollback. If the
  edits are unwanted, revert them yourself (or dispatch with
  `workspacePolicy: "copy"` next time, so the work lands in an isolated
  workspace you can discard).
- **It does not count against the route.** A cancelled run is not recorded as
  a failure, so cancelling freely costs the route nothing.

## Picking a route or model

- Call `usage` first when unsure: it lists valid route ids, their default
  models, per-session call counts, quota, and breaker state.
- Set `hints.modelTier` on every dispatch, chosen for the task: `cheap` for
  mechanical sweeps and lookups, `standard` for ordinary work and most
  reviews, `strong` only for hard judgment. The router still picks the route,
  and that route runs its own model for the tier — a fallback route too. A
  route with no model for the tier runs its default, reported as
  `routing.modelTierMatched: false`; `usage` shows each route's
  `modelTiers`.
- Do NOT set `service` unless the task needs that exact route. A named route
  gets no fallback: if it is rate-limited or fails, the dispatch fails.
- `hints.model` is an exact model id, and a model id belongs to one harness, so
  use it only together with `service`. It wins over `hints.modelTier`.
- `hints.model` is not validated against the harness's own catalog — an unknown
  name is forwarded to the picked harness as-is and fails there. An empty or
  whitespace-only string is refused by the schema. A value naming a configured
  route steers routing instead of being forwarded, and is reported back as
  `routing.modelHintDropped` — except when you also pass `service`: then only a
  value naming THAT route is dropped, and one naming a different route's id is
  sent to the harness as a model. `service` IS validated: an unknown route id is
  REJECTED with `Unknown service: <name>` and the list of valid ids.
- Route ids carry their suffix — `codex_cli`, not `codex`; `usage` lists the ids
  on this machine.
- Omit `service` to let the router pick by per-task capability scores and
  fall back on failure; pass it only when you specifically need one harness
  (e.g. `service: "codex_cli"` with `hints.model: "gpt-5.6-sol"`).

## Fanout (multiple independent opinions)

`dispatch` with `mode: "fanout"` runs the prompt on several routes in
parallel. Always pass an explicit `models` list — without it, every eligible
route runs and consumes quota on each. Write-capable fanout requires
`workspacePolicy: "copy"` or `"git_worktree"`. Each route that outlives the
grace window returns its own `jobId` to check individually via `job_status`.
`service` is incompatible with fanout — it forces a single route.

## After completion

Read the result critically before using it: check `success`, `route`, any
`warning`, and `skippedRoutes` (explains why routes were passed over —
billing policy, safety incompatibility, circuit breaker). Diff and test any
code the delegated harness wrote; delegation is not review.
