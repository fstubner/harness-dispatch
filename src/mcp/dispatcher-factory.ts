/**
 * Dispatcher factory — shared between the CLI (`bin.ts`) and the MCP server.
 *
 * Exactly two dispatcher classes exist: GenericCliDispatcher for every
 * `type: cli` route (built-in harness or user-added — see the shipped
 * config.default.yaml for how the 4 built-ins get their default behavior)
 * and OpenAICompatibleDispatcher for `type: openai_compatible`. `harness:`
 * no longer selects a dispatcher class — it only picks which CLI_DEFAULTS
 * entry a route inherits metadata/protocol from at config-load time (see
 * config.ts). Dispatch itself never branches on harness name.
 */

import { GenericCliDispatcher } from "../dispatchers/generic-cli.js";
import { OpenAICompatibleDispatcher } from "../dispatchers/openai-compatible.js";
import type { Dispatcher } from "../dispatchers/base.js";
import type { RouterConfig, ServiceConfig } from "../types.js";

/** Map of enabled service name -> dispatcher instance. */
export type DispatcherMap = Record<string, Dispatcher>;

/** Build one dispatcher from a service config. */
export function makeDispatcher(svc: ServiceConfig): Dispatcher {
  if (svc.type === "openai_compatible") return new OpenAICompatibleDispatcher(svc);
  return new GenericCliDispatcher(svc);
}

/** Build a dispatcher map for every enabled service in the config. */
export function buildDispatchers(config: RouterConfig): DispatcherMap {
  const out: DispatcherMap = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    out[name] = makeDispatcher(svc);
  }
  return out;
}
