import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Dispatcher } from "./dispatchers/base.js";
import type { LeaderboardCache } from "./leaderboard.js";
import type { QuotaCache } from "./quota.js";
import type { Router } from "./router.js";
import type {
  RouteBilling,
  RouteSkip,
  RouterConfig,
  SafetyProfile,
  ServiceConfig,
} from "./types.js";
import { buildRouteBilling } from "./billing.js";
import { effectiveSafetyProfile, requestedSafetyProfile } from "./safety.js";
import { evaluateRoutePolicy } from "./route-policy.js";
import { workspacePolicyFor } from "./workspaces.js";

// ---------------------------------------------------------------------------
// Stale-code detection
// ---------------------------------------------------------------------------

/**
 * This module's own file, and when it was written as this process loaded it.
 *
 * A long-lived MCP server reloads its CONFIG on every call but keeps running
 * the code it started with, and an unreleased rebuild or an upgrade keeps the
 * same version string. So after an update nothing told anyone the server was
 * still on the old code — its `usage` reported routes ready that the freshly
 * built CLI was skipping. Every build and every install rewrites this file,
 * so a newer mtime than the one seen at load means newer code is installed.
 */
const OWN_FILE = fileURLToPath(import.meta.url);
const LOADED_MTIME_MS = mtimeMsOf(OWN_FILE);

function mtimeMsOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A warning when the installed code is newer than what this process runs. */
export function staleCodeWarning(
  file: string = OWN_FILE,
  loadedMtimeMs: number | undefined = LOADED_MTIME_MS,
): string | undefined {
  const now = mtimeMsOf(file);
  if (loadedMtimeMs === undefined || now === undefined || now <= loadedMtimeMs) return undefined;
  return (
    `this server is running older code than is now installed (${path.dirname(file)} was ` +
    `rebuilt or upgraded at ${new Date(now).toISOString()}, after this process started) — ` +
    `restart it to pick up the new build; config changes reload on their own, code does not`
  );
}

// ---------------------------------------------------------------------------
// Model discovery hints
// ---------------------------------------------------------------------------

/**
 * Where to find the authoritative, current model catalog for a route.
 * hints.model routing is unvalidated by this server — a mismatched name is
 * passed straight to the harness and fails at dispatch time with that harness's
 * real error — so these hints let a caller pick a real model up front.
 *
 * The hint is DECLARED CONFIG (`model_hint:` on the route or its harness's
 * shipped-config entry); no per-harness table lives in code. The one structural
 * fallback: OpenAI-compatible endpoints all support GET /models.
 */
/**
 * Replace a private endpoint host with a stable placeholder for output that
 * gets shared.
 *
 * `usage` output, the model-discovery hint and endpoint fetch errors all quote
 * the base_url, so an unredacted private host — a `.ts.net` tailnet name, an
 * internal DNS entry — travels into anything a user pastes into an issue. The
 * scheme, port and path carry all the diagnostic value; the hostname carries
 * none of it and is the only part that identifies infrastructure.
 *
 * Loopback is left intact: "localhost" tells the reader something useful and
 * discloses nothing.
 */
/** The placeholder this function substitutes, and recognises on the way back in. */
const REDACTED_HOST = "<endpoint-host>";

