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
 * Where to find the authoritative, current model catalog for a CLI harness.
 * hints.model routing is unvalidated by this server — a mismatched or
 * unsupported name is passed straight to the harness and fails at dispatch
 * time with that harness's real error (see router.ts: the router no longer
 * silently discards a requested model just because it doesn't match a
 * statically configured one). These are public-documentation pointers so a
 * caller can pick a real model up front or self-correct after a failure,
 * verified reachable and current as of 2026-07-14 — not a guarantee that a
 * specific local CLI install supports everything listed there yet.
 */
const CLI_MODEL_DISCOVERY_HINT: Record<string, string> = {
  claude_code:
    "Anthropic model family only. Current model ids: " +
    "https://platform.claude.com/docs/en/docs/about-claude/models/overview " +
    "(e.g. claude-opus-4-8, claude-sonnet-5) — the installed claude CLI may lag " +
    "behind what's newly listed there.",
  codex:
    "OpenAI/Codex model family only. Current model ids: " +
    "https://developers.openai.com/api/docs/models (e.g. gpt-5.6-sol, gpt-5.6-terra) " +
    "— the installed codex CLI may lag behind what's newly listed there.",
  cursor:
    "Wide multi-vendor catalog. Current model ids and pricing across providers: " +
    "https://cursor.com/docs/models — or run `cursor-agent --list-models` for what's " +
    "actually available on this install.",
  antigravity_cli:
    "Cross-vendor catalog (Gemini plus some Claude/GPT-OSS models). Gemini's portion " +
    "is documented at https://ai.google.dev/gemini-api/docs/models; the rest of " +
    "Antigravity's catalog and exact --model support aren't independently verified " +
    "here — check the agy CLI's own docs.",
};

function modelDiscoveryHint(route: {
  type: ServiceConfig["type"];
  harness?: string;
  baseUrl?: string;
}): string | undefined {
  if (route.type === "cli" && route.harness) {
    return CLI_MODEL_DISCOVERY_HINT[route.harness];
  }
  if (route.type === "openai_compatible" && route.baseUrl) {
    return `Standard OpenAI-compatible catalog: GET ${route.baseUrl.replace(/\/+$/, "")}/models`;
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

export interface HarnessRouterStatus {
  name: "harness-router";
  generatedAt: string;
  routes: RouteStatus[];
  ready: string[];
  skippedRoutes: RouteSkip[];
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
): Promise<HarnessRouterStatus> {
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
    if (svc.leaderboardModel !== undefined) route.leaderboardModel = svc.leaderboardModel;
    if (svc.maxInputTokens !== undefined) route.maxInputTokens = svc.maxInputTokens;
    if (svc.maxOutputTokens !== undefined) route.maxOutputTokens = svc.maxOutputTokens;
    if (q?.remaining !== undefined) route.quota.remaining = q.remaining;
    if (q?.limit !== undefined) route.quota.limit = q.limit;
    if (q?.resetAt !== undefined && q.resetAt !== null) route.quota.resetAt = q.resetAt;
    if (q?.localCallCount !== undefined) route.quota.localCallCount = q.localCallCount;
    if (q?.localSuccessCount !== undefined) route.quota.localSuccessCount = q.localSuccessCount;
    if (q?.localFailureCount !== undefined) route.quota.localFailureCount = q.localFailureCount;
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
  const status: HarnessRouterStatus = {
    name: "harness-router",
    generatedAt: new Date().toISOString(),
    routes,
    ready,
    skippedRoutes,
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
  modelHint?: string;
  billingKind: RouteBilling["kind"];
  paidUsagePossible: boolean;
  callCount: number;
  successCount: number;
  failureCount: number;
  quotaScore: number;
  quotaRemaining?: number;
  quotaLimit?: number;
  quotaResetAt?: string;
  breakerTripped: boolean;
  breakerFailures: number;
}

export interface HarnessRouterUsage {
  name: "harness-router";
  generatedAt: string;
  routes: RouteUsage[];
}

/** Narrows full status down to just the fields relevant to "how much have I used this?". */
export function buildUsage(status: HarnessRouterStatus): HarnessRouterUsage {
  return {
    name: "harness-router",
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
        quotaScore: route.quota.score,
        breakerTripped: route.breaker.tripped,
        breakerFailures: route.breaker.failures,
      };
      if (route.model !== undefined) usage.model = route.model;
      const hint = modelDiscoveryHint(route);
      if (hint !== undefined) usage.modelHint = hint;
      if (typeof route.quota.remaining === "number") usage.quotaRemaining = route.quota.remaining;
      if (typeof route.quota.limit === "number") usage.quotaLimit = route.quota.limit;
      if (route.quota.resetAt !== undefined) usage.quotaResetAt = route.quota.resetAt;
      return usage;
    }),
  };
}

export function renderUsageText(usage: HarnessRouterUsage): string {
  const lines: string[] = ["harness-router usage", ""];
  for (const route of usage.routes) {
    const mark = route.available && route.enabled ? "ok" : "off";
    const quota =
      route.quotaRemaining !== undefined && route.quotaLimit !== undefined
        ? `${route.quotaRemaining}/${route.quotaLimit}`
        : `${Math.round(route.quotaScore * 100)}%`;
    lines.push(
      `${mark} ${route.id}${route.model ? ` (${route.model})` : ""} — calls=${route.callCount} ` +
        `success=${route.successCount} failed=${route.failureCount} quota=${quota} ` +
        `billing=${route.billingKind} breaker=${route.breakerTripped ? "open" : "closed"}`,
    );
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

export function renderStatusText(status: HarnessRouterStatus): string {
  const lines: string[] = [];
  lines.push("harness-router status", "");
  for (const route of status.routes) {
    const mark = route.available && route.enabled ? "ok" : "off";
    const model = route.model ?? route.leaderboardModel ?? "model unknown";
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
      } failed=${route.quota.localFailureCount ?? 0}`,
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
    if (route.skipped) lines.push(`  skipped=${route.skipped.code}: ${route.skipped.message}`);
    lines.push("");
  }
  lines.push(`Ready to route: ${status.ready.length ? status.ready.join(", ") : "none"}`);
  if (status.next) {
    lines.push(
      `Next pick: ${status.next.route} (tier ${status.next.tier}, score ${status.next.finalScore})`,
    );
  }
  return lines.join("\n");
}
