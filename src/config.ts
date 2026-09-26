/**
 * Configuration loading for harness-dispatch.
 *
 * Two entry points: loadConfig(path?) and watchConfig(path). All string values
 * are scanned for ${ENV_VAR} references and replaced with the corresponding
 * environment variable.
 */

import { existsSync, promises as fs } from "node:fs";
import { userConfigPath } from "./state-dir.js";
import { registerSecretValue, setActiveSecrets } from "./redaction.js";
import yaml from "js-yaml";
import which from "which";

import { inferredPaidUsagePossible } from "./billing.js";
import {
  authSourceFrom, billingKindFrom, bool, boolOrUndefined, capsFrom, endpointModeFrom,
  endpointProviderFrom, inferEndpointProvider, int, num, providerFrom, str,
  surfaceFrom, wireProtocolFrom,
} from "./config/coercions.js";
import {
  warnDuplicateRouteNames,
  warnMistypedRouteValues,
  warnUnknownRouteKeys,
  warnUnknownSafetyEnums,
  warnUnknownTopLevelKeys,
} from "./config/validation.js";
import { protocolFrom } from "./config/protocol.js";
import { CLI_DEFAULTS, PROTOCOL_PRESETS, type CliDefaults } from "./harness-presets.js";
import {
  
  resolveSharedRouteFields,
} from "./config/route-fields.js";
import { ENV_VAR_RE, interpolateTree } from "./config/env-interpolation.js";

/** Injection seam for tests. Set via loadConfig({ whichFn }) if needed. */
export type WhichFn = (cmd: string) => Promise<string | null>;

/**
 * PATH lookups, memoised for the life of the process: each is a real
 * filesystem walk (~2-3s per harness on Windows) and loadConfig() runs on
 * every CLI invocation and every reload.
 *
 * Deliberately NOT persisted across processes: installing a harness should
 * take effect on the next command, not after a cache expiry.
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
import type { RouterConfig, ServiceConfig, TaskType } from "./types.js";

// Built-in harness defaults come from the package's bundled
// config.default.yaml (see harness-presets.ts); no harness is special-cased
// here.
//
// The route ids below are distinct from the CLI_DEFAULTS key, which is the
// harness *type* (selects the dispatcher class via dispatcher-factory.ts's
// HARNESS_TABLE, and is read by billing.ts/safety.ts/router.ts) and must not
// change. These only control the service/route name, so they follow the same
// `*_cli` convention `endpoints:` uses for `*_api` (e.g. gemini_api).

/**
 * Commands auto-detect probes on PATH, exported so `doctor` can name them —
 * a zero-route install otherwise says "0 ready route(s)" and nothing about
 * what was looked for. Keyed like AUTO_DETECT_NAME so the two cannot drift.
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

/**
 * Blank out credential VALUES in a YAML parser's error text.
 *
 * js-yaml quotes the source lines around a syntax error, so a parse failure
 * near an `api_key:` puts that key into the error — which reaches
 * `config.reloadError`, `stateWarnings`, `status`, `doctor`, the HTTP status
 * route and the `harness-dispatch://status` MCP resource. js-yaml truncates
 * its snippet lines at roughly 50 characters, and a partial credential in an
 * agent-readable resource is still a disclosure.
 *
 * A pattern and not a lookup because the file did not parse, so there is no
 * configured value to compare against — only the KEY NAME is available.
 */
function redactSecretLines(message: string): string {
  return message.replace(
    /^(\s*(?:\d+\s*\|)?\s*(?:-\s*)?["']?(?:\w*(?:api[_-]?key|secret|token|password|passwd|authorization)\w*)["']?\s*:\s*)(\S.*)$/gim,
    (_m, prefix: string) => `${prefix}<redacted>`,
  );
}

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
 * Top-level config blocks shared by every format, parsed once here so legacy
 * `services:` and modern `clis:`/`endpoints:` configs behave identically.
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
    // Present but unusable. Silently falling back to the default would give a
    // caller who set a concurrency bound a different one with no warning —
    // and this value governs how many agent CLIs run at once.
    policyWarnings.push(
      `max_concurrent_runs: ${JSON.stringify(raw.max_concurrent_runs)} is not a ` +
        `non-negative number — IGNORED, the default applies instead.`,
    );
  }
  return out;
}


