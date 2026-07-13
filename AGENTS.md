# Harness Router — Local Agent Instructions

For coding tasks in this project, use the harness-router MCP server when it is
available. The public MCP surface is intentionally small:

- Tools: `code`, `job`
- Resources: `harness-router://status`, `harness-router://status.json`

## Routing

Use `code` in single mode for normal coding work:

```json
{
  "mode": "single",
  "prompt": "<full task description>",
  "workingDir": "<absolute path to project>",
  "hints": {
    "taskType": "execute"
  }
}
```

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

Use `job` only when a slow route needs a bundle-backed async run that can be
inspected later.

Read `harness-router://status.json` before routing when route readiness,
billing policy, safety, quota state, or breaker state matters.
