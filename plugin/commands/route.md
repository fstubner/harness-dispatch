---
name: route
description: Delegate a coding task to the best available harness via harness-dispatch
---

Delegate the following task through the harness-dispatch MCP server: $ARGUMENTS

Follow the `delegating-work` skill. Specifically:

1. Determine the correct `workingDir` (the current project root) and the
   right `hints.taskType` for this task (`execute`, `plan`, `review`, or
   `local`). Use `hints.safetyProfile: "read_only"` if the task is a review
   or plan.
2. Start it with the `dispatch` tool. A fast task returns its full result
   inline (`completed: true`) — skip to step 4. A slower one returns
   `completed: false` plus a `jobId`; report that `jobId` to the user
   immediately so they have the ticket.
3. Wait ~`nextPollSeconds` (do other useful work first if any is pending,
   otherwise sleep), then call `dispatch` again with just that `jobId`.
   While running, relay a one-line progress summary from `partialOutput`.
   Repeat until it completes or fails.
4. Present the final output, flag any `warning` or `skippedRoutes`, and
   critically review any code changes it made before declaring success.
