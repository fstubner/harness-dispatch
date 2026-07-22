# Harness Dispatch — Local Agent Instructions

For coding tasks in this project, use the harness-dispatch MCP server when it is
available. The public MCP surface is intentionally small:

- Tools: `dispatch`, `usage`
- Resources: `harness-dispatch://status`, `harness-dispatch://status.json`

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
`completed: false` plus a `jobId` — call `dispatch` again with just that `jobId` to
poll: `partialOutput` while running, the full `result` once done. Nothing is ever
lost to a timeout.

Use fanout mode when a plan, review, or architecture decision benefits from
multiple model perspectives:

```json
{
  "mode": "fanout",
  "prompt": "<task>",
  "hints": {
    "taskType": "plan"
  }
}
```

Pass `list: true` to see all background dispatches, `graceSeconds: 0` to skip the
inline wait, or a top-level `service` to force a specific backend (single mode only).

Read `harness-dispatch://status.json` before routing when route readiness,
billing policy, safety, quota state, or breaker state matters.