/**
 * Billing IDENTITY for a route — the part that genuinely differs per shape.
 * Endpoints derive provider/surface/kind from the base URL, CLI routes from
 * whether an api_key is present; this only reads what it is handed. Everything
 * that means the same thing everywhere comes from resolveSharedRouteFields.
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
  const paidUsagePossible = boolOrUndefined(raw.paid_usage_possible);
  if (paidUsagePossible !== undefined) out.paidUsagePossible = paidUsagePossible;
  return out;
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


// Legacy full-format parser (YAML with top-level `services:` key).
function buildLegacyConfig(raw: Record<string, unknown>): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const rawServices = (raw.services ?? {}) as Record<string, Record<string, unknown>>;
  const warnings: string[] = [];

  // `services:` must be a MAP of route id -> settings, but `typeof [] ===
  // "object"`, so a list slips through and becomes routes called "0", "1", …
  // with each item's `name:` ignored — healthy-looking until `--service
  // my_route` answers "Unknown service". A natural mistake: the sibling keys
  // `clis:` and `endpoints:` ARE lists, and their items DO carry `name:`.
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

  // A top-level `services:` key selects the legacy parser entirely — it never
  // looks at clis:/endpoints:/overrides:, so any of those sitting alongside it
  // are dropped unless we say so here.
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
    // Only the VALUE checks: the unknown-KEY warner is not called here because
    // the legacy shape accepts a wider set of keys than KNOWN_ROUTE_KEYS
    // lists, and reporting those as typos would be worse than silence.
    warnMistypedRouteValues(svc, `services."${name}"`, warnings);
    const type = (str(svc.type) ?? "cli") as ServiceConfig["type"];
    // Legacy-format entries inherit the named harness's shipped metadata just
    // as clis: entries do, so `harness: cursor` classifies correctly without
    // repeating every field. Explicit fields on the entry always win.
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
        // Billing identity only; the rest reaches this entry through
        // resolveSharedRouteFields below.
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
      // The same table the `clis:` and `endpoints:` builders use, so every
      // shape inherits the same set from the named harness.
      ...resolveSharedRouteFields(svc, harnessDefaults),
      ...endpointFields(svc, type, str(svc.base_url)),
      ...(() => {
        // Falls back to the named harness's built-in default protocol when
        // this entry doesn't declare its own, so `harness: claude_code` here
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

interface ApiKeys {
  [service: string]: string;
}

/**
 * Build a CLI ServiceConfig from a harness's built-in defaults plus a raw
 * override object. Shared by auto-detect (`overrides:` keyed by route id) and
 * explicit `clis:` entries (each entry IS the override).
 */
