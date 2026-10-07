# Harness Dispatch — Local Agent Instructions

For coding tasks in this project, use the harness-dispatch MCP server when it is
available. The public MCP surface is intentionally small:

- Tools: `dispatch`, `job_status`, `cancel_job`, `retry_job`, `workspace`, `usage`
- Resources: `harness-dispatch://status`, `harness-dispatch://status.json`
- Protocol: MCP 2026-07-28, and 2025-11-25 back to 2024-10-07 for clients that
  open with `initialize`; the same surface either way.

## Routing

Use `dispatch` for normal coding work:

```json
{
  "prompt": "<full task description>",
  "workingDir": "<absolute path to project>",
  "hints": {
    "taskType": "execute"
  }
}
```

A fast task returns its full result inline (`completed: true`). A slow one returns
`completed: false` plus a `jobId` — call `job_status` with that `jobId` to check on
it: `partialOutput` while running, the full `result` once done. Nothing is ever
lost to a timeout.

Use fanout mode when a plan, review, or architecture decision benefits from
multiple model perspectives. Name the routes in `models` (ids as `usage` lists
them); without it every eligible route runs and consumes quota:

```json
{
  "mode": "fanout",
  "prompt": "<task>",
  "workingDir": "<absolute path to project>",
  "models": ["<route id from usage>", "<route id from usage>"],
  "hints": {
    "taskType": "plan"
  }
}
```

Call `job_status` with no `jobId` to see all background dispatches. On `dispatch`,
pass `graceSeconds: 0` to skip the inline wait, or a top-level `service` to force a
specific backend (single mode only).

Read `harness-dispatch://status.json` before routing when route readiness,
billing policy, safety, quota state, or breaker state matters.
