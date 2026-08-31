import { billingIsBlocked, billingIsUnknown, buildRouteBilling } from "./billing.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { effectiveSafetyProfile, safetyProfileCompatible } from "./safety.js";
import type {
  RouteBilling,
  RoutePolicy,
  RouteSkip,
  SafetyProfile,
  ServiceConfig,
} from "./types.js";

export interface RoutePolicyResult {
  blocked: boolean;
  skipped?: RouteSkip;
}

export function evaluateRoutePolicy(
  route: string,
  svc: ServiceConfig,
  opts: {
    dispatcher?: Dispatcher;
    circuitBroken?: boolean;
    requestedSafetyProfile?: SafetyProfile;
    routePolicy?: RoutePolicy;
  } = {},
): RoutePolicyResult {
  if (!svc.enabled) {
    return skip(route, "disabled", "route is disabled");
  }
  if (!opts.dispatcher) {
    return skip(route, "no_dispatcher", "no dispatcher is registered for this route");
  }
  if (!opts.dispatcher.isAvailable()) {
    return skip(route, "unavailable", "required command or endpoint is unavailable");
  }
  if (opts.circuitBroken) {
    return skip(route, "circuit_broken", "route circuit breaker is open");
  }

  const billing = buildRouteBilling(svc);
  const routePolicy = evaluateOperationalRoutePolicy(route, billing, opts.routePolicy);
  if (routePolicy.blocked) return routePolicy;

  if (
    billingIsUnknown(billing) &&
    !isIncludedOrLocalRoute(billing) &&
    !billing.allowPaidUsage
  ) {
    // Two different conditions reach here and they need different words.
    // `billingIsUnknown` is true when the KIND is unknown OR the CONFIDENCE
    // is. Saying "billing source is unknown" for both told an operator that
    // about a route `status` prints as `billing=metered_api` — the kind is
    // known perfectly well; what is unknown is how sure we are of it. An
    // acceptance pass caught the two surfaces contradicting each other.
    const why =
      billing.kind === "unknown"
        ? "billing source is unknown"
        : `billing is recorded as ${billing.kind} but its confidence is unknown`;
    return skip(
      route,
      "unknown_billing",
      `${why} and paid usage is not allowed — this is a config-level ` +
        `block, not an availability problem; the operator must add \`allow_paid_usage: true\` ` +
        `to '${route}' in config.yaml to enable it`,
    );
  }
  if (billingIsBlocked(billing)) {
    return skip(
      route,
      "paid_blocked",
      // Two different fixes, and recommending only the permissive one is a
      // steer in the wrong direction. If the route genuinely CANNOT cost money
      // (a local runtime, a subscription CLI), the correct change is
      // `paid_usage_possible: false` — saying so truthfully. `allow_paid_usage:
      // true` means "yes, bill me", and offering it as the sole remedy invites
      // switching off the safety net to fix a mislabelled route.
      "route can incur paid usage and paid usage is not allowed — this is a config-level " +
        `block, not an availability problem. If '${route}' really can bill you, add ` +
        `\`allow_paid_usage: true\` to it in config.yaml (or run ` +
        `\`harness-dispatch configure --allow-paid\`). If it cannot — a local runtime, or a ` +
        `route already covered by a subscription — the correct fix is ` +
        `\`paid_usage_possible: false\` instead.`,
    );
  }

  if (!safetyProfileCompatible(svc, opts.requestedSafetyProfile)) {
    return skip(
      route,
      "safety_incompatible",
      `effective safety ${effectiveSafetyProfile(
        svc,
        opts.requestedSafetyProfile,
      )} exceeds requested safety`,
    );
  }

  return { blocked: false };
}

/**
 * Scoring penalty applied to nudge route selection toward cheaper options
 * when scores are otherwise close. Local routes (free, on this machine) pay
 * nothing. Included-plan/free-quota-but-remote routes pay a small penalty
 * (prefer local when close). Routes that can incur real per-use cost
 * (metered API, unknown billing) must pay MORE than that, not less — they
 * were previously falling through to the same 0 penalty as local routes,
 * which meant the router could prefer spending real money over using a
 * subscription you're already paying for or a free local model.
 */
export function nonLocalIncludedRoutePenalty(billing: RouteBilling): number {
  if (isLocalRoute(billing)) return 0;
  if (isIncludedOrLocalRoute(billing)) return 0.2;
  return 0.4;
}

function evaluateOperationalRoutePolicy(
  route: string,
  billing: RouteBilling,
  routePolicy: RoutePolicy | undefined,
): RoutePolicyResult {
  if (routePolicy === "blocked") {
    return skip(
      route,
      "route_policy",
      "excluded by the CALLER's own hints.routePolicy='blocked' on this request (dry-run) " +
        "— not a config restriction or a router safety judgment about this route or its " +
        "content; drop or change that hint to allow it",
    );
  }

  if (routePolicy === "local_only" && !isLocalRoute(billing)) {
    return skip(
      route,
      "route_policy",
      "excluded by the CALLER's own hints.routePolicy='local_only' on this request " +
        "— not a config restriction or a router safety judgment about this route or its " +
        "content; drop or change that hint to allow non-local routes",
    );
  }

  if (routePolicy === "approval_required" && !isLocalRoute(billing)) {
    return skip(
      route,
      "approval_required",
      "excluded by the CALLER's own hints.routePolicy='approval_required' on this request " +
        "— not a config restriction or a router safety judgment about this route or its " +
        "content; drop or change that hint to allow non-local routes",
    );
  }

  return { blocked: false };
}

/**
 * Exported because `taskType: "local"` needs the SAME answer this file gives
 * `routePolicy: "local_only"`. It had its own narrower test — a loopback
 * hostname — so a route declaring provider `local`, surface `local_endpoint`,
 * auth `local_network` and billing `local_compute` was "local" enough to be
 * the only thing `local_only` would run, and not local enough for the task
 * type named after it. One word, two meanings, and the narrow one silently
 * excluded a real local box on a LAN or tailnet address.
 */
export function isLocalRoute(billing: RouteBilling): boolean {
  return (
    billing.kind === "local_compute" ||
    billing.provider === "local" ||
    billing.surface === "local_endpoint" ||
    billing.authSource === "local_network"
  );
}

function isIncludedOrLocalRoute(billing: RouteBilling): boolean {
  return (
    isLocalRoute(billing) ||
    billing.kind === "free_quota" ||
    billing.kind === "included_plan_usage" ||
    billing.kind === "included_plan_then_flexible_credits" ||
    billing.kind === "included_credit_then_optional_overage" ||
    billing.kind === "included_usage_then_on_demand"
  );
}

function skip(route: string, code: RouteSkip["code"], message: string): RoutePolicyResult {
  return {
    blocked: true,
    skipped: { route, code, message },
  };
}
