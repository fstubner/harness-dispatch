/**
 * Claude Code CLI dispatcher for harness-router.
 *
 * A thin, fixed-identity wrapper over GenericCliDispatcher defaulting to
 * CLAUDE_CODE_PROTOCOL (see builtin-protocols.ts) — the actual invocation
 * (flags, safety-profile mapping, output parsing) is declarative data, not
 * bespoke code, the same mechanism any `harness: generic` route uses. A
 * `protocol:` block under this route's own config (e.g.
 * `overrides.claude_code_cli.protocol`) overrides the default entirely —
 * this route is no more hardcoded than a user-added one, just shipped with
 * a working default so nothing has to be configured for it to work.
 *
 * Auth: no api_key/apiKeyEnvVar — Claude Code uses subscription auth
 * (Claude Desktop OAuth); the CLI picks up saved credentials on its own.
 */

import type { ServiceConfig } from "../types.js";
import { GenericCliDispatcher } from "./generic-cli.js";
import { CLAUDE_CODE_PROTOCOL } from "./builtin-protocols.js";

export class ClaudeCodeDispatcher extends GenericCliDispatcher {
  constructor(svc?: ServiceConfig) {
    super({
      ...(svc as ServiceConfig | undefined),
      name: "claude_code",
      command: svc?.command ?? "claude",
      protocol: svc?.protocol ?? CLAUDE_CODE_PROTOCOL,
    } as ServiceConfig);
  }
}
