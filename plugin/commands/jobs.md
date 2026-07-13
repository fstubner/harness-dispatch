---
name: jobs
description: List harness-router jobs, or check/report a specific job by id
---

Inspect harness-router delegation jobs: $ARGUMENTS

- With no arguments: call the `job` tool with `action=list` and present a
  compact table (jobId, status, route/service, created, duration). Highlight
  any still-running or failed jobs.
- With a job id argument: call `job action=get` for it. If running, show
  `partialOutput` progress and when to poll next; if completed or failed,
  present the result (and the bounded `error` plus a pointer to
  `output/stderr.log` in the job directory for full detail on failures).
- Also call the `usage` tool if the user seems to be asking about overall
  route health, quota, or which routes are ready.
