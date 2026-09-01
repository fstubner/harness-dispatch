/**
 * Rendering a live RouterConfig back into config.yaml.
 *
 * Split out of bin.ts. This is the half of `configure` that decides what a
 * user's file should say, and it is the half that has been dangerous: it once
 * wrote RESOLVED api keys into the output (including --print, the form people
 * paste into bug reports), and it once dropped top-level settings on a
 * round-trip so `configure --yes --force` destroyed them. Both fixes live
 * here, and both are easier to keep honest with the emission rules in one
 * file rather than interleaved with command plumbing.
 *
 * The governing rule: emit what the USER set, never what a default computed.
 * Billing fields are deliberately absent (they are recomputed from harness
 * defaults on every load, so writing them freezes a snapshot that silently
 * stops tracking); top-level settings are deliberately present (nothing
 * recomputes those, so a dropped one is simply gone).
 */

import yaml from "js-yaml";

import type { RouterConfig, ServiceConfig } from "./types.js";

/**
 * Common fields between clis: and endpoints: entries. Billing fields
 * (provider/surface/auth_source/billing_kind/paid_usage_possible/
 * billing_confidence/billing_notes) are deliberately NOT emitted — they're
 * computed from the harness/endpoint defaults every time the config loads
 * (see buildRouteBilling), so writing them out would freeze a snapshot that
 * silently stops tracking future default changes and looks like a deliberate
 * user override when it never was one. `allow_paid_usage` is the one real
 * opt-in flag here, so it's the only billing-adjacent field written.
 *
 * `safety_profile`/`effective_safety` are only emitted when the service
 * actually carries an explicit value — never a fallback default. Baking in
 * `requestedSafetyProfile()`'s "workspace_edit" fallback for every route used
 * to write `safety_profile: workspace_edit` on cursor_cli even though its
 * real effective_safety (the capability floor that actually governs it) is
 * full_auto, making the written file self-contradictory next to `status`.
 */
function commonEntryFields(svc: ServiceConfig): Record<string, unknown> {
  return {
    enabled: svc.enabled ? undefined : false,
    model: svc.model,
    tier: svc.tier,
    weight: svc.weight,
    cli_capability: svc.cliCapability,
    leaderboard_model: svc.leaderboardModel,
    thinking_level: svc.thinkingLevel,
    escalate_model: svc.escalateModel,
    escalate_on: svc.escalateOn.length > 0 ? svc.escalateOn : undefined,
    capabilities:
      Object.keys(svc.capabilities).length > 0 ? svc.capabilities : undefined,
    timeout_ms: svc.timeoutMs,
    max_output_tokens: svc.maxOutputTokens,
    max_input_tokens: svc.maxInputTokens,
    allow_paid_usage: svc.allowPaidUsage ? true : undefined,
    safety_profile: svc.safetyProfile,
    effective_safety: svc.effectiveSafety,
    endpoint_mode: svc.endpointMode,
    endpoint_provider: svc.endpointProvider,
    wire_protocol: svc.wireProtocol,
    workspace_policy: svc.workspacePolicy,
    models: svc.models && svc.models.length > 0 ? svc.models : undefined,
    model_hint: svc.modelHint,
  };
}

/**
 * Render a route's api_key WITHOUT materialising the secret.
 *
 * `svc.apiKey` is the RESOLVED value — config.ts interpolates `${VAR}` at
 * load time, so by here the reference is gone. Emitting it verbatim wrote
 * live credentials into config.yaml and echoed them to stdout on
 * `configure --print`, which is documented as the safe preview and is exactly
 * what someone pastes into a bug report. It also broke the project's own
 * stated invariant (plugin/commands/setup.md: "API keys MUST be written as
 * ${ENV_VAR} references — never literal").
 *
 * `config.envRefs` maps the resolved value back to the reference that
 * produced it, so a key that came from `${GROQ_API_KEY}` round-trips exactly.
 * `config.apiKeyRefs` covers the case envRefs structurally cannot — a
 * reference whose variable is unset, which resolves to "" and so has no
 * distinct value to key on.
 *
 * A key written as a LITERAL in the source file has no reference to restore.
 * That case splits by destination: `--yes` writes to disk, where the literal
 * already lives and dropping it would break a working config, so it is
 * preserved; `--print` goes to a terminal and a bug report, so it is redacted
 * to the placeholder below.
 */
function apiKeyForYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: { redactLiterals: boolean },
): string | undefined {
  // An UNSET ${VAR} resolves to "", so an empty apiKey is ambiguous: either
  // the route never had a key, or it had a reference whose variable was not
  // exported in this shell. config.apiKeyRefs, read before interpolation,
  // tells the two apart — without it, `configure --yes --force` on such a
  // shell silently rewrote a working config with the key deleted.
  if (svc.apiKey === undefined || svc.apiKey === "") return config.apiKeyRefs?.get(svc.name);
  const ref = config.envRefs?.get(svc.apiKey) ?? config.apiKeyRefs?.get(svc.name);
  if (ref !== undefined) return ref;
  if (!opts.redactLiterals) return svc.apiKey;
  // protocol.apiKeyEnvVar is the var the CHILD CLI reads, which is only a
  // suggestion for what to name the config reference — they need not match,
  // and endpoint routes have no protocol at all. Hence the generic fallback.
  const envVar = svc.protocol?.apiKeyEnvVar ?? "YOUR_API_KEY_ENV_VAR";
  return `\${${envVar}}`;
}

