# Harness Dispatch — Local Agent Instructions

For coding tasks in this project, use the harness-dispatch MCP server when it is
available. The public MCP surface is intentionally small:

- Tools: `dispatch`, `job_status`, `cancel_job`, `retry_job`, `workspace`, `usage`
- Resources: `harness-dispatch://status`, `harness-dispatch://status.json`
- Protocol: MCP 2026-07-28 and the 2025-era revisions; the same surface either way
  ([revisions](docs/interfaces.md#protocol-revisions)).

## Routing

Use `dispatch` for normal coding work:

```json
{
  "prompt": "<full task description>",
  "workingDir": "<absolute path to project>",
  "hints": {
    "taskType": "execute",
    "modelTier": "standard"
  }
}
```

Pick `hints.modelTier` for the task: `cheap` for mechanical work, `standard` for
ordinary work, `strong` only for hard judgment. Each route runs its own model for the
tier, so leave `service` unset and the router can fall back when a route fails.

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
pass `graceSeconds: 0` to skip the inline wait. A top-level `service` forces one
backend with no fallback (single mode only); use it only when the task needs that exact
route, and pass `hints.model` (an exact model id) only together with it.

Read `harness-dispatch://status.json` before routing when route readiness,
billing policy, safety, quota state, or breaker state matters.

## Working on this repo

Build and test with `npm run build` and `npm run check`; the conventions, the claims
checker and the pull request rules are in [CONTRIBUTING.md](CONTRIBUTING.md). Do not
cut a release without reading [RELEASING.md](RELEASING.md): at most one a day, and
the GitHub release stays a draft.
