---
name: delegating-work
description: Use when a coding task could run on another AI harness instead of consuming your own context/quota — implementing, fixing, reviewing, or planning work in a project via the harness-router MCP server (code/job/usage tools). Covers when to delegate, required arguments, and the start-then-poll pattern for long tasks.
metadata:
  short-description: Delegate coding tasks via harness-router
---

# Delegating Work Through harness-router

harness-router routes bounded coding tasks to the best available harness
(Claude Code, Codex, Cursor, Antigravity, or configured endpoints) with
billing- and safety-aware policy. Delegating preserves your own context and
quota for orchestration. You stay responsible for reviewing results.

## When to delegate

Delegate: self-contained implementation tasks, bug fixes with clear repro,
second-opinion code reviews, mechanical sweeps, investigations that need a
lot of file reading. Don't delegate: conversational questions, tasks needing
your session's context, irreversible external actions (deploys, publishing).

## Non-negotiable arguments

On EVERY `code` or `job` call:

- `workingDir`: absolute path to the project root the task is about. If
  omitted, the task runs in the router server's own directory (wrong repo)
  and the response carries a `warning`. Never rely on the default.
- `hints.taskType`: `execute` (writes code/runs commands), `plan` (design,
  no edits), `review` (critique, no edits), or `local` (trivial/mechanical,
  prefers free local endpoints). Omitting it degrades routing quality.

Also set `hints.safetyProfile: "read_only"` for review/plan tasks so
write-capable permission is never granted unnecessarily.

## The start-then-poll pattern (default for real work)

CLI harnesses take 3–15 minutes. Never wrap that in a blocking call.

1. `job action=start` with prompt, workingDir, hints. It returns immediately
   with a `jobId` ticket plus `nextPollSeconds` and `instructions`.
2. Do other work, or wait ~5 minutes (e.g. run a sleep command).
3. `job action=get jobId=<ticket>`. While `status` is `"running"` you get
   `partialOutput` (live tail) — use it to confirm progress, then wait and
   poll again. When `status` is `"completed"` or `"failed"` you get the full
   result. Results persist on disk (`~/.harness-router/jobs/<jobId>/`), so
   polling late loses nothing.

Only use the synchronous `code` tool for tasks you expect to finish in under
1–2 minutes (quick questions to an endpoint route, tiny reviews).

## Picking a route or model

- Call `usage` first when unsure: it lists valid route ids, their default
  models, per-session call counts, quota, and breaker state.
- `hints.model` (and `job`'s `service`) are NOT validated — an unknown name
  is silently ignored and routing proceeds without it.
- Omit `service` to let the router pick by per-task capability scores;
  pass it only when you specifically want one harness (e.g. `service:
  "codex"` with `hints.model: "gpt-5.6-sol"` for a hard refactor).

## Fanout (multiple independent opinions)

`code` with `mode: "fanout"` runs the prompt on several routes in parallel.
Always pass an explicit `models` list — without it, every eligible route
runs and consumes quota on each. Write-capable fanout requires
`workspacePolicy: "copy"` or `"git_worktree"`.

## After completion

Read the result critically before using it: check `success`, `route`, any
`warning`, and `skippedRoutes` (explains why routes were passed over —
billing policy, safety incompatibility, circuit breaker). Diff and test any
code the delegated harness wrote; delegation is not review.
