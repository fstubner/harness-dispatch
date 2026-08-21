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
// Model discovery hints
// ---------------------------------------------------------------------------

/**
 * Where to find the authoritative, current model catalog for a route.
 * hints.model routing is unvalidated by this server — a mismatched or
 * unsupported name is passed straight to the harness and fails at dispatch
 * time with that harness's real error, so these hints let a caller pick a
 * real model up front or self-correct after a failure.
 *
 * The hint itself is DECLARED CONFIG (`model_hint:` on the route or its
 * harness's shipped-config entry) — no per-harness table lives in code. The
 * one structural fallback: OpenAI-compatible endpoints all support the
 * standard GET /models catalog, hint or no hint.
 */
/**
 * Replace a private endpoint host with a stable placeholder for output that
 * gets shared.
 *
 * `usage` output, the model-discovery hint and endpoint fetch errors all
 * quoted the full base_url, so a private host — a `.ts.net` tailnet name, an
 * internal DNS entry — travelled into anything a user pastes into an issue.
 * The scheme, port and path carry all the diagnostic value; the hostname
 * carries none of it and is the only part that identifies infrastructure.
 *
 * Loopback is left intact: "localhost" tells the reader something useful and
 * discloses nothing.
 */
export function redactEndpointHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return baseUrl;
    url.hostname = "<endpoint-host>";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "<endpoint>";
  }
}

function modelDiscoveryHint(route: {
  type: ServiceConfig["type"];
  modelHint?: string;
  baseUrl?: string;
}): string | undefined {
  if (route.modelHint) return route.modelHint;
  if (route.type === "openai_compatible" && route.baseUrl) {
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
   * Config problems that change behaviour. `doctor` reported these and
   * `status` did not, so a route with a typo'd safety_profile showed a plain
   * `ok` line while silently running under the looser default — and `status`
   * is the surface people actually run.
   */
  configWarnings?: readonly string[];
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
      breaker: breakers[id] ?? { tripped: false, failures: 0 },
    };
    const policy = evaluateRoutePolicy(id, svc, {
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      circuitBroken: Boolean(route.breaker.tripped),
    });
    if (policy.skipped) {
      route.skipped = policy.skipped;
      skippedRoutes.push(policy.skipped);
    }
    if (svc.command !== undefined) route.command = svc.command;
    if (svc.baseUrl !== undefined) route.baseUrl = svc.baseUrl;
    if (svc.endpointMode !== undefined) {
      route.endpoint = {
        mode: svc.endpointMode,
      };
      if (svc.endpointProvider !== undefined) route.endpoint.provider = svc.endpointProvider;
      if (svc.baseUrl !== undefined) route.endpoint.baseUrl = svc.baseUrl;
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
  const status: HarnessDispatchStatus = {
    name: "harness-dispatch",
    generatedAt: new Date().toISOString(),
    routes,
    ready,
    skippedRoutes,
    ...(config.configWarnings && config.configWarnings.length > 0
      ? { configWarnings: [...config.configWarnings] }
      : {}),
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
   * The honest answer to "what has this cost me": a measured quantity rather
   * than a currency figure. Money is NOT derivable — subscription CLIs have no
   * per-call price, and pricing tokens would mean shipping a rate card that
   * goes stale silently. Zero means the harness reported nothing, not that
   * nothing was spent.
   */
  inputTokens: number;
  outputTokens: number;
  quotaScore: number;
  quotaRemaining?: number;
  quotaLimit?: number;
  quotaResetAt?: string;
  breakerTripped: boolean;
  breakerFailures: number;
}

export interface HarnessDispatchUsage {
  name: "harness-dispatch";
  generatedAt: string;
  routes: RouteUsage[];
}

/** Narrows full status down to just the fields relevant to "how much have I used this?". */
export function buildUsage(status: HarnessDispatchStatus): HarnessDispatchUsage {
  return {
    name: "harness-dispatch",
    generatedAt: status.generatedAt,
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

export function renderUsageText(usage: HarnessDispatchUsage): string {
  const lines: string[] = ["harness-dispatch usage", ""];
  for (const route of usage.routes) {
    const mark = route.available && route.enabled ? "ok" : "off";
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
    // Tokens were reaching `usage --json` and the MCP tool but never the text
    // output a human reads, so the one surface people actually type at was the
    // one that never showed them. Omitted when both are zero: a harness that
    // reports nothing would otherwise print "tokens: in=0 out=0" and read as
    // "nothing was spent", which is a different claim.
    if (route.inputTokens > 0 || route.outputTokens > 0) {
      lines.push(`  tokens: in=${fmtTokens(route.inputTokens)} out=${fmtTokens(route.outputTokens)}`);
    }
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
    const mark = route.available && route.enabled ? "ok" : "off";
    // `leaderboard_model` is a SCORING key, not what gets dispatched. Showing
    // it bare as `model=` made status and usage disagree — against this repo's
    // own config.yaml, status read `model=zzz-no-such-model-force-fallback-tier`
    // while usage showed no model for the same route. Marked when it is the
    // scoring key standing in, so the two surfaces no longer give two answers.
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
      } failures=${route.breaker.failures}`,
    );
    lines.push(
      `  calls=${route.quota.localCallCount ?? 0} success=${
        route.quota.localSuccessCount ?? 0
      } failed=${route.quota.localFailureCount ?? 0}` +
        // Shown separately, and only when non-zero, because a busy route is
        // not a broken one. Folding these into `failed` told a reader — and an
        // orchestrating agent choosing where to delegate — that a healthy
        // route was unreliable.
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
  lines.push(`Ready to route: ${status.ready.length ? status.ready.join(", ") : "none"}`);
  if (status.routes.length === 0) {
    // doctor has a good empty state; status had none, and status is the
    // command people reach for first.
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