export function redactEndpointHost(baseUrl: string): string {
  // Idempotent, so callers never have to know whether redaction already
  // happened: `https://<endpoint-host>/v1` is not a parseable URL, so a second
  // call would fall to the catch and return the bare `<endpoint>` placeholder,
  // throwing away the scheme, port and path.
  if (baseUrl.includes(REDACTED_HOST)) return baseUrl;
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    // Built as a string rather than by assigning to `url.hostname`: the WHATWG
    // URL setter silently rejects a value containing `<` and `>`, so assigning
    // the placeholder leaves the input verbatim.
    //
    // Userinfo, query and fragment are dropped on every path, loopback
    // included: a key embedded in the URL is a credential wherever the host
    // points.
    const port = url.port === "" ? "" : `:${url.port}`;
    const shown = loopback ? url.hostname : REDACTED_HOST;
    return `${url.protocol}//${shown}${port}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "<endpoint>";
  }
}

/**
 * Remove one secret from text by value.
 *
 * Split/join rather than a regex: a key can contain regex metacharacters, and
 * building a pattern from a credential is how you get a ReDoS or a silent
 * non-match on the one string that mattered.
 */
export function redactSecretValue(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join("<redacted>");
}

/**
 * Strip an endpoint's credential-bearing parts out of TEXT WE DID NOT WRITE.
 *
 * `redactEndpointHost` only cleans a URL a caller hands it. An exception
 * message is a different problem: undici embeds the URL it was given, so
 * wrapping such a message and appending a redacted URL beside it leaves the
 * redacted form sitting next to the raw one — in the terminal AND in
 * `logs/dispatches.jsonl`.
 *
 * Each credential-bearing piece is removed by value, so it does not matter how
 * the message assembled them: the configured api key, then the whole base URL,
 * then origin, hostname, userinfo, and every query value on their own. Pass
 * `apiKey` wherever it is known — for most routes the key is sent as a header
 * and is not part of the URL, so omitting it leaves the commonest credential
 * unscrubbed.
 */
export function scrubEndpointSecrets(
  text: string,
  baseUrl: string,
  apiKey?: string,
): string {
  let out = text;
  const replaceAll = (needle: string, with_: string): void => {
    if (needle.length === 0) return;
    out = out.split(needle).join(with_);
  };
  // The configured key first, and it is NOT part of the URL for most routes —
  // every endpoint in this project's config authenticates with a header. An
  // endpoint that echoes the request HEADER back in its error ("invalid api
  // key: Bearer sk-…") would otherwise pass the key through untouched.
  out = redactSecretValue(out, apiKey);
  replaceAll(baseUrl, redactEndpointHost(baseUrl));
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (url.password) replaceAll(url.password, "<redacted>");
    if (url.username) replaceAll(url.username, "<redacted>");
    for (const value of url.searchParams.values()) replaceAll(value, "<redacted>");
    // A loopback host is not itself a secret and its name is diagnostic, so it
    // stays — the same call redactEndpointHost makes. Everything above is
    // removed on every path, loopback included.
    if (!loopback) {
      replaceAll(url.origin, REDACTED_HOST);
      replaceAll(url.hostname, REDACTED_HOST);
    }
  } catch {
    // Not a parseable URL, so there is nothing further to take out of it than
    // the literal string already replaced above.
  }
  return out;
}

function modelDiscoveryHint(route: {
  type: ServiceConfig["type"];
  modelHint?: string;
  baseUrl?: string;
}): string | undefined {
  if (route.modelHint) return route.modelHint;
  if (route.type === "openai_compatible" && route.baseUrl) {
    // Still redacted here even though buildStatus already did it: this
    // function also runs on route objects a caller assembled itself, and the
    // cost of forgetting is a credential. `redactEndpointHost` is idempotent,
    // so applying it twice is a no-op rather than a degradation.
    return `Standard OpenAI-compatible catalog: GET ${redactEndpointHost(route.baseUrl)}/models`;
  }
  return undefined;
}

export interface RouteStatus {
  id: string;
  harness: string;
  enabled: boolean;
  available: boolean;
  type: ServiceConfig["type"];
  command?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  modelHint?: string;
  leaderboardModel?: string;
  tier: number;
  weight: number;
  cliCapability: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  billing: RouteBilling;
  safetyProfile: SafetyProfile;
  effectiveSafetyProfile: SafetyProfile;
  skipped?: RouteSkip;
  quota: {
    score: number;
    remaining?: number | null;
    limit?: number | null;
    resetAt?: string;
    localCallCount?: number;
    localSuccessCount?: number;
    localFailureCount?: number;
    localRateLimitedCount?: number;
    localInputTokens?: number;
    localOutputTokens?: number;
    source?: string;
  };
  breaker: {
    tripped: boolean;
    failures: number;
    cooldownRemainingSec?: number;
    /**
     * The persisted record exists but could not be parsed, so `tripped` and
     * `failures` below are this process's defaults rather than the route's
     * real state. Set only when that is the case, so its absence keeps
     * meaning what it always meant.
     */
    stateUnreadable?: true;
  };
  quality?: {
    score: number;
    elo?: number;
  };
  lastError?: string;
  workspacePolicy?: NonNullable<ServiceConfig["workspacePolicy"]>;
  endpoint?: {
    mode: NonNullable<ServiceConfig["endpointMode"]>;
    provider?: NonNullable<ServiceConfig["endpointProvider"]>;
    baseUrl?: string;
    wireProtocol?: NonNullable<ServiceConfig["wireProtocol"]>;
  };
}

export interface HarnessDispatchStatus {
  name: "harness-dispatch";
  generatedAt: string;
  routes: RouteStatus[];
  ready: string[];
  skippedRoutes: RouteSkip[];
  /**
   * Config problems that change behaviour. Reported here as well as by
   * `doctor` because `status` is the surface people actually run: a route with
   * a typo'd safety_profile would otherwise show a plain `ok` line while
   * silently running under the looser default.
   */
  configWarnings?: readonly string[];
  /**
   * Saved state that could not be read, for records naming no configured
   * route — a corrupt legacy blob has no route name at all, and a per-route
   * line cannot carry one. Kept apart from `configWarnings` because nothing
   * here was misconfigured or ignored.
   */
  stateWarnings?: readonly string[];
  next?: {
    route: string;
    tier: number;
    model?: string;
    finalScore: number;
    reason: string;
  };
}

export async function buildStatus(
  config: RouterConfig,
  dispatchers: Record<string, Dispatcher>,
  quota: QuotaCache,
  router: Router,
  leaderboard: LeaderboardCache,
): Promise<HarnessDispatchStatus> {
  const quotaStatus = await quota.fullStatus();
  const breakers = router.circuitBreakerStatus();
  // Read after circuitBreakerStatus(), which is what refreshes the store.
  const breakerUnreadable = new Set(router.breakerStateUnreadable());
  const routes: RouteStatus[] = [];
  const skippedRoutes: RouteSkip[] = [];

  for (const [id, svc] of Object.entries(config.services)) {
    const dispatcher = dispatchers[id];
    const available = dispatcher?.isAvailable() ?? false;
    const q = quotaStatus[id];
    const quotaScore = q?.score ?? (await quota.getQuotaScore(id));
    const quality = await leaderboard.getQualityScore(
      svc.leaderboardModel,
      svc.thinkingLevel,
    );

    const effectiveSafety = effectiveSafetyProfile(svc);
    const route: RouteStatus = {
      id,
      harness: svc.harness ?? id,
      enabled: svc.enabled,
      available,
      type: svc.type,
      tier: svc.tier,
      weight: svc.weight,
      cliCapability: svc.cliCapability,
      billing: buildRouteBilling(svc),
      safetyProfile: requestedSafetyProfile(svc),
      effectiveSafetyProfile: effectiveSafety,
      workspacePolicy: workspacePolicyFor(svc, effectiveSafety),
      quota: {
        score: Math.round(quotaScore * 1000) / 1000,
      },
      breaker: {
        ...(breakers[id] ?? { tripped: false, failures: 0 }),
        ...(breakerUnreadable.has(id) ? { stateUnreadable: true as const } : {}),
      },
    };
    const policy = evaluateRoutePolicy(id, svc, {
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      circuitBroken: Boolean(route.breaker.tripped),
      // The same counts the router scores with, so this reports the same
      // verdict. Without them the never-succeeded skip cannot fire here, and a
      // route the router has stopped scoring would still be listed as `ok`.
      localCounts: {
        calls: q?.localCallCount ?? 0,
        successes: q?.localSuccessCount ?? 0,
      },
    });
    if (policy.skipped) {
      route.skipped = policy.skipped;
      skippedRoutes.push(policy.skipped);
    }
    if (svc.command !== undefined) route.command = svc.command;
    // Redacted HERE too, not only in the text rendering and the error paths:
    // `status --json` and the `harness-dispatch://status.json` resource read
    // this payload, and a key in the URL (`?key=…`, which is Google AI
    // Studio's own shape) would otherwise reach both. That resource is one
    // this server's own instructions tell agents to read, so the credential
    // would land in an agent's context.
    if (svc.baseUrl !== undefined) route.baseUrl = redactEndpointHost(svc.baseUrl);
    if (svc.endpointMode !== undefined) {
      route.endpoint = {
        mode: svc.endpointMode,
      };
      if (svc.endpointProvider !== undefined) route.endpoint.provider = svc.endpointProvider;
      if (svc.baseUrl !== undefined) route.endpoint.baseUrl = redactEndpointHost(svc.baseUrl);
      if (svc.wireProtocol !== undefined) route.endpoint.wireProtocol = svc.wireProtocol;
    }
    if (svc.model !== undefined) route.model = svc.model;
    if (svc.models !== undefined) route.models = svc.models;
    if (svc.modelHint !== undefined) route.modelHint = svc.modelHint;
    if (svc.leaderboardModel !== undefined) route.leaderboardModel = svc.leaderboardModel;
    if (svc.maxInputTokens !== undefined) route.maxInputTokens = svc.maxInputTokens;
    if (svc.maxOutputTokens !== undefined) route.maxOutputTokens = svc.maxOutputTokens;
    if (q?.remaining !== undefined) route.quota.remaining = q.remaining;
    if (q?.limit !== undefined) route.quota.limit = q.limit;
    if (q?.resetAt !== undefined && q.resetAt !== null) route.quota.resetAt = q.resetAt;
    if (q?.localCallCount !== undefined) route.quota.localCallCount = q.localCallCount;
    if (q?.localSuccessCount !== undefined) route.quota.localSuccessCount = q.localSuccessCount;
    if (q?.localFailureCount !== undefined) route.quota.localFailureCount = q.localFailureCount;
    if (q?.localRateLimitedCount !== undefined)
      route.quota.localRateLimitedCount = q.localRateLimitedCount;
    if (q?.localInputTokens !== undefined) route.quota.localInputTokens = q.localInputTokens;
    if (q?.localOutputTokens !== undefined) route.quota.localOutputTokens = q.localOutputTokens;
    if (q?.source !== undefined) route.quota.source = q.source;
    route.quality = {
      score: Math.round(quality.qualityScore * 1000) / 1000,
    };
    if (quality.elo !== null) route.quality.elo = Math.round(quality.elo);
    routes.push(route);
  }

  const ready = routes
    .filter((route) => route.enabled && route.available && !route.breaker.tripped && !route.skipped)
    .map((route) => route.id);
  const decision = await router.pickService();
  // An unreadable record whose name is not a configured route has nowhere else
  // to be shown — the per-route line it would appear on does not exist. That is
  // every corrupt legacy blob and any record left by a renamed or removed route.
  //
  // Separate from configWarnings, which means config entries that were ignored:
  // `doctor` and the CLI's "ignored config entries" list both read that field
  // directly, so a lost cooldown filed there would reach them mislabelled.
  //
  // `Object.hasOwn`, not `=== undefined`: a record named `constructor` or
  // `toString` would otherwise match on Object.prototype and suppress its own
  // warning.
  const quotaPersistError = quota.localCountsPersistError();
  const stale = staleCodeWarning();
  const stateWarnings = [
    ...(stale !== undefined ? [stale] : []),
    ...(quotaPersistError !== undefined
      ? [
          `usage counters are not reaching disk (${quotaPersistError}) — the numbers ` +
            `below are this process's only, and reset to zero when it restarts`,
        ]
      : []),
    ...(config.reloadError !== undefined
      ? [
          `config reload FAILED — the file on disk is NOT the config in effect; still routing ` +
            `on the previously loaded one (${config.reloadError})`,
        ]
      : []),
    ...[...breakerUnreadable]
      .filter((name) => !Object.hasOwn(config.services, name))
      .map((name) => `saved breaker state for ${name} is unreadable — a cooldown it held may have been lost`),
  ];
  const status: HarnessDispatchStatus = {
    name: "harness-dispatch",
    generatedAt: new Date().toISOString(),
    routes,
    ready,
    skippedRoutes,
    ...(config.configWarnings && config.configWarnings.length > 0
      ? { configWarnings: [...config.configWarnings] }
      : {}),
    ...(stateWarnings.length > 0 ? { stateWarnings } : {}),
  };
  if (decision) {
    status.next = {
      route: decision.service,
      tier: decision.tier,
      finalScore: Math.round(decision.finalScore * 1000) / 1000,
      reason: decision.reason,
    };
    if (decision.model !== undefined) status.next.model = decision.model;
  }
  return status;
}

