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

/** The full set of `{{name}}` tokens expandToken() in generic-cli.ts understands. */
const KNOWN_ARG_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "{{prompt}}",
  "{{model}}",
  "{{safety}}",
  "{{working_dir}}",
  "{{file_dirs}}",
  "{{native_args}}",
]);

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
  effectiveSafety?: SafetyProfile;
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

/**
 * `unsetVars` collects the names of ${VAR} references that resolved to
 * nothing because the env var isn't set at all — distinct from a var
 * deliberately set to "". Without this, a typo'd or forgotten env var
 * (${ANTHROPIC_API_KEY} when the real name is ${ANTHROPIC_KEY}) silently
 * becomes an empty string: `str()` then drops the field entirely, a route
 * that needed an api_key loses it with zero feedback, and doctor reports
 * the route "ready" right up until the first real call 401s.
 */
function interpolateEnv(value: string, unsetVars: Set<string>): string {
  const m = ENV_VAR_RE.exec(value);
  if (!m) return value;
  const name = m[1]!;
  if (!(name in process.env)) unsetVars.add(name);
  return process.env[name] ?? "";
}

/** Walk an object tree and replace any "${VAR}" string leaves with env values. */
function interpolateTree<T>(node: T, unsetVars: Set<string>): T {
  if (typeof node === "string") {
    return interpolateEnv(node, unsetVars) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((v) => interpolateTree(v, unsetVars)) as unknown as T;
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateTree(v, unsetVars);
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

/**
 * Top-level config blocks shared by every format: `telemetry:` and
 * `retention:`. Parsed once here so legacy `services:` configs and modern
 * `clis:`/`endpoints:` configs behave identically.
 */
function topLevelSettings(raw: Record<string, unknown>): Partial<RouterConfig> {
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
  const maxRuns = num(raw.max_concurrent_runs, Number.NaN);
  if (Number.isFinite(maxRuns) && maxRuns >= 0) out.maxConcurrentRuns = Math.floor(maxRuns);
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

function stringArrayFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Parse `protocol:` for any route (see CliProtocolConfig in types.ts).
 * Three shapes:
 *  - A string ("cursor", "codex", ...) — looked up in PROTOCOL_PRESETS by
 *    name. Lets a config select a known protocol without retyping it, and
 *    is the extension point for "others add further protocols" — a new
 *    named entry in the shipped config.default.yaml is immediately selectable here,
 *    no code changes.
 *  - An object with `extends: <preset name>` — starts from that preset and
 *    overrides only the fields present, for the common "95% the same, one
 *    flag different" case. safety merges per-profile (overriding just
 *    full_auto doesn't erase read_only/workspace_edit from the preset).
 *  - A plain object — the full protocol, no preset involved (unchanged
 *    behavior from before presets existed).
 *
 * Returns undefined — with a warning — for anything malformed, so a broken
 * block degrades to "route unusable" (isAvailable() checks for a missing
 * protocol) rather than a half-built dispatcher silently doing the wrong
 * thing.
 */
function protocolFrom(raw: unknown, routeLabel: string, warnings: string[]): CliProtocolConfig | undefined {
  if (typeof raw === "string") {
    const preset = PROTOCOL_PRESETS[raw];
    if (!preset) {
      warnings.push(
        `${routeLabel}: protocol "${raw}" is not a known preset (expected one of: ` +
          `${Object.keys(PROTOCOL_PRESETS).join(", ")}) — entry ignored.`,
      );
      return undefined;
    }
    return preset;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  let base: CliProtocolConfig | undefined;
  if (typeof r.extends === "string") {
    base = PROTOCOL_PRESETS[r.extends];
    if (!base) {
      warnings.push(
        `${routeLabel}: protocol.extends "${r.extends}" is not a known preset (expected one of: ` +
          `${Object.keys(PROTOCOL_PRESETS).join(", ")}) — entry ignored.`,
      );
      return undefined;
    }
  }
  return parseProtocolFields(r, routeLabel, warnings, base);
}

function parseProtocolFields(
  r: Record<string, unknown>,
  routeLabel: string,
  warnings: string[],
  base: CliProtocolConfig | undefined,
): CliProtocolConfig | undefined {
  const args = stringArrayFrom(r.args) ?? base?.args;
  if (args === undefined) {
    warnings.push(`${routeLabel}: protocol.args is required — entry ignored.`);
    return undefined;
  }

  const outputRaw = r.output;
  let output: CliProtocolConfig["output"] | undefined = base?.output;
  if (outputRaw !== undefined) {
    if (outputRaw === null || typeof outputRaw !== "object") {
      warnings.push(`${routeLabel}: protocol.output must be an object — entry ignored.`);
      return undefined;
    }
    const o = outputRaw as Record<string, unknown>;
    if (o.mode !== "text" && o.mode !== "json_field" && o.mode !== "jsonl_stream") {
      warnings.push(
        `${routeLabel}: protocol.output.mode must be one of text | json_field | jsonl_stream — entry ignored.`,
      );
      return undefined;
    }
    output = { mode: o.mode };
    const fields = stringArrayFrom(o.fields);
    if (fields !== undefined) output.fields = fields;
    const usageRaw = o.usage;
    if (usageRaw !== null && typeof usageRaw === "object") {
      const u = usageRaw as Record<string, unknown>;
      const input = stringArrayFrom(u.input);
      const outputTokens = stringArrayFrom(u.output);
      if (input !== undefined && outputTokens !== undefined) output.usage = { input, output: outputTokens };
    }
    const eventRulesRaw = o.event_rules;
    if (Array.isArray(eventRulesRaw)) {
      const eventRules: CliEventRule[] = [];
      for (const [i, ruleRaw] of eventRulesRaw.entries()) {
        const rule = eventRuleFrom(ruleRaw, `${routeLabel}: protocol.output.event_rules[${i}]`, warnings);
        if (rule) eventRules.push(rule);
      }
      if (eventRules.length > 0) output.eventRules = eventRules;
    }
    const errorRaw = o.error;
    if (errorRaw !== null && typeof errorRaw === "object") {
      const e = errorRaw as Record<string, unknown>;
      const field = str(e.field);
      if (field !== undefined) {
        const messageFields = stringArrayFrom(e.message_fields);
        output.error = messageFields !== undefined ? { field, messageFields } : { field };
      } else {
        warnings.push(`${routeLabel}: protocol.output.error.field is required — error detection ignored.`);
      }
    }
  }
  if (output === undefined) {
    warnings.push(`${routeLabel}: protocol.output is required — entry ignored.`);
    return undefined;
  }

  const protocol: CliProtocolConfig = { args, output };

  const stdin = typeof r.stdin === "boolean" ? r.stdin : base?.stdin;
  if (stdin !== undefined) protocol.stdin = stdin;

  const modelRaw = r.model;
  if (modelRaw !== undefined && modelRaw !== null) {
    const m = modelRaw as Record<string, unknown>;
    if (typeof m.flag === "string" && m.flag) {
      protocol.model = { flag: m.flag };
    } else {
      warnings.push(`${routeLabel}: protocol.model set but missing a "flag" string — ignored.`);
    }
  } else if (base?.model) {
    protocol.model = base.model;
  }

  const workingDirRaw = r.working_dir;
  if (workingDirRaw !== undefined && workingDirRaw !== null) {
    const wd = workingDirRaw as Record<string, unknown>;
    if (typeof wd.flag === "string" && wd.flag) {
      protocol.workingDir = { flag: wd.flag };
      const extraArgsWhenSet = stringArrayFrom(wd.extra_args_when_set);
      if (extraArgsWhenSet !== undefined) protocol.workingDir.extraArgsWhenSet = extraArgsWhenSet;
      if (wd.fallback === "home") protocol.workingDir.fallback = "home";
    } else {
      warnings.push(`${routeLabel}: protocol.working_dir set but missing a "flag" string — ignored.`);
    }
  } else if (base?.workingDir) {
    protocol.workingDir = base.workingDir;
  }

  const fileDirsRaw = r.file_dirs;
  if (fileDirsRaw !== undefined && fileDirsRaw !== null) {
    const fd = fileDirsRaw as Record<string, unknown>;
    if (typeof fd.flag === "string" && fd.flag) {
      protocol.fileDirs = { flag: fd.flag };
    } else {
      warnings.push(`${routeLabel}: protocol.file_dirs set but missing a "flag" string — ignored.`);
    }
  } else if (base?.fileDirs) {
    protocol.fileDirs = base.fileDirs;
  }

  const fileListHeader = str(r.file_list_header) ?? base?.fileListHeader;
  if (fileListHeader !== undefined) protocol.fileListHeader = fileListHeader;
  const fileListBullet =
    (typeof r.file_list_bullet === "string" ? r.file_list_bullet : undefined) ?? base?.fileListBullet;
  if (fileListBullet !== undefined) protocol.fileListBullet = fileListBullet;
  const apiKeyEnvVar = str(r.api_key_env_var) ?? base?.apiKeyEnvVar;
  if (apiKeyEnvVar !== undefined) protocol.apiKeyEnvVar = apiKeyEnvVar;

  const safetyRaw = r.safety;
  const safety: Partial<Record<SafetyProfile, string[]>> = { ...base?.safety };
  if (safetyRaw !== null && typeof safetyRaw === "object") {
    for (const profile of SAFETY_PROFILES) {
      const profileArgs = stringArrayFrom((safetyRaw as Record<string, unknown>)[profile]);
      if (profileArgs !== undefined) safety[profile] = profileArgs;
    }
  }
  if (Object.keys(safety).length > 0) protocol.safety = safety;

  if (typeof r.success_requires_output === "boolean") {
    protocol.successRequiresOutput = r.success_requires_output;
  } else if (base?.successRequiresOutput !== undefined) {
    protocol.successRequiresOutput = base.successRequiresOutput;
  }

  const endpointNativeArgsRaw = r.endpoint_native_args;
  if (endpointNativeArgsRaw !== null && typeof endpointNativeArgsRaw === "object") {
    const ena: Partial<Record<EndpointProvider, string[]>> = {};
    for (const [k, v] of Object.entries(endpointNativeArgsRaw as Record<string, unknown>)) {
      const args2 = stringArrayFrom(v);
      if (args2 !== undefined) ena[k as EndpointProvider] = args2;
    }
    if (Object.keys(ena).length > 0) protocol.endpointNativeArgs = ena;
  } else if (base?.endpointNativeArgs) {
    protocol.endpointNativeArgs = base.endpointNativeArgs;
  }

  // Placeholder sanity checks on the FINAL merged args (so `extends:` results
  // are covered too). A typo'd placeholder is the most likely user error in a
  // hand-written protocol, and without these warnings it doesn't just fail
  // silently — it "succeeds": the CLI receives the literal "{{promt}}" token,
  // never receives the prompt, exits 0, and the run reports ok.
  // Matches embedded forms too ("--flag={{prompt}}"), not just whole-token
  // typos — expansion only ever substitutes a token that IS a placeholder,
  // so anything merely containing one goes through literally.
  for (const token of protocol.args) {
    if (token.includes("{{") && !KNOWN_ARG_PLACEHOLDERS.has(token)) {
      warnings.push(
        `${routeLabel}: protocol.args contains unrecognized placeholder "${token}" — it will be ` +
          `passed to the CLI as a literal argument, not substituted. Placeholders only work as ` +
          `a whole standalone argument. Known placeholders: ` +
          `${[...KNOWN_ARG_PLACEHOLDERS].join(", ")}.`,
      );
    }
  }
  if (!protocol.stdin && !protocol.args.includes("{{prompt}}")) {
    warnings.push(
      `${routeLabel}: protocol.args has no {{prompt}} placeholder and stdin is not true — ` +
        `the prompt is never sent to the CLI. Add "{{prompt}}" to args, or set stdin: true.`,
    );
  }

  return protocol;
}

function eventRuleFrom(raw: unknown, label: string, warnings: string[]): CliEventRule | undefined {
  if (raw === null || typeof raw !== "object") {
    warnings.push(`${label}: must be an object — ignored.`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  // "when" is optional — omitted or {} means "matches every line" (e.g. a
  // usage rule that should fire regardless of event type, matching Codex's
  // original unconditional `if (event.usage) {...}` check).
  const whenRaw = r.when ?? {};
  if (whenRaw === null || typeof whenRaw !== "object" || Array.isArray(whenRaw)) {
    warnings.push(`${label}: "when" must be a {field: value} map — ignored.`);
    return undefined;
  }
  const when: Record<string, string> = {};
  for (const [k, v] of Object.entries(whenRaw as Record<string, unknown>)) {
    if (typeof v === "string") when[k] = v;
  }
  const emit = r.emit;
  if (
    emit !== "text" &&
    emit !== "tool_use" &&
    emit !== "thinking" &&
    emit !== "usage" &&
    emit !== "error"
  ) {
    warnings.push(
      `${label}: "emit" must be one of text | tool_use | thinking | usage | error — ignored.`,
    );
    return undefined;
  }
  const rule: CliEventRule = { when, emit };
  const textField = str(r.text_field);
  if (textField !== undefined) rule.textField = textField;
  const nameField = str(r.name_field);
  if (nameField !== undefined) rule.nameField = nameField;
  const inputField = str(r.input_field);
  if (inputField !== undefined) rule.inputField = inputField;
  const chunkField = str(r.chunk_field);
  if (chunkField !== undefined) rule.chunkField = chunkField;
  const inputTokenFields = stringArrayFrom(r.input_token_fields);
  if (inputTokenFields !== undefined) rule.inputTokenFields = inputTokenFields;
  const outputTokenFields = stringArrayFrom(r.output_token_fields);
  if (outputTokenFields !== undefined) rule.outputTokenFields = outputTokenFields;
  const messageField = str(r.message_field);
  if (messageField !== undefined) rule.messageField = messageField;
  return rule;
}

// ---------------------------------------------------------------------------
// Legacy full-format parser (YAML with top-level `services:` key)
// ---------------------------------------------------------------------------

function buildLegacyConfig(raw: Record<string, unknown>): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const rawServices = (raw.services ?? {}) as Record<string, Record<string, unknown>>;
  const warnings: string[] = [];

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
      ...(() => {
        // Declared context size drives router.ts's preferLargeContext boost
        // (not harness name), so a legacy entry that omits these but names
        // a known harness (e.g. antigravity_cli's 2M context) must still
        // inherit them — otherwise the boost silently becomes a no-op.
        const v = typeof svc.max_output_tokens === "number" ? svc.max_output_tokens : harnessDefaults?.maxOutputTokens;
        return v !== undefined ? { maxOutputTokens: v } : {};
      })(),
      ...(() => {
        const v = typeof svc.max_input_tokens === "number" ? svc.max_input_tokens : harnessDefaults?.maxInputTokens;
        return v !== undefined ? { maxInputTokens: v } : {};
      })(),
      ...(() => {
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
          ...(harnessDefaults.effectiveSafety !== undefined
            ? { effectiveSafety: harnessDefaults.effectiveSafety }
            : {}),
          ...(harnessDefaults.models !== undefined ? { models: harnessDefaults.models } : {}),
          ...(harnessDefaults.modelHint !== undefined
            ? { modelHint: harnessDefaults.modelHint }
            : {}),
        };
      })(),
      ...billingFields(svc),
      ...(() => {
        const effectiveSafety = normalizeSafetyProfile(svc.effective_safety);
        return effectiveSafety !== undefined ? { effectiveSafety } : {};
      })(),
      ...(() => {
        const models = stringArrayFrom(svc.models);
        return models !== undefined ? { models } : {};
      })(),
      ...(() => {
        const modelHint = str(svc.model_hint);
        return modelHint !== undefined ? { modelHint } : {};
      })(),
      ...endpointFields(svc, type, str(svc.base_url)),
      ...(typeof svc.timeout_ms === "number" ? { timeoutMs: svc.timeout_ms } : {}),
      ...(() => {
        // Falls back to the named harness's built-in default protocol (if
        // any) when this legacy-format entry doesn't declare its own —
        // same behavior as clis: entries, so `harness: claude_code` here
        // works without repeating the whole protocol block.
        const harnessDefaults = CLI_DEFAULTS[str(svc.harness) ?? ""];
        const protocol =
          protocolFrom(svc.protocol, `services "${name}"`, warnings) ?? harnessDefaults?.protocol;
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
    ...topLevelSettings(raw),
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
    ...(() => {
      const effectiveSafety =
        normalizeSafetyProfile(override.effective_safety) ?? defaults.effectiveSafety;
      return effectiveSafety !== undefined ? { effectiveSafety } : {};
    })(),
    ...(() => {
      const models = stringArrayFrom(override.models) ?? defaults.models;
      return models !== undefined ? { models } : {};
    })(),
    ...(() => {
      const modelHint = str(override.model_hint) ?? defaults.modelHint;
      return modelHint !== undefined ? { modelHint } : {};
    })(),
    ...endpointFields(override, "cli", str(override.base_url)),
    ...(typeof override.timeout_ms === "number" ? { timeoutMs: override.timeout_ms } : {}),
    ...(() => {
      // Falls back to this harness's built-in default (if any) when no
      // override is given, or when the override is malformed — protocolFrom
      // already warned in the latter case; failing the whole route over a
      // typo'd override would be worse than keeping the known-good default.
      const protocol = protocolFrom(override.protocol, `clis "${name}"`, warnings) ?? defaults.protocol;
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
  for (const [harness, defaults] of Object.entries(CLI_DEFAULTS)) {
    // "generic" has no installable binary of its own — it exists only for
    // explicit clis: entries (addClis), never auto-detection.
    if (harness === "generic") continue;
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
      if (protocolFrom(entry.protocol, `clis[${index}] "${name}"`, validation) === undefined) {
        warnings.push(...validation);
        continue;
      }
    }
    services[name] = buildCliServiceConfig(name, defaults, entry, apiKeys, warnings);
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
      ...(typeof ep.timeout_ms === "number" ? { timeoutMs: ep.timeout_ms } : {}),
      ...(typeof ep.max_output_tokens === "number" ? { maxOutputTokens: ep.max_output_tokens } : {}),
      ...(typeof ep.max_input_tokens === "number" ? { maxInputTokens: ep.max_input_tokens } : {}),
      ...(() => {
        const t = thinkingFrom(ep.thinking_level);
        return t !== undefined ? { thinkingLevel: t } : {};
      })(),
      ...(() => {
        const models = stringArrayFrom(ep.models);
        return models !== undefined ? { models } : {};
      })(),
      ...(() => {
        const modelHint = str(ep.model_hint);
        return modelHint !== undefined ? { modelHint } : {};
      })(),
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
  const unsetEnvVars = new Set<string>();
  if (path) {
    try {
      const text = await fs.readFile(path, "utf-8");
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === "object") {
        raw = interpolateTree(parsed as Record<string, unknown>, unsetEnvVars);
      }
    } catch (err: unknown) {
      // File not found -> auto-detect mode. Any other error -> rethrow.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
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
    if (envVarWarning !== undefined) {
      return { ...legacyCfg, configWarnings: [...(legacyCfg.configWarnings ?? []), envVarWarning] };
    }
    return legacyCfg;
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

  if (envVarWarning !== undefined) warnings.push(envVarWarning);
  const cfg: RouterConfig = {
    services,
    disabled,
    ...topLevelSettings(raw),
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
        const effectiveSafety = normalizeSafetyProfile(raw.effective_safety);
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
