/**
 * Configuration loading for harness-dispatch.
 *
 * Two entry points:
 *   loadConfig(path?)   — if no path, auto-detects installed CLIs on PATH.
 *                         If path points to a legacy YAML with a `services:`
 *                         key, returns it verbatim. Otherwise merges minimal
 *                         overrides onto auto-detected defaults.
 *   watchConfig(path)   — poll the file's mtime once a second and reload on
 *                         change. Returns {stop} to cancel the poller.
 *
 * All string values are scanned for ${ENV_VAR} references and replaced with
 * the corresponding environment variable.
 */

import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import which from "which";

import {
  normalizeSafetyProfile,
} from "./safety.js";
import { inferredPaidUsagePossible } from "./billing.js";
import {
  authSourceFrom, billingKindFrom, bool, confidenceFrom, endpointModeFrom,
  endpointProviderFrom, inferEndpointProvider, int, num, providerFrom, str,
  surfaceFrom, thinkingFrom, wireProtocolFrom, workspacePolicyFrom,
} from "./config/coercions.js";
import {
  warnUnknownRouteKeys,
  warnUnknownSafetyEnums,
  warnUnknownTopLevelKeys,
} from "./config/validation.js";
import { parseProtocolFields, protocolFrom, stringArrayFrom } from "./config/protocol.js";
import {
  effectiveSafetyFrom,
  resolveSharedRouteFields,
} from "./config/route-fields.js";
import { ENV_VAR_RE, interpolateTree } from "./config/env-interpolation.js";

/** Injection seam for tests. Set via loadConfig({ whichFn }) if needed. */
export type WhichFn = (cmd: string) => Promise<string | null>;

/**
 * PATH lookups, memoised for the life of the process.
 *
 * loadConfig() runs on every CLI invocation and on every config reload, and
 * each lookup is a real filesystem walk — ~2-3s per harness on Windows. A CLI
 * that resolves once will resolve the same way a second later, and a
 * long-running server re-reads config on hot reload where re-probing bought
 * nothing.
 *
 * Deliberately NOT persisted across processes: installing a harness should
 * take effect on the next command, not after a cache expiry someone has to
 * discover.
 */
const whichCache = new Map<string, Promise<string | null>>();

const defaultWhich: WhichFn = async (cmd: string): Promise<string | null> => {
  const cached = whichCache.get(cmd);
  if (cached !== undefined) return cached;
  const lookup = (async (): Promise<string | null> => {
    try {
      const r = await which(cmd, { nothrow: true });
      return r ?? null;
    } catch {
      return null;
    }
  })();
  whichCache.set(cmd, lookup);
  return lookup;
};
import type {
  AuthSource,
  BillingConfidence,
  BillingKind,
  BillingProvider,
  BillingSurface,
  CliEventRule,
  CliProtocolConfig,
  EndpointMode,
  EndpointProvider,
  RouterConfig,
  SafetyProfile,
  ServiceConfig,
  TaskType,
  ThinkingLevel,
  WireProtocol,
  WorkspacePolicy,
} from "./types.js";

// ---------------------------------------------------------------------------
// Built-in harness defaults — loaded from the package's own bundled
// config.default.yaml's `clis:` list, NOT hardcoded here. Claude Code,
// Codex, Cursor, and Antigravity are not special-cased in this file; they're
// just the entries the shipped config happens to define, keyed by each
// entry's `harness:` value. See resolveShippedConfigPath()/
// loadDefaultHarnesses() below, near the bottom of this file (defined after
// the field parsers they reuse — str/num/capsFrom/parseProtocolFields/etc. —
// but referenced here via a hoisted function call, so definition order
// doesn't matter to JS).
// ---------------------------------------------------------------------------

const SAFETY_PROFILES: readonly SafetyProfile[] = ["read_only", "workspace_edit", "full_auto"];


// NOTE: everything the module-load-time `CLI_DEFAULTS = loadDefaultHarnesses()`
// call below touches must be declared ABOVE it (or be a hoisted function) —
// a `const` declared later in the file hits the temporal dead zone at load.

interface CliDefaults {
  command: string;
  harness: string;
  leaderboardModel: string;
  cliCapability: number;
  tier: number;
  thinkingLevel?: "low" | "medium" | "high";
  capabilities: { execute: number; plan: number; review: number };
  maxOutputTokens?: number;
  maxInputTokens?: number;
  provider: BillingProvider;
  surface: BillingSurface;
  authSource: AuthSource;
  billingKind?: BillingKind;
  paidUsagePossible?: boolean;
  /** Safety level this harness actually runs at (capability floor) — see ServiceConfig.effectiveSafety. */
  effectiveSafety?: SafetyProfile | Partial<Record<SafetyProfile, SafetyProfile>>;
  /** Operator-declared known-good model ids — see ServiceConfig.models. */
  models?: string[];
  /** Where this harness's real model catalog lives — see ServiceConfig.modelHint. */
  modelHint?: string;
  /** Default dispatch protocol for this harness — see the shipped config.default.yaml. */
  protocol?: CliProtocolConfig;
}

/**
 * `harness: generic` is not a harness definition — it's the escape hatch a
 * user's own entry selects when adding a wholly new CLI, so its "defaults"
 * are parser fallbacks, not example config. Billing is unknown/blocked until
 * the operator classifies it, since there's no way to know an arbitrary
 * CLI's real billing model. Command is empty so it can never be
 * auto-detected; the user's entry must supply command + protocol.
 */
