---
name: delegating-work
description: Use when a coding task could run on another AI harness instead of consuming your own context/quota — implementing, fixing, reviewing, or planning work in a project via the harness-dispatch MCP server (dispatch/usage tools). Covers when to delegate, required arguments, and how the inline-or-poll grace window works.
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

## How a dispatch resolves (inline or poll — never lost)

Every `dispatch` starts the task as a background job immediately, then waits
a short grace window (default 25s, tune with `graceSeconds`):

- Finished in time → the response has `completed: true` and the full result
  inline. Done.
- Still running → `completed: false` plus a `jobId`, `nextPollSeconds`, and
  `instructions`. Do other work or wait ~5 minutes, then call `dispatch`
  again with just that `jobId`: while `status` is `"running"` you get
  `partialOutput` (live tail); once `"completed"` or `"failed"` you get the
  full result. Results persist on disk
  (`~/.harness-dispatch/jobs/<jobId>/`), so polling late loses nothing —
  and an MCP client timeout on the original call loses nothing either, since
  the run never depended on that call staying open.

CLI harnesses take 3–15 minutes, so expect the poll path for real work.
`graceSeconds: 0` skips the inline wait entirely; `list: true` shows every
known background dispatch.

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
grace window returns its own `jobId` to poll individually. `service` is
incompatible with fanout — it forces a single route.

## After completion

Read the result critically before using it: check `success`, `route`, any
`warning`, and `skippedRoutes` (explains why routes were passed over —
billing policy, safety incompatibility, circuit breaker). Diff and test any
code the delegated harness wrote; delegation is not review.
