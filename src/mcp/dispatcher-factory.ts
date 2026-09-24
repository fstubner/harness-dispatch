/**
 * Dispatcher factory — shared between the CLI (`bin.ts`) and the MCP server.
 *
 * Exactly two dispatcher classes exist: GenericCliDispatcher for every
 * `type: cli` route (built-in harness or user-added — see the shipped
 * config.default.yaml for how the 4 built-ins get their default behavior)
 * and OpenAICompatibleDispatcher for `type: openai_compatible`. `harness:`
 * does not select a dispatcher class — it only picks which CLI_DEFAULTS entry
 * a route inherits metadata/protocol from at config-load time (see config.ts).
 * Dispatch itself never branches on harness name.
 */

import { GenericCliDispatcher } from "../dispatchers/generic-cli.js";
import { OpenAICompatibleDispatcher } from "../dispatchers/openai-compatible.js";
import type { Dispatcher } from "../dispatchers/base.js";
import { PROTOCOL_PRESETS } from "../harness-presets.js";
import type { RouterConfig, ServiceConfig } from "../types.js";

/**
 * Every api-key env var any route could use.
 *
 * streamSubprocess spawns with `{ ...process.env, ...opts.env }`, so clearing
 * only the route's own apiKeyEnvVar would hand a spawned CLI every other
 * provider's key. A CLI has no need for another provider's credentials, and an
 * agent CLI is precisely the kind of process that might do something with one.
 *
 * Unions the configured routes with the shipped presets: a route can be
 * disabled or absent from config while its variable is still sitting in the
 * parent environment, which is exactly the case worth clearing.
 */
export function collectApiKeyEnvVars(config: RouterConfig): ReadonlySet<string> {
  const vars = new Set<string>();
  for (const preset of Object.values(PROTOCOL_PRESETS)) {
    if (preset?.apiKeyEnvVar) vars.add(preset.apiKeyEnvVar);
  }
  for (const svc of Object.values(config.services)) {
    if (svc.protocol?.apiKeyEnvVar) vars.add(svc.protocol.apiKeyEnvVar);
  }
  // Endpoint routes have no protocol and so no apiKeyEnvVar — their key is
  // sent as an HTTP header, sourced from a ${VAR} in config.yaml. envRefs
  // (recorded during interpolation) is the only place that mapping survives.
  //
  // EVERY reference in the string, not a whole-string match: `${VAR}` is
  // supported anywhere in a value (`base_url: https://${HOST}/v1` is a
  // documented shape) and `envRefs` stores the original string as its key, so
  // an anchored match would miss a key embedded in a larger string and leave it
  // visible to every spawned CLI.
  const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const ref of config.envRefs?.values() ?? []) {
    for (const match of ref.matchAll(REF_RE)) {
      const name = match[1];
      if (name) vars.add(name);
    }
  }
  return vars;
}

/** Map of enabled service name -> dispatcher instance. */
export type DispatcherMap = Record<string, Dispatcher>;

/** Build one dispatcher from a service config. */
export function makeDispatcher(
  svc: ServiceConfig,
  siblingApiKeyEnvVars?: ReadonlySet<string>,
): Dispatcher {
  if (svc.type === "openai_compatible") return new OpenAICompatibleDispatcher(svc);
  return new GenericCliDispatcher(svc, siblingApiKeyEnvVars);
}

/** Build a dispatcher map for every enabled service in the config. */
export function buildDispatchers(config: RouterConfig): DispatcherMap {
  const out: DispatcherMap = {};
  const apiKeyEnvVars = collectApiKeyEnvVars(config);
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    out[name] = makeDispatcher(svc, apiKeyEnvVars);
  }
  return out;
}