const GENERIC_DEFAULTS: CliDefaults = {
  command: "",
  harness: "generic",
  leaderboardModel: "",
  cliCapability: 1.0,
  tier: 3,
  capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
  provider: "custom",
  surface: "custom",
  authSource: "unknown",
  billingKind: "unknown",
  paidUsagePossible: true,
};

const CLI_DEFAULTS: Record<string, CliDefaults> = loadDefaultHarnesses();

/** Named, selectable protocols — every harness in CLI_DEFAULTS that defines one, keyed by its harness name (see protocolFrom()'s string/`extends:` handling). */
export const PROTOCOL_PRESETS: Record<string, CliProtocolConfig> = Object.fromEntries(
  Object.entries(CLI_DEFAULTS)
    .filter((entry): entry is [string, CliDefaults & { protocol: CliProtocolConfig }] => entry[1].protocol !== undefined)
    .map(([name, defaults]) => [name, defaults.protocol]),
);

// Default route id auto-detect assigns for each harness — distinct from the
// CLI_DEFAULTS key above, which is the harness *type* (selects the
// dispatcher class via dispatcher-factory.ts's HARNESS_TABLE, and is read by
// billing.ts/safety.ts/router.ts) and must not change. This mapping only
// controls what shows up as the service/route name, so it can follow the
// same `*_cli` convention `endpoints:` uses for `*_api` (e.g. gemini_api).
/**
 * Commands auto-detect probes on PATH, exported so `doctor` can name them.
 *
 * A zero-route install used to report "0 ready route(s)" and stop, which tells
 * a new user nothing about what was looked for or what to install. Keyed the
 * same way as AUTO_DETECT_NAME so the two cannot drift.
 */
export const AUTO_DETECT_COMMANDS: Record<string, string> = {
  claude_code_cli: "claude",
  codex_cli: "codex",
  cursor_cli: "cursor-agent",
  antigravity_cli: "agy",
};

const AUTO_DETECT_NAME: Record<string, string> = {
  claude_code: "claude_code_cli",
  codex: "codex_cli",
  cursor: "cursor_cli",
  antigravity_cli: "antigravity_cli",
};

// ---------------------------------------------------------------------------
// Env var interpolation (${VAR_NAME})
// ---------------------------------------------------------------------------









function endpointFields(
  raw: Record<string, unknown>,
  type: ServiceConfig["type"],
  baseUrl: string | undefined,
): Partial<ServiceConfig> {
  const endpointMode =
    endpointModeFrom(raw.endpoint_mode) ??
    (type === "openai_compatible" ? "direct_openai_compatible" : undefined);
  const endpointProvider =
    endpointProviderFrom(raw.endpoint_provider) ??
    (type === "openai_compatible" ? inferEndpointProvider(baseUrl) : undefined);
  const wireProtocol =
    wireProtocolFrom(raw.wire_protocol) ??
    (endpointMode === "direct_openai_compatible" ||
    endpointMode === "harness_native_endpoint"
      ? "openai_chat_completions"
      : undefined);
  const out: Partial<ServiceConfig> = {};
  if (endpointMode !== undefined) out.endpointMode = endpointMode;
  if (endpointProvider !== undefined) out.endpointProvider = endpointProvider;
  if (wireProtocol !== undefined) out.wireProtocol = wireProtocol;
  return out;
}

/**
 * Top-level config blocks shared by every format: `telemetry:` and
 * `retention:`. Parsed once here so legacy `services:` configs and modern
 * `clis:`/`endpoints:` configs behave identically.
 */