function buildCliServiceConfig(
  name: string,
  defaults: CliDefaults,
  override: Record<string, unknown>,
  apiKeys: ApiKeys,
  warnings: string[] = [],
): ServiceConfig {
  override = { ...override };
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
    // Fields that mean the same thing on every route shape. Spread early so
    // the shape-specific billing identity below, which depends on whether an
    // api_key is present, still wins.
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
      // A DECLARED billing_kind beats the harness default. `harness: generic`
      // defaults paidUsagePossible to true (an unknown command might cost
      // money), but a route declaring `billing_kind: local_compute` has said
      // it cannot; letting the default win would give `billing=local_compute
      // paid=possible` and the route skipped by billing policy.
      //
      // An explicit paid_usage_possible wins over both, and an api_key forces
      // true — a key means a metered account exists whatever the kind claims.
      const declaredKind = billingKindFrom(override.billing_kind);
      const paidUsagePossible =
        boolOrUndefined(override.paid_usage_possible) ??
        (apiKey
          ? true
          : declaredKind !== undefined
            ? inferredPaidUsagePossible(declaredKind)
            : defaults.paidUsagePossible);
      return paidUsagePossible !== undefined ? { paidUsagePossible } : {};
    })(),
    ...endpointFields(override, "cli", str(override.base_url)),
    ...(() => {
      // Falls back to this harness's built-in default when no override is
      // given, or when the override is malformed — protocolFrom has already
      // warned, and failing the whole route over a typo would be worse than
      // keeping the known-good default.
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

  // Probe every harness AT ONCE. Each `which` costs ~2-3s on Windows and
  // loadConfig() runs on every CLI invocation, so serialising four of them
  // would add ~11s to each. The probes are independent.
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
 * Explicit `clis:` entries: arbitrary `name`, required `harness` picking which
 * built-in defaults to start from.
 *
 * Not gated on `which()`. Declared explicitly, so the route is added
 * unconditionally and its dispatcher's isAvailable() reports whether the
 * binary is on PATH — surfaced in status/doctor either way, instead of
 * silently vanishing like an undetected auto-detect entry.
 */
function addClis(
  services: Record<string, ServiceConfig>,
  raw: Record<string, unknown>,
  apiKeys: ApiKeys,
  warnings: string[],
): void {
  const clis = Array.isArray(raw.clis) ? (raw.clis as Record<string, unknown>[]) : [];
  warnDuplicateRouteNames(clis.map((e) => str(e.name)), "clis", warnings);
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
      // Validate now so a malformed protocol block skips the whole entry
      // instead of landing a route with no `.protocol` at all. Warnings go to
      // a throwaway array because buildCliServiceConfig parses the same block
      // again, and would otherwise double every warning under two labels; on
      // failure they are surfaced once from here, since the entry is skipped
      // before that second parse runs.
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
 * Record, per route, that its `api_key: ${VAR}` resolved to nothing.
 *
 * The config-level warning for unset variables is one line in `doctor` about
 * the FILE: without this per-route mark, `usage` and `status` still list the
 * route as ready and the router still scores it, so it is picked and comes
 * back `HTTP 401: Invalid API Key`.
 *
 * ENDPOINT ROUTES ONLY. A CLI route declaring `api_key: ${ANTHROPIC_API_KEY}`
 * is asking for API billing instead of its subscription login, and with the
 * variable unset the harness just uses the login it already has — a working
 * route that must not be skipped. For an endpoint the key is the only
 * credential there is.
 */
function markUnsetApiKeys(
  services: Record<string, ServiceConfig>,
  apiKeyRefs: ReadonlyMap<string, string>,
): void {
  for (const [name, ref] of apiKeyRefs) {
    const svc = services[name];
    if (!svc || svc.type !== "openai_compatible") continue;
    if (svc.apiKey !== undefined && svc.apiKey !== "") continue;
    svc.apiKeyUnsetRef = ref;
  }
}

/**
 * `api_key: ${VAR}` references keyed by route name, read from the RAW tree
 * before interpolation.
 *
 * envRefs cannot cover this: it maps a resolved value back to its reference,
 * and every UNSET variable resolves to the same "", so the map would hand one
 * route another route's variable name. Keyed by route name, which is unique
 * and is what `configure` has in hand when it rewrites the file.
 */
/** Per route, the raw `api_key` / `base_url` text wherever it holds a `${...}`. */
function collectFieldRefs(
  parsed: Record<string, unknown>,
): Map<string, { apiKey?: string; baseUrl?: string }> {
  const refs = new Map<string, { apiKey?: string; baseUrl?: string }>();
  const hasRef = (v: unknown): v is string => typeof v === "string" && v.includes("${");
  const note = (name: unknown, entry: Record<string, unknown>): void => {
    if (typeof name !== "string") return;
    const found: { apiKey?: string; baseUrl?: string } = {};
    if (hasRef(entry.api_key)) found.apiKey = entry.api_key;
    if (hasRef(entry.base_url)) found.baseUrl = entry.base_url;
    if (found.apiKey !== undefined || found.baseUrl !== undefined) refs.set(name, found);
  };
  for (const key of ["clis", "endpoints"] as const) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry !== null && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        note(e.name, e);
      }
    }
  }
  const services = parsed.services;
  if (services !== null && typeof services === "object" && !Array.isArray(services)) {
    for (const [name, entry] of Object.entries(services as Record<string, unknown>)) {
      if (entry !== null && typeof entry === "object") note(name, entry as Record<string, unknown>);
    }
  }
  return refs;
}

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
    if (typeof v === "string" && v !== "") {
      apiKeys[k] = v;
      // Registered here and not from the finished config: an entry overridden
      // by an inline `api_key:`, or naming no route, never reaches a service
      // and would otherwise be invisible to redaction.
      registerSecretValue(v);
    }
  }

  // Shorthand: codex_cli_api_key, cursor_cli_api_key, etc. — keyed by the
  // route id auto-detect assigns (AUTO_DETECT_NAME), not the harness type.
  for (const name of Object.values(AUTO_DETECT_NAME)) {
    const shorthand = `${name}_api_key`;
    const v = raw[shorthand];
    if (typeof v === "string" && v !== "") {
      apiKeys[name] = v;
      registerSecretValue(v);
    }
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
  warnDuplicateRouteNames(endpoints.map((e) => str(e.name)), "endpoints", warnings);
  for (const [index, ep] of endpoints.entries()) {
    const name = str(ep.name);
    warnUnknownRouteKeys(ep, `endpoints[${index}] "${name ?? "?"}"`, warnings);
    const baseUrl = str(ep.base_url);
    const model = str(ep.model);
    if (!name || !baseUrl || !model) {
      // Warn rather than drop silently, or `doctor` reports "ok" while the
      // endpoints have vanished.
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
      // The top-level `api_keys:` block is honoured here as well as in
      // buildCliServiceConfig, or an endpoint whose credential lives there has
      // NO key at runtime.
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
          boolOrUndefined(ep.paid_usage_possible) ??
          (inferEndpointProvider(baseUrl) === "custom" ? undefined : false),
        billing_confidence:
          ep.billing_confidence ?? (inferEndpointProvider(baseUrl) === "custom" ? undefined : "documented"),
      }),
      ...endpointFields(ep, "openai_compatible", baseUrl),
      // No defaults argument: an endpoint has no harness whose shipped
      // defaults it could fall back to.
      ...resolveSharedRouteFields(ep),
    };
    services[name] = svc;
  }
}

