# Harness Router — Local Agent Instructions

Use `harness-router` as a local router for coding work when it is configured.

Public MCP surface:

- Tools: `code`, `job`, `usage`
- Resources: `harness-router://status`, `harness-router://status.json`

For most work, call `code` with `mode: "single"` and an appropriate
`hints.taskType`: `execute`, `plan`, `review`, or `local`.

For multiple perspectives, call `code` with `mode: "fanout"` and optional
`models`.

Use `job` only when a slow route needs a bundle-backed async run that can be
inspected later.

Use the status resource when route readiness, billing policy, safety, quota
state, or breaker state could affect delegation.