function topLevelSettings(
  raw: Record<string, unknown>,
  policyWarnings: string[] = [],
): Partial<RouterConfig> {
  const out: Partial<RouterConfig> = {};
  const telemetryRaw = raw.telemetry;
  if (telemetryRaw !== null && typeof telemetryRaw === "object") {
    const enabled = (telemetryRaw as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") out.telemetry = { enabled };
  }
  const retentionRaw = raw.retention;
  if (retentionRaw !== null && typeof retentionRaw === "object") {
    const days = num((retentionRaw as Record<string, unknown>).jobs_days, Number.NaN);
    if (Number.isFinite(days) && days >= 0) out.retention = { jobsDays: days };
  }
  const leaderboardRaw = raw.leaderboard;
  if (leaderboardRaw !== null && typeof leaderboardRaw === "object") {
    const enabled = (leaderboardRaw as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") out.leaderboard = { enabled };
  }
  const maxRuns = num(raw.max_concurrent_runs, Number.NaN);
  if (Number.isFinite(maxRuns) && maxRuns >= 0) out.maxConcurrentRuns = Math.floor(maxRuns);
  else if (raw.max_concurrent_runs !== undefined) {
    // Present but unusable. Silently falling back to the default meant a
    // caller who set a concurrency bound got a different one and was never
    // told — and this value governs how many agent CLIs run at once.
    policyWarnings.push(
      `max_concurrent_runs: ${JSON.stringify(raw.max_concurrent_runs)} is not a ` +
        `non-negative number — IGNORED, the default applies instead.`,
    );
  }
  return out;
}







/**
 * `effective_safety` as either one profile or a per-request map.
 *
 * An unrecognised value is dropped rather than guessed at, and an unrecognised
 * KEY or value inside the map is dropped individually — a typo must not
 * silently widen the floor for a request it was meant to restrict.
 */
/**
 * Billing IDENTITY for a route — the part that genuinely differs per shape.
 *
 * Everything that means the same thing everywhere (safety_profile,
 * effective_safety, workspace_policy, billing_notes, models, …) now comes from
 * resolveSharedRouteFields instead. What is left here is the set the caller
 * has already inferred per shape: endpoints derive provider/surface/kind from
 * the base URL, CLI routes derive them from whether an api_key is present.
 * This function only reads what it is handed.
 */
function billingFields(raw: Record<string, unknown>): Partial<ServiceConfig> {
  const out: Partial<ServiceConfig> = {};
  const provider = providerFrom(raw.provider);
  const surface = surfaceFrom(raw.surface);
  const authSource = authSourceFrom(raw.auth_source);
  const billingKind = billingKindFrom(raw.billing_kind);
  if (provider !== undefined) out.provider = provider;
  if (surface !== undefined) out.surface = surface;
  if (authSource !== undefined) out.authSource = authSource;
  if (billingKind !== undefined) out.billingKind = billingKind;
  if (typeof raw.paid_usage_possible === "boolean") {
    out.paidUsagePossible = raw.paid_usage_possible;
  }
  return out;
}

function capsFrom(raw: unknown): { execute: number; plan: number; review: number } {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    execute: num(r.execute, 1.0),
    plan: num(r.plan, 1.0),
    review: num(r.review, 1.0),
  };
}

function escalateOnFrom(raw: unknown): TaskType[] {
  if (!Array.isArray(raw)) return ["plan", "review"];
  const out: TaskType[] = [];
  for (const v of raw) {
    if (v === "execute" || v === "plan" || v === "review" || v === "local") {
      out.push(v);
    }
  }
  return out.length > 0 ? out : ["plan", "review"];
}





// ---------------------------------------------------------------------------
// Legacy full-format parser (YAML with top-level `services:` key)
// ---------------------------------------------------------------------------

function buildLegacyConfig(raw: Record<string, unknown>): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const rawServices = (raw.services ?? {}) as Record<string, Record<string, unknown>>;
  const warnings: string[] = [];

  // `services:` must be a MAP of route id -> settings, but `typeof [] ===
  // "object"`, so a list slips through and Object.entries turns it into routes
  // called "0", "1", … with each item's `name:` silently ignored. Everything
  // then looks healthy — doctor reports the routes, status lists them — right
  // up until `--service my_route` answers "Unknown service".
  //
  // The mistake is a natural one rather than carelessness: the sibling
  // top-level keys `clis:` and `endpoints:` ARE lists, and their items DO
  // carry `name:`. Found by an acceptance pass; it predates the work that pass
  // was reviewing.
  if (Array.isArray(raw.services)) {
    const intended = (raw.services as unknown[])
      .map((e) => (e !== null && typeof e === "object" ? (e as Record<string, unknown>).name : undefined))
      .filter((n): n is string => typeof n === "string" && n !== "");
    const got = Object.keys(rawServices);
    warnings.push(
      `services: is a LIST, but it must be a map of route id to settings. Its ` +
        `${got.length} entr${got.length === 1 ? "y" : "ies"} became route id${got.length === 1 ? "" : "s"} ` +
        `${got.join(", ")}` +
        (intended.length > 0
          ? `, and each item's name: (${intended.join(", ")}) was ignored — so anything ` +
            `referring to a route by name will not find it`
          : "") +
        `. Write it as \`services:\` then \`  <id>:\` per route (unlike clis: and ` +
        `endpoints:, which ARE lists).`,
    );
  }

  // A top-level `services:` key selects the legacy parser entirely — it
  // never looks at clis:/endpoints:/overrides:, so any of those sitting
  // alongside it are silently dropped unless we say so here. The likely
  // real-world case is a config written by an old `configure` (which used
  // to emit `services:`; it writes clis:/endpoints: now) with modern keys
  // later pasted in from the README or shipped config.
  const ignoredModernKeys = (["clis", "endpoints", "overrides"] as const).filter(
    (key) => raw[key] !== undefined,
  );
  if (ignoredModernKeys.length > 0) {
    warnings.push(
      `top-level "services:" is present, which selects the legacy config format and ` +
        `IGNORES ${ignoredModernKeys.map((k) => `"${k}:"`).join(", ")} entirely — move ` +
        `those entries into "services:" entries, or remove "services:" and use ` +
        `clis:/endpoints:/overrides: exclusively (see the shipped config.default.yaml).`,
    );
  }

  for (const [name, svc] of Object.entries(rawServices)) {
    const type = (str(svc.type) ?? "cli") as ServiceConfig["type"];
    // Computed once and reused below for both max-tokens fallback and the
    // billing/safety/model-hint inheritance IIFE — legacy-format entries
    // inherit the named harness's declared metadata (from the shipped
    // config) exactly like clis: entries do, so `harness: cursor` here
    // classifies correctly without repeating every field. Explicit fields
    // on the entry itself always win.
    const harnessDefaults = CLI_DEFAULTS[str(svc.harness) ?? ""];
    const svcConfig: ServiceConfig = {
      name,
      enabled: bool(svc.enabled, true),
      type,
      ...(str(svc.harness) !== undefined ? { harness: str(svc.harness)! } : {}),
      command: str(svc.command) ?? name,
      ...(str(svc.api_key) !== undefined ? { apiKey: str(svc.api_key)! } : {}),
      ...(str(svc.base_url) !== undefined ? { baseUrl: str(svc.base_url)! } : {}),
      ...(str(svc.model) !== undefined ? { model: str(svc.model)! } : {}),
      tier: int(svc.tier, 1),
      weight: num(svc.weight, 1.0),
      cliCapability: num(svc.cli_capability, 1.0),
      escalateOn: escalateOnFrom(svc.escalate_on),
      capabilities: capsFrom(svc.capabilities),
      ...(() => {
        // Billing IDENTITY only — the rest of the named harness's defaults
        // reach this entry through resolveSharedRouteFields below.
        if (!harnessDefaults) return {};
        return {
          provider: harnessDefaults.provider,
          surface: harnessDefaults.surface,
          authSource: harnessDefaults.authSource,
          ...(harnessDefaults.billingKind !== undefined
            ? { billingKind: harnessDefaults.billingKind }
            : {}),
          ...(harnessDefaults.paidUsagePossible !== undefined
            ? { paidUsagePossible: harnessDefaults.paidUsagePossible }
            : {}),
        };
      })(),
      ...billingFields(svc),
      // The same table the `clis:` and `endpoints:` builders use. This shape
      // previously read the shared keys through billingFields() plus four
      // hand-written blocks, which is how it ended up with a DIFFERENT set
      // again: it inherited maxInput/OutputTokens, effectiveSafety, models and
      // modelHint from the named harness but not leaderboardModel or
      // thinkingLevel, so `services: { x: { harness: antigravity_cli } }`
      // silently lost its scoring key and its thinking level. Passing the
      // defaults through one table fixes that too.
      ...resolveSharedRouteFields(svc, harnessDefaults),
      ...endpointFields(svc, type, str(svc.base_url)),
      ...(() => {
        // Falls back to the named harness's built-in default protocol (if
        // any) when this legacy-format entry doesn't declare its own —
        // same behavior as clis: entries, so `harness: claude_code` here
        // works without repeating the whole protocol block.
        const harnessDefaults = CLI_DEFAULTS[str(svc.harness) ?? ""];
        const protocol =
          protocolFrom(svc.protocol, `services "${name}"`, warnings, PROTOCOL_PRESETS) ?? harnessDefaults?.protocol;
        return protocol !== undefined ? { protocol } : {};
      })(),
    };
    services[name] = svcConfig;
  }

  const cfg: RouterConfig = {
    services,
    ...(Array.isArray(raw.disabled)
      ? { disabled: (raw.disabled as string[]).slice() }
      : {}),
    ...topLevelSettings(raw, warnings),
    ...(warnings.length > 0 ? { configWarnings: warnings } : {}),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Auto-detect loader
// ---------------------------------------------------------------------------

interface ApiKeys {
  [service: string]: string;
}

/**
 * Build a CLI ServiceConfig from a harness's built-in defaults plus a raw
 * override object. Shared by auto-detect (`overrides:` keyed by route id)
 * and explicit `clis:` entries (each entry IS the override, plus `name` and
 * `harness` picking which defaults to start from).
 */
function buildCliServiceConfig(
  name: string,
  defaults: CliDefaults,
  override: Record<string, unknown>,
  apiKeys: ApiKeys,
  warnings: string[] = [],
): ServiceConfig {
  override = { ...override };
  // Capabilities merge-over-defaults.
  const caps = { ...defaults.capabilities };
  if (override.capabilities && typeof override.capabilities === "object") {
    const oc = override.capabilities as Record<string, unknown>;
    if (oc.execute !== undefined) caps.execute = num(oc.execute, caps.execute);
    if (oc.plan !== undefined) caps.plan = num(oc.plan, caps.plan);
    if (oc.review !== undefined) caps.review = num(oc.review, caps.review);
    delete override.capabilities;
  }

  const apiKey = str(override.api_key) ?? (apiKeys[name] ? apiKeys[name] : undefined);

  return {
    name,
    enabled: bool(override.enabled, true),
    type: "cli",
    harness: str(override.harness) ?? defaults.harness,
    command: str(override.command) ?? defaults.command,
    ...(apiKey ? { apiKey } : {}),
    ...(str(override.model) !== undefined ? { model: str(override.model)! } : {}),
    ...(str(override.base_url) !== undefined ? { baseUrl: str(override.base_url)! } : {}),
    weight: num(override.weight, 1.0),
    tier: int(override.tier, defaults.tier),
    cliCapability: num(override.cli_capability, defaults.cliCapability),
    escalateOn: escalateOnFrom(override.escalate_on),
    capabilities: caps,
    // Every field that means the same thing on every route shape, resolved
    // from ONE table against this harness's shipped defaults. Spread early so
    // the shape-specific resolutions below (billing identity, which depends on
    // whether an api_key is present) still win.
    ...resolveSharedRouteFields(override, defaults),
    provider: providerFrom(override.provider) ?? defaults.provider,
    surface: surfaceFrom(override.surface) ?? defaults.surface,
    authSource: authSourceFrom(override.auth_source) ?? (apiKey ? "api_key" : defaults.authSource),
    ...(() => {
      const billingKind =
        billingKindFrom(override.billing_kind) ?? (apiKey ? "metered_api" : defaults.billingKind);
      return billingKind !== undefined ? { billingKind } : {};
    })(),
    ...(() => {
      // A DECLARED billing_kind beats the harness default.
      //
      // `harness: generic` defaults paidUsagePossible to true (correctly — an
      // unknown command might cost money). But a route declaring
      // `billing_kind: local_compute` has said it cannot, and the default
      // still won: status showed `billing=local_compute paid=possible`, two
      // fields of the same record contradicting each other, and the route was
      // skipped by billing policy. Nothing about a declared non-paid kind
      // should leave the paid flag set by a fallback.
      //
      // An explicit paid_usage_possible still wins over both, and an api_key
      // still forces true — a key means a metered account exists regardless of
      // what the kind claims.
      const declaredKind = billingKindFrom(override.billing_kind);
      const paidUsagePossible =
        typeof override.paid_usage_possible === "boolean"
          ? override.paid_usage_possible
          : apiKey
            ? true
            : declaredKind !== undefined
              ? inferredPaidUsagePossible(declaredKind)
              : defaults.paidUsagePossible;
      return paidUsagePossible !== undefined ? { paidUsagePossible } : {};
    })(),
    ...endpointFields(override, "cli", str(override.base_url)),
    ...(() => {
      // Falls back to this harness's built-in default (if any) when no
      // override is given, or when the override is malformed — protocolFrom
      // already warned in the latter case; failing the whole route over a
      // typo'd override would be worse than keeping the known-good default.
      const protocol = protocolFrom(override.protocol, `clis "${name}"`, warnings, PROTOCOL_PRESETS) ?? defaults.protocol;
      return protocol !== undefined ? { protocol } : {};
    })(),
  };
}

async function detectServices(
  disabled: string[],
  apiKeys: ApiKeys,
  overrides: Record<string, Record<string, unknown>>,
  whichFn: WhichFn,
): Promise<Record<string, ServiceConfig>> {
  const services: Record<string, ServiceConfig> = {};
  const disabledSet = new Set(disabled);

  // Probe every harness AT ONCE.
  //
  // This was a sequential await per harness. Each `which` costs real time on
  // Windows — measured 2.8s / 3.3s / 2.7s / 2.1s for claude / codex /
  // cursor-agent / agy on a machine where all four are installed, so ~11s per
  // loadConfig() call, and loadConfig runs on every CLI invocation. `status`
  // and `doctor` took ~17s, and the test suite went red with timeouts on any
  // developer machine that actually has the harnesses installed — it passed in
  // CI only because CI is bare. The probes are independent, so there was never
  // a reason to serialise them.
  const candidates = Object.entries(CLI_DEFAULTS)
    // "generic" has no installable binary of its own — it exists only for
    // explicit clis: entries (addClis), never auto-detection.
    .filter(([harness]) => harness !== "generic")
    .map(([harness, defaults]) => ({
      harness,
      defaults,
      name: AUTO_DETECT_NAME[harness] ?? harness,
    }))
    .filter(({ name }) => !disabledSet.has(name));

  const found = await Promise.all(
    candidates.map(async (c) => ((await whichFn(c.defaults.command)) ? c : undefined)),
  );

  for (const c of found) {
    if (!c) continue;
    const override = overrides[c.name] ?? {};
    services[c.name] = buildCliServiceConfig(c.name, c.defaults, override, apiKeys);
  }
  return services;
}

/**
 * Explicit `clis:` entries — same shape as `endpoints:` but for CLI
 * harnesses: arbitrary `name`, required `harness` picks which built-in
 * defaults to start from (claude_code | codex | cursor | antigravity_cli).
 * Not gated on `which()` — declared explicitly, so it's added to the map
 * unconditionally and its dispatcher's own isAvailable() reports whether the
 * binary is actually on PATH (surfaced in status/doctor either way, instead
 * of silently vanishing like undetected auto-detect entries do).
 */
function addClis(
  services: Record<string, ServiceConfig>,
  raw: Record<string, unknown>,
  apiKeys: ApiKeys,
  warnings: string[],
): void {
  const clis = Array.isArray(raw.clis) ? (raw.clis as Record<string, unknown>[]) : [];
  for (const [index, entry] of clis.entries()) {
    const name = str(entry.name);
    const harness = str(entry.harness);
    if (!name || !harness) {
      warnings.push(
        `clis[${index}]: missing required "name" and/or "harness" — entry ignored.`,
      );
      continue;
    }
    warnUnknownRouteKeys(entry, `clis[${index}] "${name}"`, warnings);
    const defaults = CLI_DEFAULTS[harness];
    if (!defaults) {
      warnings.push(
        `clis[${index}] "${name}": unrecognized harness "${harness}" (expected one of: ` +
          `${Object.keys(CLI_DEFAULTS).join(", ")}) — entry ignored.`,
      );
      continue;
    }
    if (harness === "generic") {
      if (!str(entry.command)) {
        warnings.push(
          `clis[${index}] "${name}": harness: generic requires an explicit "command" — entry ignored.`,
        );
        continue;
      }
      if (entry.protocol === undefined || entry.protocol === null) {
        warnings.push(
          `clis[${index}] "${name}": harness: generic requires a "protocol" block — entry ignored. ` +
            "See README.md#adding-a-harness.",
        );
        continue;
      }
      // Validate now so a malformed protocol block skips the whole entry,
      // instead of silently landing a route with no `.protocol` at all.
      // Warnings from THIS pass go to a throwaway array, not `warnings` —
      // buildCliServiceConfig below parses the same entry.protocol again
      // (it has to: it's shared with detectServices' overrides path, which
      // has no prior validation pass) and would otherwise double every
      // warning under two different labels. On failure we still surface it
      // once, from here, since the entry gets skipped before that second
      // parse ever runs.
      const validation: string[] = [];
      if (protocolFrom(entry.protocol, `clis[${index}] "${name}"`, validation, PROTOCOL_PRESETS) === undefined) {
        warnings.push(...validation);
        continue;
      }
    }
    services[name] = buildCliServiceConfig(name, defaults, entry, apiKeys, warnings);
  }
}

/**
 * `api_key: ${VAR}` references keyed by route name, read from the RAW tree
 * before interpolation.
 *
 * envRefs cannot cover this case. It maps a resolved value back to the
 * reference that produced it, and an UNSET variable resolves to "" — which
 * every unset variable shares, so the map would hand one route another route's
 * variable name. interpolateEnv skips empty resolutions for exactly that
 * reason.
 *
 * The consequence was silent: `configure --yes --force` run in a shell that
 * had not exported the variable emitted the route with no `api_key` line at
 * all, overwriting a correct config with one whose key was simply gone. Keyed
 * by route name, which is unique per shape and is what configure has in hand.
 */
function collectApiKeyRefs(parsed: Record<string, unknown>): Map<string, string> {
  const refs = new Map<string, string>();
  const note = (name: unknown, value: unknown): void => {
    if (typeof name === "string" && typeof value === "string" && ENV_VAR_RE.test(value)) {
      refs.set(name, value);
    }
  };
  for (const key of ["clis", "endpoints"] as const) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry !== null && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        note(e.name, e.api_key);
      }
    }
  }
  for (const key of ["services", "api_keys"] as const) {
    const block = parsed[key];
    if (block === null || typeof block !== "object") continue;
    for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
      if (key === "api_keys") note(name, entry);
      else if (entry !== null && typeof entry === "object") {
        note(name, (entry as Record<string, unknown>).api_key);
      }
    }
  }
  return refs;
}