export interface LoadConfigOptions {
  /** Override `which` for tests — return null when a CLI is "not found". */
  whichFn?: WhichFn;
  /**
   * Treat a missing explicit path as auto-detect rather than an error.
   *
   * Only `configure` sets this: the path it is given is its OUTPUT, which
   * legitimately does not exist yet. For every other command an explicit
   * --config that is not there is a typo, and silently auto-detecting would
   * print a confident route table for a config that was never loaded.
   */
  allowMissing?: boolean;
}

/**
 * The config file a process should load: an explicit `--config`, else
 * `HARNESS_DISPATCH_CONFIG`, else `./config.yaml` if it exists, else the
 * state directory's `config.yaml` (where `configure` writes) if it exists,
 * else nothing (auto-detect). The current directory stays ahead of the user
 * file so a per-project config still wins when one is present.
 *
 * ONE function, shared by bin.ts and job-runner.ts: two copies disagreeing
 * about the environment variable would leave a server and the runner it
 * spawned on different configs for a single dispatch.
 *
 * A path from the variable is EXPLICIT, so a missing file is an error rather
 * than a silent fall-through to auto-detect.
 */
export function resolveConfigPath(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env["HARNESS_DISPATCH_CONFIG"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (existsSync("config.yaml")) return "config.yaml";
  const user = userConfigPath();
  return existsSync(user) ? user : undefined;
}

/**
 * Warn when a base_url's PATH looks like it carries a credential.
 *
 * A path segment cannot be told from a credential by inspection — redacting on
 * a length threshold would mangle an Azure deployment name
 * (`.../deployments/gpt-4-turbo-preview`) wherever it appeared. So this warns
 * instead: the user knows which it is, and moving it to `api_key:` makes it
 * redactable everywhere by value.
 */
function warnCredentialInUrlPath(config: RouterConfig, warnings: string[]): void {
  for (const svc of Object.values(config.services ?? {})) {
    if (svc.baseUrl === undefined) continue;
    let segments: string[];
    try {
      segments = new URL(svc.baseUrl).pathname.split("/");
    } catch {
      continue;
    }
    // A JWT (`eyJ….eyJ….sig`) is matched before the dotted-segment filter,
    // and no digit is required, so an all-alphabetic token still matches.
    const suspicious = segments.find((seg) => {
      if (seg.length < 24) return false;
      if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(seg)) return true;
      // A dotted segment is otherwise a filename or a version, not a secret.
      if (seg.includes(".")) return false;
      return /^[A-Za-z0-9_:-]+$/.test(seg) && !/[_-]/.test(seg.slice(0, 8));
    });
    if (suspicious === undefined) continue;
    warnings.push(
      `${svc.name}: base_url's path contains a long opaque segment. If that is a ` +
        `credential, move it to api_key: — a secret in the URL path cannot be told ` +
        `from a deployment name, so it is NOT removed from logs or error messages.`,
    );
  }
}