export interface RouteUsage {
  id: string;
  enabled: boolean;
  available: boolean;
  ready: boolean;
  tier: number;
  model?: string;
  models?: string[];
  modelHint?: string;
  billingKind: RouteBilling["kind"];
  paidUsagePossible: boolean;
  callCount: number;
  successCount: number;
  failureCount: number;
  /** Calls declined for rate limiting — busy, not broken. Kept out of failureCount. */
  rateLimitedCount: number;
  /**
   * Tokens the harness reported, summed across this route's calls.
   *
   * A measured quantity rather than a currency figure: money is NOT derivable —
   * subscription CLIs have no per-call price, and pricing tokens would mean
   * shipping a rate card that goes stale silently. Zero means the harness
   * reported nothing, not that nothing was spent.
   */
  inputTokens: number;
  outputTokens: number;
  quotaScore: number;
  quotaRemaining?: number;
  quotaLimit?: number;
  quotaResetAt?: string;
  breakerTripped: boolean;
  breakerFailures: number;
  /**
   * Why the router will not choose this route, when it will not.
   *
   * `usage` is the surface an orchestrating agent is told to consult before
   * delegating. Without this, a route the router refuses to score still prints
   * `ok`, and nobody watching it can connect that to nothing ever routing
   * there.
   */
  skipped?: RouteSkip;
}