function collectApiKeys(raw: Record<string, unknown>): ApiKeys {
  const apiKeys: ApiKeys = {};

  const rawApiKeys = (raw.api_keys ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawApiKeys)) {
    if (typeof v === "string" && v !== "") apiKeys[k] = v;
  }

  // Shorthand: codex_cli_api_key, cursor_cli_api_key, etc. — keyed by the
  // route id auto-detect assigns (AUTO_DETECT_NAME), not the harness type.
  for (const name of Object.values(AUTO_DETECT_NAME)) {
    const shorthand = `${name}_api_key`;
    const v = raw[shorthand];
    if (typeof v === "string" && v !== "") apiKeys[name] = v;
  }
  return apiKeys;
}

function addEndpoints(
  services: Record<string, ServiceConfig>,
  raw: Record<string, unknown>,
  apiKeys: ApiKeys,
  warnings: string[] = [],
): void {
  const endpoints = Array.isArray(raw.endpoints)
    ? (raw.endpoints as Record<string, unknown>[])
    : [];
  for (const [index, ep] of endpoints.entries()) {
    const name = str(ep.name);
    warnUnknownRouteKeys(ep, `endpoints[${index}] "${name ?? "?"}"`, warnings);
    const baseUrl = str(ep.base_url);
    const model = str(ep.model);
    if (!name || !baseUrl || !model) {
      // Silently dropping the entry was the same class this file keeps
      // producing: the equivalent `clis:` mistake warns loudly, this one left
      // `doctor` reporting "ok config-warnings" while three endpoints had
      // vanished.
      const missing = [
        !name ? "name" : undefined,
        !baseUrl ? "base_url" : undefined,
        !model ? "model" : undefined,
      ].filter((v): v is string => v !== undefined);
      warnings.push(
        `endpoints[${index}]${name ? ` "${name}"` : ""}: missing required ` +
          `${missing.join(", ")} — entry ignored.`,
      );
      continue;
    }

    const svc: ServiceConfig = {
      name,
      enabled: bool(ep.enabled, true),
      type: "openai_compatible",
      baseUrl,
      model,
      command: "",
      // The top-level `api_keys:` block was honoured for `clis:` (see
      // buildCliServiceConfig) and silently ignored here, so an endpoint whose
      // credential lived there had NO key at runtime — and `configure` could
      // not round-trip a reference that had never reached the service. Same
      // class as workspace_policy: a documented key read for one route shape
      // and dropped for another.
      ...(str(ep.api_key) !== undefined
        ? { apiKey: str(ep.api_key)! }
        : apiKeys[name]
          ? { apiKey: apiKeys[name]! }
          : {}),
      weight: num(ep.weight, 0.6),
      tier: int(ep.tier, 3),
      cliCapability: num(ep.cli_capability, 1.0),
      escalateOn: escalateOnFrom(ep.escalate_on),
      capabilities: capsFrom(ep.capabilities),
      ...billingFields({
        ...ep,
        provider: ep.provider ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "local"),
        surface: ep.surface ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "local_endpoint"),
        auth_source: ep.auth_source ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "local_network"),
        billing_kind: ep.billing_kind ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "local_compute"),
        paid_usage_possible:
          typeof ep.paid_usage_possible === "boolean"
            ? ep.paid_usage_possible
            : inferEndpointProvider(baseUrl) === "custom"
              ? ep.paid_usage_possible
              : false,
        billing_confidence:
          ep.billing_confidence ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "documented"),
      }),
      ...endpointFields(ep, "openai_compatible", baseUrl),
      // No defaults argument: an endpoint has no harness whose shipped
      // defaults it could fall back to. That absence is exactly why the CLI
      // path could not simply reuse billingFields() — see route-fields.ts.
      ...resolveSharedRouteFields(ep),
    };
    services[name] = svc;
  }
}

