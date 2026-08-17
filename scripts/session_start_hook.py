#!/usr/bin/env python3
"""
harness-dispatch SessionStart hook.

Installed by harness-dispatch configure into ~/.claude/hooks.json.
Runs at the start of every Claude Code session and prints routing
instructions so Claude knows to delegate coding tasks to the router.

Claude Code hook protocol:
  - stdin:  JSON event with session info
  - stdout: text printed as a system-level context injection
  - stderr: ignored (use for debug only)
  - exit 0: proceed normally
  - exit 2: block the session (do not use here)
"""

import json
import sys

# The routing table below uses U+2192 (→). On Windows, Python's stdout
# defaults to the locale codepage (cp1252), which cannot encode it, so the
# hook died with UnicodeEncodeError and every session silently lost its
# routing context. Force UTF-8 on stdout rather than downgrading the text.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROUTING_CONTEXT = """
## Active: harness-dispatch MCP

The harness-dispatch MCP server is connected. For coding delegation, use the
dispatch tool with the right taskType:

  task_type=execute  (tests, patches, autonomous coding)
  task_type=plan     (architecture, design, reasoning)
  task_type=review   (code review, security, refactoring)

Which route serves each is decided by config and live scoring, not by this
hook — naming harnesses here contradicted the router's own design (it
deliberately special-cases no harness by name, see billing.ts) and went stale
the moment a route was added, renamed or disabled.

A fast task returns its result inline (completed=true); a slow one returns a
jobId — call job_status with that jobId to check on it. Nothing is lost to a timeout.
For multiple model perspectives: dispatch(mode="fanout", prompt=..., hints={"taskType":"plan"})
Read harness-dispatch://status.json to check route readiness, billing policy, safety,
quota state, and breaker state before delegating when that matters.
""".strip()


def main():
    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        event = {}

    # Only inject on session start, not on every tool call
    hook_type = event.get("hook_type", "")
    if hook_type and hook_type != "SessionStart":
        sys.exit(0)

    print(ROUTING_CONTEXT)
    sys.exit(0)


if __name__ == "__main__":
    main()
