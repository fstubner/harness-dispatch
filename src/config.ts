/**
 * Configuration loading for harness-router.
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

import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import which from "which";

import {
  normalizeSafetyProfile,
} from "./safety.js";
import type {
  AuthSource,
  BillingConfidence,
  BillingKind,
  BillingProvider,
  BillingSurface,
  EndpointMode,
  EndpointProvider,
  RouterConfig,
  ServiceConfig,
  TaskType,
  ThinkingLevel,
  WireProtocol,
  WorkspacePolicy,
} from "./types.js";

// ---------------------------------------------------------------------------
// Built-in defaults for auto-detected CLIs.
// Mirrors Python config.py _CLI_DEFAULTS exactly.
// ---------------------------------------------------------------------------

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
}

// Token limits as of April 2026. Treat as conservative upper bounds —
// providers occasionally raise them, rarely lower them.
const CLI_DEFAULTS: Record<string, CliDefaults> = {
  claude_code: {
    command: "claude",
    harness: "claude_code",
    leaderboardModel: "claude-opus-4-6",
    cliCapability: 1.1,
    tier: 1,
    capabilities: { execute: 0.95, plan: 1.0, review: 1.0 },
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000, // Opus + Sonnet 1M context
    provider: "anthropic",
    surface: "claude_agent_sdk",
    authSource: "oauth_session",
  },
  codex: {
    command: "codex",
    harness: "codex",
    leaderboardModel: "gpt-5.4",
    cliCapability: 1.08,
    tier: 1,
    capabilities: { execute: 1.0, plan: 0.83, review: 0.82 },
    maxOutputTokens: 128_000,
    maxInputTokens: 400_000,
    provider: "openai",
    surface: "codex_cli",
    authSource: "product_login",
    billingKind: "included_plan_then_flexible_credits",
    paidUsagePossible: true,
  },
  cursor: {
    command: "cursor-agent",
    harness: "cursor",
    leaderboardModel: "claude-sonnet-4-6",
    cliCapability: 1.05,
    tier: 1,
    capabilities: { execute: 1.0, plan: 0.82, review: 0.9 },
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    provider: "cursor",
    surface: "cursor_agent_cli",
    authSource: "product_login",
    billingKind: "included_usage_then_on_demand",
    paidUsagePossible: true,
  },
  antigravity_cli: {
    command: "agy",
    harness: "antigravity_cli",
    // Antigravity's model selection is configured in the CLI. Use the closest
    // benchmarked Gemini model for routing quality until that default has a
    // stable, machine-readable identifier.
    leaderboardModel: "gemini-3.1-pro-preview",
    cliCapability: 1.0,
    tier: 1,
    capabilities: { execute: 0.87, plan: 0.97, review: 0.95 },
    maxOutputTokens: 65_536,
    maxInputTokens: 2_000_000,
    provider: "google",
    surface: "antigravity_cli",
    authSource: "product_login",
    billingKind: "free_quota",
    paidUsagePossible: false,
  },
};

// Default route id auto-detect assigns for each harness — distinct from the
// CLI_DEFAULTS key above, which is the harness *type* (selects the
// dispatcher class via dispatcher-factory.ts's HARNESS_TABLE, and is read by
// billing.ts/safety.ts/router.ts) and must not change. This mapping only
// controls what shows up as the service/route name, so it can follow the
// same `*_cli` convention `endpoints:` uses for `*_api` (e.g. gemini_api).
const AUTO_DETECT_NAME: Record<string, string> = {
  claude_code: "claude_code_cli",
  codex: "codex_cli",
  cursor: "cursor_cli",
  antigravity_cli: "antigravity_cli",
};

// ---------------------------------------------------------------------------
// Env var interpolation (${VAR_NAME})
// ---------------------------------------------------------------------------

const ENV_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function interpolateEnv(value: string): string {
  const m = ENV_VAR_RE.exec(value);
  if (!m) return value;
  return process.env[m[1]!] ?? "";
}

/** Walk an object tree and replace any "${VAR}" string leaves with env values. */
function interpolateTree<T>(node: T): T {
  if (typeof node === "string") {
    return interpolateEnv(node) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map(interpolateTree) as unknown as T;
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateTree(v);
    }
    return out as unknown as T;
  }
  return node;
}