export interface YamlOpts {
  redactLiterals: boolean;
}

function cliEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  // `harness: generic` has NO shipped preset behind it, so anything omitted
  // here is not recoverable on reload — it is gone. Dropping `protocol:` was
  // fatal: config.ts refuses a generic entry without one ("requires a
  // protocol block — entry ignored"), so a round-trip deleted every
  // user-added harness, and `configure --yes --force` wrote that over their
  // file. This is the documented README#adding-a-harness path.
  //
  // Built-in harnesses keep the lean output: their preset supplies protocol
  // and billing, and emitting a copy would freeze a snapshot that stops
  // tracking future default changes — the same reasoning commonEntryFields
  // gives for omitting billing fields generally.
  const isGeneric = svc.harness === "generic";
  return {
    name: svc.name,
    harness: svc.harness,
    command: svc.command,
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc),
    ...(isGeneric
      ? {
          provider: svc.provider,
          surface: svc.surface,
          auth_source: svc.authSource,
          billing_kind: svc.billingKind,
          paid_usage_possible: svc.paidUsagePossible,
          billing_notes: svc.billingNotes,
          protocol: svc.protocol,
        }
      : {}),
  };
}

function endpointEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  return {
    name: svc.name,
    base_url: svc.baseUrl,
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc),
    // Endpoints have no shipped preset behind them, so an omitted billing
    // field is not recomputed on reload — it is lost. Verified: an endpoint
    // declaring `billing_kind: local_compute` and `paid_usage_possible: false`
    // came back undefined, flipping it to paid=possible and getting it skipped
    // by billing policy.
    //
    // This is the same reasoning already applied to `harness: generic` CLI
    // routes, and it should have been applied here at the same time. Built-in
    // harnesses still keep the lean output because their preset supplies these.
    provider: svc.provider,
    surface: svc.surface,
    auth_source: svc.authSource,
    billing_kind: svc.billingKind,
    paid_usage_possible: svc.paidUsagePossible,
    billing_notes: svc.billingNotes,
  };
}

/**
 * Top-level settings a user set and that have no defaults to track.
 *
 * These were silently dropped on every round-trip. Unlike the billing fields
 * (see commonEntryFields — omitted deliberately so they keep following harness
 * defaults), nothing recomputes these: a dropped `max_concurrent_runs` is
 * simply gone, and `configure --yes --force` wrote the result over the user's
 * file.
 */
function topLevelToYaml(config: RouterConfig, definesRoutes: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // FIRST, and unconditionally when the file stated it.
  //
  // `detect` is the only setting that isolates a machine from its installed
  // paid CLIs, and it was dropped on every round-trip because nothing carried
  // it. An acceptance pass measured `configure --yes --force` turning
  // `detect: false` into a config that routes to four real subscriptions,
  // printing "Wrote", with the safety warning suppressed because the emptied
  // document failed its own trigger condition. That is the same class as the
  // two failures this file's header already records in the past tense: a
  // regenerate that silently drops what it cannot represent.
  if (config.detect !== undefined) out.detect = config.detect;
  // `disabled:` only means something to AUTO-DETECTION, and a config that
  // lists its own routes is authoritative — a disabled route is simply absent
  // from that list, so carrying the name forward says nothing and actively
  // breaks the file: `doctor` warns that `disabled:` had no effect and exits
  // 1. An acceptance pass reproduced it end to end, so the setup path was
  // generating a config that fails the project's own health check.
  //
  // Kept when the config defines NO routes, because there it is still the
  // thing doing the work.
  if (!definesRoutes && config.disabled && config.disabled.length > 0) {
    out.disabled = [...config.disabled];
  }
  if (config.maxConcurrentRuns !== undefined) out.max_concurrent_runs = config.maxConcurrentRuns;
  if (config.retention?.jobsDays !== undefined) {
    out.retention = { jobs_days: config.retention.jobsDays };
  }
  if (config.telemetry?.enabled !== undefined) {
    out.telemetry = { enabled: config.telemetry.enabled };
  }
  if (config.leaderboard?.enabled !== undefined) {
    out.leaderboard = { enabled: config.leaderboard.enabled };
  }
  return out;
}

export function configToYaml(config: RouterConfig, opts: YamlOpts): string {
  const clis: Record<string, unknown>[] = [];
  const endpoints: Record<string, unknown>[] = [];
  for (const svc of Object.values(config.services)) {
    if (svc.type === "cli") clis.push(cliEntryToYaml(svc, config, opts));
    else endpoints.push(endpointEntryToYaml(svc, config, opts));
  }
  const definesRoutes = clis.length > 0 || endpoints.length > 0;
  const doc: Record<string, unknown> = { ...topLevelToYaml(config, definesRoutes) };
  if (clis.length > 0) doc.clis = clis;
  if (endpoints.length > 0) doc.endpoints = endpoints;
  return yaml.dump(doc, { noRefs: true, lineWidth: 100 });
}
