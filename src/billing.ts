import type {
  AuthSource,
  BillingConfidence,
  BillingKind,
  BillingProvider,
  BillingSurface,
  RouteBilling,
  ServiceConfig,
} from "./types.js";

const ANTHROPIC_AGENT_SDK_CREDIT_START = Date.UTC(2026, 5, 15);

function isLoopback(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("::1")
  );
}

function isKnownLocalRuntime(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return (
    baseUrl.includes("localhost:11434") ||
    baseUrl.includes("127.0.0.1:11434") ||
    baseUrl.includes("localhost:1234") ||
    baseUrl.includes("127.0.0.1:1234")
  );
}

function providerFromService(svc: ServiceConfig): BillingProvider {
  if (svc.provider) return svc.provider;
  const harness = svc.harness ?? svc.name;
  if (harness === "claude_code") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "cursor") return "cursor";
  if (harness === "antigravity_cli" || harness === "antigravity") {
    return "google";
  }
  if (svc.type === "openai_compatible" && isKnownLocalRuntime(svc.baseUrl)) return "local";
  if (svc.baseUrl?.includes("api.openai.com")) return "openai";
  return "custom";
}

function surfaceFromService(svc: ServiceConfig): BillingSurface {
  if (svc.surface) return svc.surface;
  const harness = svc.harness ?? svc.name;
  if (harness === "claude_code") return "claude_agent_sdk";
  if (harness === "codex") return "codex_cli";
  if (harness === "cursor") return "cursor_agent_cli";
  if (harness === "antigravity_cli" || harness === "antigravity") {
    return "antigravity_cli";
  }
  if (svc.type === "openai_compatible") {
    if (svc.baseUrl?.includes("api.openai.com")) return "openai_api";
    if (isKnownLocalRuntime(svc.baseUrl)) return "local_endpoint";
    return "openai_compatible";
  }
  return "custom";
}

function authSourceFromService(svc: ServiceConfig, surface: BillingSurface): AuthSource {
  if (svc.authSource) return svc.authSource;
  if (svc.apiKey) return "api_key";
  if (surface === "local_endpoint") return "local_network";
  if (svc.type === "openai_compatible") return "configured_endpoint";
  if (surface === "claude_agent_sdk") return "oauth_session";
  if (
    surface === "codex_cli" ||
    surface === "cursor_agent_cli" ||
    surface === "antigravity_cli"
  ) {
    return "product_login";
  }
  return "unknown";
}

function inferredKind(
  svc: ServiceConfig,
  surface: BillingSurface,
  authSource: AuthSource,
  now: Date,
): BillingKind {
  if (svc.billingKind) return svc.billingKind;
  if (authSource === "api_key") return "metered_api";
  switch (surface) {
    case "claude_agent_sdk":
    case "claude_code":
      return now.getTime() >= ANTHROPIC_AGENT_SDK_CREDIT_START
        ? "included_credit_then_optional_overage"
        : "included_plan_usage";
    case "codex_cli":
    case "codex_sdk":
      return "included_plan_then_flexible_credits";
    case "cursor_agent_cli":
      return "included_usage_then_on_demand";
    case "antigravity_cli":
      return "free_quota";
    case "local_endpoint":
      return "local_compute";
    case "openai_api":
    case "anthropic_api":
    case "gemini_api":
    case "vertex_ai":
      return "metered_api";
    case "openai_compatible":
      return isLoopback(svc.baseUrl) ? "unknown" : "metered_api";
    case "custom":
      return "unknown";
  }
}

function inferredConfidence(
  svc: ServiceConfig,
  surface: BillingSurface,
  kind: BillingKind,
): BillingConfidence {
  if (svc.billingConfidence) return svc.billingConfidence;
  if (kind === "unknown") return "unknown";
  if (surface === "openai_compatible" && isLoopback(svc.baseUrl)) return "unknown";
  if (surface === "custom") return "unknown";
  if (surface === "cursor_agent_cli" && svc.authSource === "api_key") return "inferred";
  return "documented";
}

/**
 * Whether a route can incur a REAL charge with no further action from the
 * user, by default — i.e. whether harness-router should block it until
 * explicitly allowed.
 *
 * "included_X_then_optional_Y" kinds (Codex flexible credits, Claude usage
 * credits, Cursor on-demand) are NOT blocked by default: researched across
 * Anthropic, OpenAI, and Cursor (2026-07), all three hard-stop at the
 * included cap by default — continuing past it requires the user to have
 * ALREADY completed a separate, deliberate opt-in on the PROVIDER's own
 * side (enabling usage credits/flexible pricing/on-demand billing, usually
 * with its own payment method and spend limit). harness-router blocking
 * these by default would just be re-gating something the provider already
 * gates, and asking every user to prove a negative ("I haven't opted into
 * my provider's overage") for a state that's off by default anyway.
 *
 * A user who HAS enabled provider-side overage can still restore the block
 * by setting `paid_usage_possible: true` explicitly in that route's config
 * — the override in buildRouteBilling() takes precedence over this
 * function. Only kinds with no such provider-side backstop — metered_api
 * (raw API keys bill from the first token, no included pool at all) and
 * unknown (no data to reason about) — are blocked by default here.
 */
function inferredPaidUsagePossible(kind: BillingKind): boolean {
  switch (kind) {
    case "local_compute":
    case "included_plan_usage":
    case "free_quota":
    case "included_plan_then_flexible_credits":
    case "included_credit_then_optional_overage":
    case "included_usage_then_on_demand":
      return false;
    case "metered_api":
    case "unknown":
      return true;
  }
}

function defaultNotes(
  svc: ServiceConfig,
  surface: BillingSurface,
  kind: BillingKind,
  now: Date,
): string | undefined {
  if (svc.billingNotes) return svc.billingNotes;
  if (surface === "claude_agent_sdk" && now.getTime() < ANTHROPIC_AGENT_SDK_CREDIT_START) {
    return "Claude -p moves to Agent SDK credit behavior on 2026-06-15.";
  }
  if (surface === "openai_compatible" && isLoopback(svc.baseUrl) && kind === "unknown") {
    return "Loopback endpoint is not assumed local unless configured as a known local runtime.";
  }
  return undefined;
}

export function buildRouteBilling(
  svc: ServiceConfig,
  opts: { now?: Date } = {},
): RouteBilling {
  const now = opts.now ?? new Date();
  const provider = providerFromService(svc);
  const surface = surfaceFromService(svc);
  const authSource = authSourceFromService(svc, surface);
  const kind = inferredKind(svc, surface, authSource, now);
  const confidence = inferredConfidence(svc, surface, kind);
  const paidUsagePossible = svc.paidUsagePossible ?? inferredPaidUsagePossible(kind);
  const billing: RouteBilling = {
    provider,
    surface,
    authSource,
    kind,
    paidUsagePossible,
    allowPaidUsage: svc.allowPaidUsage ?? false,
    paidUsageRequiresOptIn: paidUsagePossible ? true : false,
    confidence,
  };
  const notes = defaultNotes(svc, surface, kind, now);
  if (notes !== undefined) billing.notes = notes;
  return billing;
}

export function billingIsUnknown(billing: RouteBilling): boolean {
  return billing.kind === "unknown" || billing.confidence === "unknown";
}

export function billingIsBlocked(billing: RouteBilling): boolean {
  if (billingIsUnknown(billing)) return !billing.allowPaidUsage;
  if (billing.paidUsagePossible) return !billing.allowPaidUsage;
  return false;
}
