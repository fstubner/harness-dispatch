#!/usr/bin/env python3
"""
harness-router SessionStart hook.

Installed by harness-router configure into ~/.claude/hooks.json.
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

ROUTING_CONTEXT = """
## Active: harness-router MCP

The harness-router MCP server is connected. For coding delegation, use the
single code tool with the right taskType:

  task_type=execute  → Codex/Cursor  (tests, patches, autonomous coding)
  task_type=plan     → Claude Opus   (architecture, design, reasoning)
  task_type=review   → Claude Opus   (code review, security, refactoring)

For multiple model perspectives: code(mode="fanout", prompt=..., hints={"taskType":"plan"})
Read harness-router://status.json to check route readiness, billing policy, safety,
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
