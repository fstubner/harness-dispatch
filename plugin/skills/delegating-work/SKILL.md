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
  `instructions`. Do other work or wait ~5 minutes, then call `job_status`
  with that `jobId`: while `status` is `"running"` you get `partialOutput`
  (live tail); once `"completed"` or `"failed"` you get the full result.
  Results persist on disk (`~/.harness-dispatch/jobs/<jobId>/`), so checking
  late loses nothing — and an MCP client timeout on the original `dispatch`
  call loses nothing either, since the run never depended on that call
  staying open.

CLI harnesses take 3–15 minutes, so expect the check-later path for real
work. `graceSeconds: 0` on `dispatch` skips the inline wait entirely;
`job_status` with no `jobId` shows every known background dispatch.

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
- `hints.model` (and the top-level `service`) are NOT validated — an unknown
  name is silently ignored and routing proceeds without it.
- Omit `service` to let the router pick by per-task capability scores;
  pass it only when you specifically want one harness (e.g. `service:
  "codex"` with `hints.model: "gpt-5.6-sol"` for a hard refactor).

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
