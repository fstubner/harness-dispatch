---
name: route
description: Delegate a coding task to the best available harness via harness-router (async job with polling)
---

Delegate the following task through the harness-router MCP server: $ARGUMENTS

Follow the `delegating-work` skill. Specifically:

1. Determine the correct `workingDir` (the current project root) and the
   right `hints.taskType` for this task (`execute`, `plan`, `review`, or
   `local`). Use `hints.safetyProfile: "read_only"` if the task is a review
   or plan.
2. Start it with the `job` tool (`action=start`). Report the returned
   `jobId` to the user immediately so they have the ticket.
3. Wait ~`nextPollSeconds` (do other useful work first if any is pending,
   otherwise sleep), then poll with `job action=get`. While running, relay a
   one-line progress summary from `partialOutput`. Repeat until the job
   completes or fails.
4. Present the final output, flag any `warning` or `skippedRoutes`, and
   critically review any code changes it made before declaring success.

If the task is trivially small (under ~1 minute), you may use the `code`
tool synchronously instead, with the same required arguments.