// ---------------------------------------------------------------------------
// Public: loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Override `which` for tests — return null when a CLI is "not found". */
  whichFn?: WhichFn;
  /**
   * Treat a missing explicit path as auto-detect rather than an error.
   *
   * Only `configure` sets this: the path it is given is its OUTPUT, which
   * legitimately does not exist yet. For every other command an explicit
   * --config that is not there is a typo, and silently auto-detecting printed
   * a confident route table for a config that was never loaded.
   */
  allowMissing?: boolean;
}

/**
 * Load a RouterConfig.
 *
 * If `path` is omitted (or the file doesn't exist), auto-detect CLIs on PATH
 * and use built-in defaults. If the file has a top-level `services:` key,
 * parse it in legacy mode. Otherwise auto-detect and merge `overrides`.
 *
 * Supports ${ENV_VAR} interpolation for any string value.
 */
/**
 * The config file a process should load: an explicit `--config`, else
 * `HARNESS_DISPATCH_CONFIG`, else `./config.yaml` if it exists, else nothing
 * (auto-detect).
 *
 * ONE function because there used to be two, and they disagreed. job-runner.ts
 * read the environment variable and bin.ts did not, while job-runner's own
 * header claimed the two mirrored each other. With the variable set in the
 * ambient environment, the server routed on auto-detected defaults and the
 * runner it spawned loaded a different file — the two halves of a single
 * dispatch working from different configs, with nothing reporting it. A
 * variable pointing at a file that does not exist was likewise ignored
 * outright by the CLI and the server, which CHANGELOG 0.6.0 claimed was
 * reported.
 *
 * A path from the variable is treated as EXPLICIT, so a missing file is an
 * error rather than a silent fall-through to auto-detect: someone who exported
 * it meant it.
 */
