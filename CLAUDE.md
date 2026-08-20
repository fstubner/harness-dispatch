# Harness Dispatch — Local Agent Instructions

Use `harness-dispatch` as a local dispatcher for coding work when it is configured.

Public MCP surface:

- Tools: `dispatch`, `job_status`, `cancel_job`, `usage`
- Resources: `harness-dispatch://status`, `harness-dispatch://status.json`

For most work, call `dispatch` with a `prompt`, the caller's `workingDir`, and an
appropriate `hints.taskType`: `execute`, `plan`, `review`, or `local`. A fast task
returns its full result inline (`completed: true`); a slow one returns
`completed: false` plus a `jobId` — check on it with `job_status` (partial output
while running, full result once done). Nothing is lost to a timeout.

For multiple perspectives, call `dispatch` with `mode: "fanout"` and optional
`models`. Call `job_status` with no `jobId` to see all background dispatches,
pass `graceSeconds: 0` on `dispatch` to skip the inline wait entirely, or a
top-level `service` to force a backend.

Use the status resource when route readiness, billing policy, safety, quota
state, or breaker state could affect delegation.
