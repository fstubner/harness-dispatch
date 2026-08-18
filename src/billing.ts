import type {
  AuthSource,
  BillingConfidence,
  BillingKind,
  BillingProvider,
  BillingSurface,
  RouteBilling,
  ServiceConfig,
} from "./types.js";

/**
 * Parse a base_url into (hostname, port), or undefined if it isn't a URL.
 *
 * Both predicates below used `String.includes`, which is not a host check:
 * `https://evil.example.com/proxy?upstream=localhost:11434/v1` contains
 * "localhost:11434" and so classified as free local compute — provider
 * "local", kind "local_compute", paidUsagePossible false. That also exempted
 * it from the caller-supplied `local_only` and `approval_required` policies,
 * because route-policy.ts's isLocalRoute ORs those same four fields.
 *
 * Requires a hostile or mistaken config entry, so it is not remotely
 * triggerable — but "is this host local" is exactly the question a substring
 * cannot answer. config.ts:inferEndpointProvider already did this correctly;
 * this is the same approach applied to the two predicates that did not.
 */
function hostOf(baseUrl: string | undefined): { host: string; port: string } | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return { host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(baseUrl: string | undefined): boolean {
  const parsed = hostOf(baseUrl);
  return parsed !== undefined && LOOPBACK_HOSTS.has(parsed.host);
}

/** Ollama (11434) and LM Studio (1234) on loopback — the two runtimes we can name. */
function isKnownLocalRuntime(baseUrl: string | undefined): boolean {
  const parsed = hostOf(baseUrl);
  if (parsed === undefined || !LOOPBACK_HOSTS.has(parsed.host)) return false;
  return parsed.port === "11434" || parsed.port === "1234";
}

// NOTE: no harness-name special cases here. Built-in harnesses declare
// provider/surface/auth_source/billing_kind in the shipped config.default.yaml,
// and config.ts copies those onto every route built from them — by the time a
// ServiceConfig reaches this file, its billing identity is declared data.
// The fallbacks below are structural inference only (endpoint type, base_url
// shape), for entries that declare nothing.

function providerFromService(svc: ServiceConfig): BillingProvider {
  if (svc.provider) return svc.provider;
  if (svc.type === "openai_compatible" && isKnownLocalRuntime(svc.baseUrl)) return "local";
  if (svc.baseUrl?.includes("api.openai.com")) return "openai";
  return "custom";
}

function surfaceFromService(svc: ServiceConfig): BillingSurface {
  if (svc.surface) return svc.surface;
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
): BillingKind {
  if (svc.billingKind) return svc.billingKind;
  if (authSource === "api_key") return "metered_api";
  switch (surface) {
    case "claude_agent_sdk":
    case "claude_code":
      // Anthropic announced a separate Agent SDK credit pool for claude -p
      // (2026-06-15) but PAUSED the change on launch day, before it took
      // effect — as of 2026-07, programmatic and interactive Claude Code
      // usage still draw from the same subscription pool. Reclassify to
      // included_credit_then_optional_overage only if/when Anthropic
      // actually ships the split (verify against
      // https://support.claude.com/en/articles/15036540 first).
      return "included_plan_usage";
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
  // An explicit billing_kind in the route's config IS documentation — the
  // operator declared it. Without this, a custom/loopback route stays
  // confidence-unknown (and therefore blocked by billingIsUnknown) even
  // after the operator does exactly what the docs tell them to do.
  if (svc.billingKind) return "documented";
  if (surface === "openai_compatible" && isLoopback(svc.baseUrl)) return "unknown";
  if (surface === "custom") return "unknown";
  if (surface === "cursor_agent_cli" && svc.authSource === "api_key") return "inferred";
  return "documented";
}

/**
 * Whether a route can incur a REAL charge with no further action from the
 * user, by default — i.e. whether harness-dispatch should block it until
 * explicitly allowed.
 *
 * "included_X_then_optional_Y" kinds (Codex flexible credits, Claude usage
 * credits, Cursor on-demand) are NOT blocked by default: researched across
 * Anthropic, OpenAI, and Cursor (2026-07), all three hard-stop at the
 * included cap by default — continuing past it requires the user to have
 * ALREADY completed a separate, deliberate opt-in on the PROVIDER's own
 * side (enabling usage credits/flexible pricing/on-demand billing, usually
 * with its own payment method and spend limit). harness-dispatch blocking
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
export function inferredPaidUsagePossible(kind: BillingKind): boolean {
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
): string | undefined {
  if (svc.billingNotes) return svc.billingNotes;
  if (surface === "claude_agent_sdk" || surface === "claude_code") {
    // The genuinely useful operational fact for this route: dispatched jobs
    // compete with the user's own interactive Claude Code sessions.
    return (
      "claude -p draws from the same subscription usage pool as interactive " +
      "Claude Code (Anthropic's announced 2026-06-15 Agent SDK credit split " +
      "was paused before taking effect)."
    );
  }
  if (surface === "openai_compatible" && isLoopback(svc.baseUrl) && kind === "unknown") {
    return "Loopback endpoint is not assumed local unless configured as a known local runtime.";
  }
  return undefined;
}

/**
 * Classification is date-independent by construction.
 *
 * This took an `opts.now` that was threaded into inferredKind/defaultNotes
 * and used by neither — a leftover from when the Agent SDK credit split was
 * expected to change classification on 2026-06-15. Anthropic paused that on
 * launch day, the date logic was removed, and the parameter stayed behind
 * implying a time dependency that no longer exists.
 */
export function buildRouteBilling(svc: ServiceConfig): RouteBilling {
  const provider = providerFromService(svc);
  const surface = surfaceFromService(svc);
  const authSource = authSourceFromService(svc, surface);
  const kind = inferredKind(svc, surface, authSource);
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
  const notes = defaultNotes(svc, surface, kind);
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