export function resolveConfigPath(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env["HARNESS_DISPATCH_CONFIG"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return existsSync("config.yaml") ? "config.yaml" : undefined;
}

export async function loadConfig(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const whichFn = opts.whichFn ?? defaultWhich;

  let raw: Record<string, unknown> = {};
  const unsetEnvVars = new Set<string>();
  const envRefs = new Map<string, string>();
  const apiKeyRefs = new Map<string, string>();
  if (path) {
    try {
      const text = await fs.readFile(path, "utf-8");
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === "object") {
        // Before interpolation: an unset ${VAR} is indistinguishable from
        // every other unset ${VAR} once it has resolved to "".
        for (const [name, ref] of collectApiKeyRefs(parsed as Record<string, unknown>)) {
          apiKeyRefs.set(name, ref);
        }
        raw = interpolateTree(parsed as Record<string, unknown>, unsetEnvVars, envRefs);
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // configure names an OUTPUT path, so a file that is not there yet is
        // its normal first run — it alone passes allowMissing.
        if (opts.allowMissing === true) {
          // Fall through to auto-detect with an empty `raw`.
        } else {
          // Otherwise an explicit --config that does not exist is a typo, not
          // a request for auto-detection. Continuing printed a confident,
          // healthy route table built from defaults, so a mistyped path looked
          // like a working config. The implicit fallback (no path given at
          // all) never reaches here and is unchanged.
          throw new Error(
            `config file not found: ${path}. Check the path, or omit --config to ` +
              `auto-detect installed harness CLIs.`,
          );
        }
      } else if (err instanceof yaml.YAMLException) {
        // A YAML syntax error used to escape as a raw js-yaml stack trace that
        // never named the file it came from.
        throw new Error(`config file ${path} is not valid YAML: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  const envVarWarning =
    unsetEnvVars.size > 0
      ? `\${VAR} reference(s) resolved to an empty string because the environment ` +
        `variable isn't set: ${[...unsetEnvVars].map((v) => `\${${v}}`).join(", ")} — any field ` +
        `using one (e.g. an api_key) silently lost its value; set the variable or fix the name.`
      : undefined;

  // Legacy full format: has a `services:` key -> use as-is.
  if (raw.services && typeof raw.services === "object") {
    const legacyCfg = buildLegacyConfig(raw);
    const enumWarnings: string[] = [];
    warnUnknownSafetyEnums(raw, enumWarnings);
    if (enumWarnings.length > 0) {
      legacyCfg.configWarnings = [...(legacyCfg.configWarnings ?? []), ...enumWarnings];
    }
    const withRefs = {
      ...legacyCfg,
      ...(envRefs.size > 0 ? { envRefs } : {}),
      ...(apiKeyRefs.size > 0 ? { apiKeyRefs } : {}),
    };
    if (envVarWarning !== undefined) {
      return { ...withRefs, configWarnings: [...(withRefs.configWarnings ?? []), envVarWarning] };
    }
    return withRefs;
  }

  const disabled: string[] = Array.isArray(raw.disabled)
    ? (raw.disabled as string[]).slice()
    : [];
  const overrides = (raw.overrides ?? {}) as Record<string, Record<string, unknown>>;

  const warnings: string[] = [];
  const knownAutoDetectNames = new Set(Object.values(AUTO_DETECT_NAME));
  for (const name of disabled) {
    if (!knownAutoDetectNames.has(name)) {
      warnings.push(
        `disabled: "${name}" doesn't match any auto-detected route (expected one of: ` +
          `${[...knownAutoDetectNames].join(", ")}) — ignored. If this is left over from ` +
          `before a route rename, the route it used to refer to is no longer disabled.`,
      );
    }
  }
  for (const name of Object.keys(overrides)) {
    if (!knownAutoDetectNames.has(name)) {
      warnings.push(
        `overrides.${name}: doesn't match any auto-detected route (expected one of: ` +
          `${[...knownAutoDetectNames].join(", ")}) — ignored, none of these settings were applied.`,
      );
    }
  }

  const apiKeys = collectApiKeys(raw);
  const services = await detectServices(disabled, apiKeys, overrides, whichFn);
  addClis(services, raw, apiKeys, warnings);
  addEndpoints(services, raw, apiKeys, warnings);

  warnUnknownSafetyEnums(raw, warnings);
  warnUnknownTopLevelKeys(raw, warnings);
  if (envVarWarning !== undefined) warnings.push(envVarWarning);
  const cfg: RouterConfig = {
    services,
    disabled,
    ...topLevelSettings(raw, warnings),
    ...(envRefs.size > 0 ? { envRefs } : {}),
    ...(apiKeyRefs.size > 0 ? { apiKeyRefs } : {}),
    ...(warnings.length > 0 ? { configWarnings: warnings } : {}),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Public: watchConfig
// ---------------------------------------------------------------------------

export interface ConfigWatcher {
  stop(): void;
}

/**
 * Poll the config file's mtime once per second. When it changes, reload and
 * invoke `onChange`. The returned handle's stop() cancels the poller.
 *
 * Errors from reload are swallowed so a transient parse error doesn't kill
 * the watcher — the next successful poll will pick up a repaired file.
 */
export function watchConfig(
  path: string,
  onChange: (c: RouterConfig) => void,
  opts: { intervalMs?: number; whichFn?: WhichFn } = {},
): ConfigWatcher {
  const intervalMs = opts.intervalMs ?? 1000;
  let lastMtime = 0;

  const tick = async (): Promise<void> => {
    try {
      const stat = await fs.stat(path);
      const mtime = stat.mtimeMs;
      if (lastMtime === 0) {
        lastMtime = mtime;
        return;
      }
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        const cfg = await loadConfig(
          path,
          opts.whichFn ? { whichFn: opts.whichFn } : {},
        );
        onChange(cfg);
      }
    } catch {
      // ignore transient errors
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in harness defaults (shipped config.default.yaml)
// ---------------------------------------------------------------------------

/**
 * Resolve the package's own bundled config.default.yaml relative to this
 * module — same "walk up" approach as leaderboard.ts's benchmark file, so
 * it works whether this is running compiled (dist/) or via tsx (src/). This
 * is a DIFFERENT file from a user's own config.yaml (never tracked, may
 * hold secrets/local overrides) — separating them means a package update to
 * the shipped defaults never collides with or gets clobbered by a user's
 * live instance, and vice versa.
 */
function resolveShippedConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "config.default.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(here, "..", "config.default.yaml");
}

/**
 * Parse one `clis:` entry of the shipped config into CliDefaults. Uses the
 * exact same field parsers (str/num/int/capsFrom/parseProtocolFields/...)
 * as a user's own `clis:` entry — the shipped file IS a config.yaml, parsed
 * the same way, not a special hardcoded path or bespoke shape.
 */
function cliDefaultsFrom(raw: Record<string, unknown>, warnings: string[]): [string, CliDefaults] | undefined {
  const harness = str(raw.harness);
  if (!harness) return undefined;
  const protocolRaw = raw.protocol;
  const protocol =
    protocolRaw !== undefined
      ? parseProtocolFields(protocolRaw as Record<string, unknown>, `shipped config.default.yaml clis "${harness}"`, warnings, undefined)
      : undefined;
  const billingKind = billingKindFrom(raw.billing_kind);
  return [
    harness,
    {
      command: str(raw.command) ?? "",
      harness,
      leaderboardModel: str(raw.leaderboard_model) ?? "",
      cliCapability: num(raw.cli_capability, 1.0),
      tier: int(raw.tier, 1),
      capabilities: capsFrom(raw.capabilities),
      ...(typeof raw.max_output_tokens === "number" ? { maxOutputTokens: raw.max_output_tokens } : {}),
      ...(typeof raw.max_input_tokens === "number" ? { maxInputTokens: raw.max_input_tokens } : {}),
      provider: providerFrom(raw.provider) ?? "custom",
      surface: surfaceFrom(raw.surface) ?? "custom",
      authSource: authSourceFrom(raw.auth_source) ?? "unknown",
      ...(billingKind !== undefined ? { billingKind } : {}),
      ...(typeof raw.paid_usage_possible === "boolean" ? { paidUsagePossible: raw.paid_usage_possible } : {}),
      ...(() => {
        const effectiveSafety = effectiveSafetyFrom(raw.effective_safety);
        return effectiveSafety !== undefined ? { effectiveSafety } : {};
      })(),
      ...(() => {
        const models = stringArrayFrom(raw.models);
        return models !== undefined ? { models } : {};
      })(),
      ...(() => {
        const modelHint = str(raw.model_hint);
        return modelHint !== undefined ? { modelHint } : {};
      })(),
      ...(protocol !== undefined ? { protocol } : {}),
    },
  ];
}

/**
 * Load the built-in harness defaults from the shipped config's `clis:` list
 * — the same shape as a `clis:` entry in a user's own config.yaml, keyed by
 * each entry's `harness:` value. Failure (missing/malformed file) degrades
 * to just the generic escape hatch — auto-detect simply finds nothing
 * built-in, rather than crashing the whole router; a user's own
 * `clis:`/`services:` entries are unaffected either way.
 */
function loadDefaultHarnesses(): Record<string, CliDefaults> {
  const warnings: string[] = [];
  const out: Record<string, CliDefaults> = { generic: GENERIC_DEFAULTS };
  try {
    const raw = yaml.load(readFileSync(resolveShippedConfigPath(), "utf8")) as {
      clis?: Record<string, unknown>[];
    };
    for (const entry of raw?.clis ?? []) {
      const parsed = cliDefaultsFrom(entry, warnings);
      if (parsed && parsed[0] !== "generic") out[parsed[0]] = parsed[1];
    }
    if (warnings.length > 0) {
      // Shipped-config warnings indicate a packaging/build problem, not a
      // user config mistake — surface loudly rather than folding into
      // configWarnings (which a user would reasonably assume is about
      // their own file).
      for (const w of warnings) console.error(`harness-dispatch: shipped config.default.yaml: ${w}`);
    }
    return out;
  } catch (err) {
    console.error(
      `harness-dispatch: failed to load the package's shipped config.default.yaml (${err instanceof Error ? err.message : String(err)}) ` +
        "— no built-in harnesses will be available; your own clis:/services: entries are unaffected.",
    );
    return out;
  }
}
