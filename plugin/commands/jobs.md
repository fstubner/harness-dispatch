---
name: jobs
description: List harness-dispatch background dispatches, or check/report one by job id
---

Inspect harness-dispatch delegation jobs: $ARGUMENTS

- With no arguments: call the `job_status` tool with no `jobId` and present a
  compact table (jobId, status, route/service, created, duration). Highlight
  any still-running or failed jobs.
- With a job id argument: call `job_status` with that `jobId`. If running, show
  `partialOutput` progress and when to check again; if completed or failed,
  present the result (and the bounded `error` plus a pointer to
  `output/stderr.log` in the job directory for full detail on failures).
- Also call the `usage` tool if the user seems to be asking about overall
  route health, quota, or which routes are ready.