export interface HarnessDispatchUsage {
  name: "harness-dispatch";
  generatedAt: string;
  routes: RouteUsage[];
  /**
   * The same state problems `status` reports. `usage` is what an orchestrating
   * agent reads before delegating, so a problem that changes what the numbers
   * mean — counters not persisting, a server on stale code — belongs here too.
   */
  warnings?: readonly string[];
}

/** Narrows full status down to just the fields relevant to "how much have I used this?". */
export function buildUsage(status: HarnessDispatchStatus): HarnessDispatchUsage {
  return {
    name: "harness-dispatch",
    generatedAt: status.generatedAt,
    ...(status.stateWarnings && status.stateWarnings.length > 0
      ? { warnings: status.stateWarnings }
      : {}),
    routes: status.routes.map((route) => {
      const usage: RouteUsage = {
        id: route.id,
        enabled: route.enabled,
        available: route.available,
        ready: status.ready.includes(route.id),
        tier: route.tier,
        billingKind: route.billing.kind,
        paidUsagePossible: route.billing.paidUsagePossible,
        callCount: route.quota.localCallCount ?? 0,
        successCount: route.quota.localSuccessCount ?? 0,
        failureCount: route.quota.localFailureCount ?? 0,
        rateLimitedCount: route.quota.localRateLimitedCount ?? 0,
        inputTokens: route.quota.localInputTokens ?? 0,
        outputTokens: route.quota.localOutputTokens ?? 0,
        quotaScore: route.quota.score,
        breakerTripped: route.breaker.tripped,
        breakerFailures: route.breaker.failures,
      };
      if (route.skipped !== undefined) usage.skipped = route.skipped;
      if (route.model !== undefined) usage.model = route.model;
      if (route.models !== undefined) usage.models = route.models;
      const hint = modelDiscoveryHint(route);
      if (hint !== undefined) usage.modelHint = hint;
      if (typeof route.quota.remaining === "number") usage.quotaRemaining = route.quota.remaining;
      if (typeof route.quota.limit === "number") usage.quotaLimit = route.quota.limit;
      if (route.quota.resetAt !== undefined) usage.quotaResetAt = route.quota.resetAt;
      return usage;
    }),
  };
}

