/**
 * Antigravity CLI dispatcher for harness-router.
 *
 * A thin, fixed-identity wrapper over GenericCliDispatcher parameterized by
 * ANTIGRAVITY_PROTOCOL (see builtin-protocols.ts) — the actual invocation is
 * declarative data, not bespoke code, the same mechanism any
 * `harness: generic` route uses.
 *
 * Antigravity is Google's successor to Gemini CLI. It keeps model and
 * permission settings in its own profile, so it deliberately does not reuse
 * Gemini's temporary ~/.gemini/settings.json thinking-level override.
 */

import type { ServiceConfig } from "../types.js";
import { GenericCliDispatcher } from "./generic-cli.js";
import { ANTIGRAVITY_PROTOCOL } from "./builtin-protocols.js";

export class AntigravityDispatcher extends GenericCliDispatcher {
  constructor(svc?: ServiceConfig) {
    super({
      ...(svc as ServiceConfig | undefined),
      name: "antigravity_cli",
      command: svc?.command ?? "agy",
      protocol: svc?.protocol ?? ANTIGRAVITY_PROTOCOL,
    } as ServiceConfig);
  }
}