/**
 * Load config, and register its secrets for output redaction.
 *
 * If `path` is omitted (or the file doesn't exist), auto-detect CLIs on PATH
 * and use built-in defaults. A top-level `services:` key selects the legacy
 * parser; otherwise `clis:`/`endpoints:`/`overrides:` apply. Any string value
 * may use ${ENV_VAR} interpolation.
 *
 * A thin wrapper on purpose: `loadConfigInner` has several return paths, so
 * registering inside it would be several sites to keep in step. Here, every
 * caller gets redaction by loading config at all. See src/redaction.ts.
 */
export async function loadConfig(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const config = await loadConfigInner(path, opts);
  const pathWarnings: string[] = [];
  warnCredentialInUrlPath(config, pathWarnings);
  const withWarnings =
    pathWarnings.length > 0
      ? { ...config, configWarnings: [...(config.configWarnings ?? []), ...pathWarnings] }
      : config;
  setActiveSecrets(withWarnings);
  return withWarnings;
}

async function loadConfigInner(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const whichFn = opts.whichFn ?? defaultWhich;

  let raw: Record<string, unknown> = {};
  const unsetEnvVars = new Set<string>();
  const envRefs = new Map<string, string>();
  const apiKeyRefs = new Map<string, string>();
  let fieldRefs = new Map<string, { apiKey?: string; baseUrl?: string }>();
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
        fieldRefs = collectFieldRefs(parsed as Record<string, unknown>);
        raw = interpolateTree(parsed as Record<string, unknown>, unsetEnvVars, envRefs);
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        if (opts.allowMissing === true) {
          // `configure` names an OUTPUT path, so a file that is not there yet
          // is its normal first run; fall through to auto-detect.
        } else {
          // An explicit --config that does not exist is a typo, not a request
          // for auto-detection: continuing would print a confident, healthy
          // route table built from defaults. The implicit fallback (no path
          // given at all) never reaches here.
          throw new Error(
            `config file not found: ${path}. Check the path, or omit --config to ` +
              `auto-detect installed harness CLIs.`,
          );
        }
      } else if (e.code === "EISDIR") {
        // A raw `EISDIR: illegal operation on a directory, read` names no
        // path, so it omits the one thing the user needs: which argument was
        // wrong.
        throw new Error(
          `config path ${path} is a directory, not a file. Point --config at the ` +
            `config.yaml inside it.`,
        );
      } else if (err instanceof yaml.YAMLException) {
        // Name the file: a raw js-yaml stack trace does not say which config
        // it came from.
        throw new Error(
          `config file ${path} is not valid YAML: ${redactSecretLines(err.message)}`,
        );
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
    // The legacy shape returns before the modern path's top-level key check
    // runs, so it has to be done here too — that check is about the top level
    // of the FILE, which both shapes have.
    warnUnknownTopLevelKeys(raw, enumWarnings);
    if (enumWarnings.length > 0) {
      legacyCfg.configWarnings = [...(legacyCfg.configWarnings ?? []), ...enumWarnings];
    }
    const withRefs = {
      ...legacyCfg,
      ...(envRefs.size > 0 ? { envRefs } : {}),
      ...(apiKeyRefs.size > 0 ? { apiKeyRefs } : {}),
      ...(fieldRefs.size > 0 ? { fieldRefs } : {}),
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
  for (const [name, entry] of Object.entries(overrides)) {
    if (!knownAutoDetectNames.has(name)) {
      warnings.push(
        `overrides.${name}: doesn't match any auto-detected route (expected one of: ` +
          `${[...knownAutoDetectNames].join(", ")}) — ignored, none of these settings were applied.`,
      );
      continue;
    }
    // `overrides:` gets the same value checks as the route shapes:
    // config.default.yaml presents it as the way to tweak tier and weight
    // without writing a full config, so `tier: metered` here must not pass
    // silently while applying nothing.
    if (entry !== null && typeof entry === "object") {
      warnUnknownRouteKeys(entry, `overrides.${name}`, warnings);
    }
  }

  const apiKeys = collectApiKeys(raw);

  // A CONFIG FILE THAT DEFINES ROUTES IS AUTHORITATIVE about them. Otherwise a
  // file ADDS to the harnesses installed on the machine rather than replacing
  // them, and only `disabled:` — naming every route, including ones you might
  // not know existed — can subtract. That also decays: a release adding a
  // fifth supported harness would auto-add it to every existing config. The
  // legacy `services:` format is authoritative too, so the shapes agree.
  //
  // Three cases, and the third is what keeps the migration safe:
  //   detect: true/false   — explicit, always wins.
  //   file defines routes  — authoritative; detection off.
  //   file defines NO routes — detection ON, with a warning. A file carrying
  //     only `overrides:`/`disabled:`/settings exists to TUNE detection; it
  //     cannot be authoritative about routes it does not describe, and
  //     switching detection off for it would leave such a user with nothing.
  //
  // PRESENCE of the key, not a non-empty list: `clis: []` is someone writing
  // down "no CLI routes", the most explicit opinion available. A block that is
  // present counts even when it is the wrong shape — the warning below tells
  // the user their entries were ignored, and that must not also turn detection
  // on, or a config naming one route runs every installed harness instead.
  const present = (v: unknown): boolean => v !== undefined && v !== null;
  const definesRoutes = present(raw.clis) || present(raw.endpoints);
  // A `clis:` written as a MAPPING rather than a list drops every entry under
  // it, so say so loudly.
  for (const key of ["clis", "endpoints"] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      warnings.push(
        `${key}: must be a LIST, but this config has ${
          typeof value === "object" ? "a mapping" : `a ${typeof value}`
        } — every entry under it was IGNORED. Write it as \`${key}:\` followed by ` +
          `\`  - name: ...\` items. As written this config defines no ${key} at all.`,
      );
    }
  }
  const detectRequested = typeof raw.detect === "boolean" ? raw.detect : undefined;
  const detect = detectRequested ?? !definesRoutes;
  if (detectRequested === undefined && !definesRoutes && Object.keys(raw).length > 0) {
    warnings.push(
      "this config defines no routes of its own (no `clis:` or `endpoints:` entries), so " +
        "installed harness CLIs are still auto-detected and added. That is the old default " +
        "and it still applies here; a config that DOES define routes is now authoritative " +
        "and detection is off for it. Say `detect: true` to keep this explicit, or " +
        "`detect: false` to run with no routes at all.",
    );
  }
  const services = detect
    ? await detectServices(disabled, apiKeys, overrides, whichFn)
    : {};
  if (!detect && (disabled.length > 0 || Object.keys(overrides).length > 0)) {
    warnings.push(
      "`disabled:` and `overrides:` apply to AUTO-DETECTED routes, and this config is " +
        "authoritative (it defines its own routes), so detection is off and neither had any " +
        "effect. Remove them, or add `detect: true` if you also want detected routes.",
    );
  }
  addClis(services, raw, apiKeys, warnings);
  addEndpoints(services, raw, apiKeys, warnings);
  markUnsetApiKeys(services, apiKeyRefs);

  warnUnknownSafetyEnums(raw, warnings);
  warnUnknownTopLevelKeys(raw, warnings);
  if (envVarWarning !== undefined) warnings.push(envVarWarning);
  const cfg: RouterConfig = {
    services,
    disabled,
    // Only when the file SAID so. Carrying the resolved value would make
    // `configure` write `detect: true` into every config that merely omitted
    // it, turning a default into a permanent declaration.
    ...(detectRequested !== undefined ? { detect: detectRequested } : {}),
    detectionRan: detect,
    ...topLevelSettings(raw, warnings),
    ...(envRefs.size > 0 ? { envRefs } : {}),
    ...(apiKeyRefs.size > 0 ? { apiKeyRefs } : {}),
    ...(fieldRefs.size > 0 ? { fieldRefs } : {}),
    ...(warnings.length > 0 ? { configWarnings: warnings } : {}),
  };
  return cfg;
}

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

