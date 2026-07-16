/**
 * Cursor headless CLI dispatcher for harness-router.
 *
 * A thin, fixed-identity wrapper over GenericCliDispatcher parameterized by
 * CURSOR_PROTOCOL (see builtin-protocols.ts) — the actual invocation is
 * declarative data, not bespoke code, the same mechanism any
 * `harness: generic` route uses.
 *
 * One thing that stays a per-instance override rather than static protocol
 * data: cursor-agent needs SOME `--workspace` value even when the caller
 * passes an empty workingDir (it has no "just use the current directory"
 * fallback the way Claude Code/Antigravity do) — matching the Python
 * reference, this defaults to the user's home directory.
 *
 * Narrowed from the original hand-written dispatcher: that version probed
 * both `cursor-agent` (preferred) and the legacy `agent` command, using
 * whichever was found. GenericCliDispatcher resolves one fixed `command` at
 * construction time, so that fallback probe doesn't carry over — if you're
 * on an old Cursor install that only has `agent`, set `command: agent`
 * explicitly in this route's config.
 */

import os from "node:os";
import type { DispatcherEvent, ServiceConfig } from "../types.js";
import type { DispatchOpts } from "./base.js";
import { GenericCliDispatcher } from "./generic-cli.js";
import { CURSOR_PROTOCOL } from "./builtin-protocols.js";

export class CursorDispatcher extends GenericCliDispatcher {
  constructor(svc?: ServiceConfig) {
    super({
      ...(svc as ServiceConfig | undefined),
      name: "cursor",
      command: svc?.command ?? "cursor-agent",
      protocol: svc?.protocol ?? CURSOR_PROTOCOL,
    } as ServiceConfig);
  }

  override stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<DispatcherEvent> {
    return super.stream(prompt, files, workingDir || os.homedir(), opts);
  }
}
