/**
 * OpenAI Codex CLI dispatcher for harness-router.
 *
 * A thin, fixed-identity wrapper over GenericCliDispatcher parameterized by
 * CODEX_PROTOCOL (see builtin-protocols.ts), including Codex's real
 * tool_use/thinking/usage streaming-event semantics via CliEventRule — the
 * actual invocation is declarative data, not bespoke code, the same
 * mechanism any `harness: generic` route uses.
 *
 * One thing that stays genuinely per-instance rather than static protocol
 * data: `--oss --local-provider <provider>` only applies when this specific
 * route is configured for `endpoint_mode: harness_native_endpoint` against
 * ollama/lmstudio — that's config-dependent, not a fixed property of "being
 * Codex", so it's computed once here and folded into the protocol's
 * extraArgs at construction time.
 */

import type { CliProtocolConfig, ServiceConfig } from "../types.js";
import { GenericCliDispatcher } from "./generic-cli.js";
import { CODEX_PROTOCOL } from "./builtin-protocols.js";

function endpointArgs(svc: ServiceConfig | undefined): string[] {
  if (svc?.endpointMode !== "harness_native_endpoint") return [];
  if (svc.endpointProvider === "ollama" || svc.endpointProvider === "lmstudio") {
    return ["--oss", "--local-provider", svc.endpointProvider];
  }
  return [];
}

export class CodexDispatcher extends GenericCliDispatcher {
  constructor(svc?: ServiceConfig) {
    const base = svc?.protocol ?? CODEX_PROTOCOL;
    const extra = endpointArgs(svc);
    const protocol: CliProtocolConfig =
      extra.length > 0 ? { ...base, extraArgs: [...extra, ...(base.extraArgs ?? [])] } : base;
    super({
      ...(svc as ServiceConfig | undefined),
      name: "codex",
      command: svc?.command ?? "codex",
      protocol,
    } as ServiceConfig);
  }
}