/**
 * Skips that hold whatever the next call asks for.
 *
 * The listing surfaces have no request in hand, so they evaluate policy with no
 * safety profile, task type or route policy — and several skip codes answer a
 * question that was never asked. `safety_incompatible` is the one that bites:
 * cursor_cli declares full_auto, which exceeds the DEFAULT requested profile,
 * so marking it skipped would call a route broken that a full_auto dispatch
 * uses successfully. The mark therefore reflects only codes that are a property
 * of the route or its environment; every skip still prints its reason on the
 * line below — the reason is information, the mark is a verdict.
 */
const UNCONDITIONAL_SKIPS: ReadonlySet<RouteSkip["code"]> = new Set([
  "disabled",
  "no_dispatcher",
  "unavailable",
  "circuit_broken",
  "credential_unset",
  "never_succeeded",
  "unknown_billing",
  "paid_blocked",
]);

function routeMark(route: {
  enabled: boolean;
  available: boolean;
  skipped?: RouteSkip;
}): "ok" | "off" | "skip" {
  if (!route.enabled || !route.available) return "off";
  if (route.skipped && UNCONDITIONAL_SKIPS.has(route.skipped.code)) return "skip";
  return "ok";
}

export function renderUsageText(usage: HarnessDispatchUsage): string {
  const lines: string[] = ["harness-dispatch usage", ""];
  // First, not last: these change how every number below should be read.
  for (const w of usage.warnings ?? []) lines.push(`! ${w}`);
  if (usage.warnings && usage.warnings.length > 0) lines.push("");
  if (usage.routes.length === 0) {
    // A bare header and nothing else reads as "this command is broken", which
    // is the one thing it does not mean — and it is the first thing a user
    // with no routes sees.
    lines.push(
      "No routes configured.",
      "",
      "Install a harness CLI (claude, codex, cursor-agent, agy) and it is picked",
      "up automatically, or add an `endpoints:` entry to config.yaml — those need",
      "no CLI. `harness-dispatch doctor` says which of the two applies here.",
      "",
    );
    return lines.join("\n");
  }
  for (const route of usage.routes) {
    const mark = routeMark(route);
    const quota =
      route.quotaRemaining !== undefined && route.quotaLimit !== undefined
        ? `${route.quotaRemaining}/${route.quotaLimit}`
        : `${Math.round(route.quotaScore * 100)}%`;
    lines.push(
      `${mark} ${route.id}${route.model ? ` (${route.model})` : ""} — calls=${route.callCount} ` +
        `success=${route.successCount} failed=${route.failureCount}` +
        (route.rateLimitedCount ? ` rate_limited=${route.rateLimitedCount}` : "") +
        ` quota=${quota} ` +
        `billing=${route.billingKind} breaker=${route.breakerTripped ? "open" : "closed"}`,
    );
    // Omitted when both are zero: a harness that reports nothing would
    // otherwise print "tokens: in=0 out=0" and read as "nothing was spent",
    // which is a different claim.
    if (route.inputTokens > 0 || route.outputTokens > 0) {
      lines.push(`  tokens: in=${fmtTokens(route.inputTokens)} out=${fmtTokens(route.outputTokens)}`);
    }
    if (route.skipped) lines.push(`  skipped=${route.skipped.code}: ${route.skipped.message}`);
    if (route.modelHint) lines.push(`  models: ${route.modelHint}`);
  }
  return lines.join("\n");
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export function renderStatusText(status: HarnessDispatchStatus): string {
  const lines: string[] = [];
  lines.push("harness-dispatch status", "");
  for (const route of status.routes) {
    const mark = routeMark(route);
    // `leaderboard_model` is a SCORING key, not what gets dispatched. Showing
    // it bare as `model=` makes status and usage disagree, so it is marked
    // when it is the scoring key standing in.
    const model =
      route.model ?? (route.leaderboardModel ? `${route.leaderboardModel} (scoring key; no model set)` : "not set");
    lines.push(`${mark} ${route.id} / ${route.harness}`);
    lines.push(
      `  billing=${route.billing.kind} provider=${route.billing.provider} auth=${route.billing.authSource}`,
    );
    lines.push(
      `  paid=${route.billing.paidUsagePossible ? "possible" : "no"} allow_paid=${
        route.billing.allowPaidUsage ? "yes" : "no"
      } safety=${route.effectiveSafetyProfile} tier=${route.tier} model=${model}`,
    );
    lines.push(
      `  quota=${Math.round(route.quota.score * 100)}% breaker=${
        route.breaker.tripped ? "open" : "closed"
      } failures=${route.breaker.failures}` +
        // Appended rather than replacing `closed`, so the reader sees both
        // what this process is acting on and that it is not to be trusted.
        (route.breaker.stateUnreadable ? " (saved breaker state unreadable — may be stale)" : ""),
    );
    lines.push(
      `  calls=${route.quota.localCallCount ?? 0} success=${
        route.quota.localSuccessCount ?? 0
      } failed=${route.quota.localFailureCount ?? 0}` +
        // Shown separately, and only when non-zero, because a busy route is
        // not a broken one. Folded into `failed`, they tell a reader — and an
        // orchestrating agent choosing where to delegate — that a healthy
        // route is unreliable.
        (route.quota.localRateLimitedCount
          ? ` rate_limited=${route.quota.localRateLimitedCount}`
          : ""),
    );
    lines.push(
      `  context=${fmtTokens(route.maxInputTokens)} output=${fmtTokens(route.maxOutputTokens)}`,
    );
    if (route.endpoint) {
      lines.push(
        `  endpoint=${route.endpoint.mode}/${route.endpoint.provider ?? "unknown"} protocol=${
          route.endpoint.wireProtocol ?? "unknown"
        }`,
      );
    }
    if (route.workspacePolicy) lines.push(`  workspace=${route.workspacePolicy}`);
    if (route.billing.notes) lines.push(`  note: ${route.billing.notes}`);
    if (route.skipped) lines.push(`  skipped=${route.skipped.code}: ${route.skipped.message}`);
    lines.push("");
  }
  if (status.configWarnings && status.configWarnings.length > 0) {
    lines.push(
      `Config warnings (${status.configWarnings.length}) — these change behaviour:`,
    );
    for (const w of status.configWarnings) lines.push(`  ! ${w}`);
    lines.push("");
  }
  if (status.stateWarnings && status.stateWarnings.length > 0) {
    lines.push(`State problems (${status.stateWarnings.length}) — not what they look like:`);
    for (const w of status.stateWarnings) lines.push(`  ! ${w}`);
    lines.push("");
  }
  lines.push(`Ready to route: ${status.ready.length ? status.ready.join(", ") : "none"}`);
  if (status.routes.length === 0) {
    // status is the command people reach for first, so it carries the same
    // empty-state guidance doctor gives.
    lines.push(
      "",
      "No routes configured. Install a harness CLI (claude, codex, cursor-agent, agy)",
      "and they are detected automatically, or add one to config.yaml.",
      "Run `harness-dispatch doctor` for a fuller check.",
    );
  }
  if (status.next) {
    lines.push(
      `Next pick: ${status.next.route} (tier ${status.next.tier}, score ${status.next.finalScore})`,
    );
  }
  return lines.join("\n");
}