// ---------------------------------------------------------------------------
// `which` — pluggable for tests
// ---------------------------------------------------------------------------

/** Injection seam for tests. Set via loadConfig({ whichFn }) if needed. */
export type WhichFn = (cmd: string) => Promise<string | null>;

const defaultWhich: WhichFn = async (cmd: string): Promise<string | null> => {
  try {
    const r = await which(cmd, { nothrow: true });
    return r ?? null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function num(v: unknown, def: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

function int(v: unknown, def: number): number {
  return Math.trunc(num(v, def));
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return def;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "") return undefined;
  return v;
}

function thinkingFrom(v: unknown): ThinkingLevel | undefined {
  if (v === "low" || v === "medium" || v === "high") return v;
  return undefined;
}

function providerFrom(v: unknown): BillingProvider | undefined {
  if (
    v === "anthropic" ||
    v === "openai" ||
    v === "cursor" ||
    v === "google" ||
    v === "local" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

function surfaceFrom(v: unknown): BillingSurface | undefined {
  if (
    v === "claude_code" ||
    v === "claude_agent_sdk" ||
    v === "anthropic_api" ||
    v === "codex_cli" ||
    v === "codex_sdk" ||
    v === "openai_api" ||
    v === "cursor_agent_cli" ||
    v === "antigravity_cli" ||
    v === "gemini_api" ||
    v === "vertex_ai" ||
    v === "openai_compatible" ||
    v === "local_endpoint" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

function authSourceFrom(v: unknown): AuthSource | undefined {
  if (
    v === "product_login" ||
    v === "api_key" ||
    v === "oauth_session" ||
    v === "local_network" ||
    v === "configured_endpoint" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

function billingKindFrom(v: unknown): BillingKind | undefined {
  if (
    v === "local_compute" ||
    v === "included_plan_usage" ||
    v === "included_plan_then_flexible_credits" ||
    v === "included_credit_then_optional_overage" ||
    v === "included_usage_then_on_demand" ||
    v === "metered_api" ||
    v === "free_quota" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

function confidenceFrom(v: unknown): BillingConfidence | undefined {
  if (v === "documented" || v === "inferred" || v === "unknown" || v === "unsupported") {
    return v;
  }
  return undefined;
}

function endpointModeFrom(v: unknown): EndpointMode | undefined {
  if (
    v === "provider_cloud" ||
    v === "direct_openai_compatible" ||
    v === "harness_native_endpoint"
  ) {
    return v;
  }
  return undefined;
}

function endpointProviderFrom(v: unknown): EndpointProvider | undefined {
  if (
    v === "ollama" ||
    v === "lmstudio" ||
    v === "openai_compatible" ||
    v === "anthropic_gateway" ||
    v === "gemini_proxy" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

function wireProtocolFrom(v: unknown): WireProtocol | undefined {
  if (
    v === "openai_chat_completions" ||
    v === "anthropic_messages" ||
    v === "gemini_generate_content" ||
    v === "provider_native" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

function workspacePolicyFrom(v: unknown): WorkspacePolicy | undefined {
  if (v === "shared" || v === "shared_locked" || v === "git_worktree" || v === "copy") {
    return v;
  }
  return undefined;
}

function inferEndpointProvider(baseUrl: string | undefined): EndpointProvider {
  if (!baseUrl) return "custom";
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const port = url.port;
    if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && port === "11434") {
      return "ollama";
    }
    if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && port === "1234") {
      return "lmstudio";
    }
  } catch {
    // Fall through to substring checks for partial or nonstandard URLs.
  }
  const lower = baseUrl.toLowerCase();
  if (lower.includes("ollama")) return "ollama";
  if (lower.includes("lmstudio") || lower.includes("lm-studio")) return "lmstudio";
  return "custom";
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

function billingFields(raw: Record<string, unknown>): Partial<ServiceConfig> {
  const out: Partial<ServiceConfig> = {};
  const provider = providerFrom(raw.provider);
  const surface = surfaceFrom(raw.surface);
  const authSource = authSourceFrom(raw.auth_source);
  const billingKind = billingKindFrom(raw.billing_kind);
  const billingConfidence = confidenceFrom(raw.billing_confidence);
  const safetyProfile = normalizeSafetyProfile(raw.safety_profile);
  if (provider !== undefined) out.provider = provider;
  if (surface !== undefined) out.surface = surface;
  if (authSource !== undefined) out.authSource = authSource;
  if (billingKind !== undefined) out.billingKind = billingKind;
  if (billingConfidence !== undefined) out.billingConfidence = billingConfidence;
  if (typeof raw.paid_usage_possible === "boolean") {
    out.paidUsagePossible = raw.paid_usage_possible;
  }
  if (typeof raw.allow_paid_usage === "boolean") out.allowPaidUsage = raw.allow_paid_usage;
  if (typeof raw.allow_paid_overage === "boolean") out.allowPaidOverage = raw.allow_paid_overage;
  const notes = str(raw.billing_notes);
  if (notes !== undefined) out.billingNotes = notes;
  if (safetyProfile !== undefined) out.safetyProfile = safetyProfile;
  const workspacePolicy = workspacePolicyFrom(raw.workspace_policy);
  if (workspacePolicy !== undefined) out.workspacePolicy = workspacePolicy;
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

  for (const [name, svc] of Object.entries(rawServices)) {
    const type = (str(svc.type) ?? "cli") as ServiceConfig["type"];
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
      ...(str(svc.leaderboard_model) !== undefined
        ? { leaderboardModel: str(svc.leaderboard_model)! }
        : {}),
      ...(() => {
        const t = thinkingFrom(svc.thinking_level);
        return t !== undefined ? { thinkingLevel: t } : {};
      })(),
      ...(str(svc.escalate_model) !== undefined
        ? { escalateModel: str(svc.escalate_model)! }
        : {}),
      escalateOn: escalateOnFrom(svc.escalate_on),
      capabilities: capsFrom(svc.capabilities),
      ...(typeof svc.max_output_tokens === "number"
        ? { maxOutputTokens: svc.max_output_tokens }
        : {}),
      ...(typeof svc.max_input_tokens === "number"
        ? { maxInputTokens: svc.max_input_tokens }
        : {}),
      ...billingFields(svc),
      ...endpointFields(svc, type, str(svc.base_url)),
    };
    services[name] = svcConfig;
  }

  const cfg: RouterConfig = {
    services,
    ...(Array.isArray(raw.disabled)
      ? { disabled: (raw.disabled as string[]).slice() }
      : {}),
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
    leaderboardModel: str(override.leaderboard_model) ?? defaults.leaderboardModel,
    ...(() => {
      const overrideThinking = thinkingFrom(override.thinking_level);
      if (overrideThinking !== undefined) return { thinkingLevel: overrideThinking };
      if (defaults.thinkingLevel !== undefined) {
        return { thinkingLevel: defaults.thinkingLevel };
      }
      return {};
    })(),
    ...(str(override.escalate_model) !== undefined
      ? { escalateModel: str(override.escalate_model)! }
      : {}),
    escalateOn: escalateOnFrom(override.escalate_on),
    capabilities: caps,
    ...(() => {
      const m = override.max_output_tokens;
      const v = typeof m === "number" ? m : defaults.maxOutputTokens;
      return v !== undefined ? { maxOutputTokens: v } : {};
    })(),
    ...(() => {
      const m = override.max_input_tokens;
      const v = typeof m === "number" ? m : defaults.maxInputTokens;
      return v !== undefined ? { maxInputTokens: v } : {};
    })(),
    provider: providerFrom(override.provider) ?? defaults.provider,
    surface: surfaceFrom(override.surface) ?? defaults.surface,
    authSource: authSourceFrom(override.auth_source) ?? (apiKey ? "api_key" : defaults.authSource),
    ...(() => {
      const billingKind =
        billingKindFrom(override.billing_kind) ?? (apiKey ? "metered_api" : defaults.billingKind);
      return billingKind !== undefined ? { billingKind } : {};
    })(),
    ...(() => {
      const paidUsagePossible =
        typeof override.paid_usage_possible === "boolean"
          ? override.paid_usage_possible
          : apiKey
            ? true
            : defaults.paidUsagePossible;
      return paidUsagePossible !== undefined ? { paidUsagePossible } : {};
    })(),
    ...(typeof override.allow_paid_usage === "boolean"
      ? { allowPaidUsage: override.allow_paid_usage }
      : {}),
    ...(typeof override.allow_paid_overage === "boolean"
      ? { allowPaidOverage: override.allow_paid_overage }
      : {}),
    ...(() => {
      const c = confidenceFrom(override.billing_confidence);
      return c !== undefined ? { billingConfidence: c } : {};
    })(),
    ...(() => {
      const notes = str(override.billing_notes);
      return notes !== undefined ? { billingNotes: notes } : {};
    })(),
    ...(() => {
      const safetyProfile = normalizeSafetyProfile(override.safety_profile);
      return safetyProfile !== undefined ? { safetyProfile } : {};
    })(),
    ...endpointFields(override, "cli", str(override.base_url)),
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
  for (const [harness, defaults] of Object.entries(CLI_DEFAULTS)) {
    const name = AUTO_DETECT_NAME[harness] ?? harness;
    if (disabledSet.has(name)) continue;
    const found = await whichFn(defaults.command);
    if (!found) continue;

    const override = overrides[name] ?? {};
    services[name] = buildCliServiceConfig(name, defaults, override, apiKeys);
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
    const defaults = CLI_DEFAULTS[harness];
    if (!defaults) {
      warnings.push(
        `clis[${index}] "${name}": unrecognized harness "${harness}" (expected one of: ` +
          `${Object.keys(CLI_DEFAULTS).join(", ")}) — entry ignored.`,
      );
      continue;
    }
    services[name] = buildCliServiceConfig(name, defaults, entry, apiKeys);
  }
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
): void {
  const endpoints = Array.isArray(raw.endpoints)
    ? (raw.endpoints as Record<string, unknown>[])
    : [];
  for (const ep of endpoints) {
    const name = str(ep.name);
    const baseUrl = str(ep.base_url);
    const model = str(ep.model);
    if (!name || !baseUrl || !model) continue;

    const svc: ServiceConfig = {
      name,
      enabled: bool(ep.enabled, true),
      type: "openai_compatible",
      baseUrl,
      model,
      command: "",
      ...(str(ep.api_key) !== undefined ? { apiKey: str(ep.api_key)! } : {}),
      weight: num(ep.weight, 0.6),
      tier: int(ep.tier, 3),
      cliCapability: num(ep.cli_capability, 1.0),
      ...(str(ep.leaderboard_model) !== undefined
        ? { leaderboardModel: str(ep.leaderboard_model)! }
        : {}),
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
export async function loadConfig(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const whichFn = opts.whichFn ?? defaultWhich;

  let raw: Record<string, unknown> = {};
  if (path) {
    try {
      const text = await fs.readFile(path, "utf-8");
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === "object") {
        raw = interpolateTree(parsed as Record<string, unknown>);
      }
    } catch (err: unknown) {
      // File not found -> auto-detect mode. Any other error -> rethrow.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }

  // Legacy full format: has a `services:` key -> use as-is.
  if (raw.services && typeof raw.services === "object") {
    return buildLegacyConfig(raw);
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
  addEndpoints(services, raw);

  const cfg: RouterConfig = {
    services,
    disabled,
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
