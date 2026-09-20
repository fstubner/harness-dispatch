import { billingIsBlocked, billingIsUnknown, buildRouteBilling } from "./billing.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { effectiveSafetyProfile, safetyProfileCompatible } from "./safety.js";
import type {
  RouteBilling,
  RoutePolicy,
  RouteSkip,
  SafetyProfile,
  ServiceConfig,
  TaskType,
} from "./types.js";

export interface RoutePolicyResult {
  blocked: boolean;
  skipped?: RouteSkip;
}

/**
 * Calls a route must have had before "0 successes" means anything.
 *
 * Exported because `doctor` reports the same condition and the two numbers
 * must agree — a route doctor calls dead while the router still scores it, or
 * the reverse, is worse than either behaviour alone. One constant, two
 * readers.
 */
export const NEVER_SUCCEEDED_MIN_CALLS = 5;

export function evaluateRoutePolicy(
  route: string,
  svc: ServiceConfig,
  opts: {
    dispatcher?: Dispatcher;
    circuitBroken?: boolean;
    requestedSafetyProfile?: SafetyProfile;
    routePolicy?: RoutePolicy;
    taskType?: TaskType;
    /**
     * Lifetime counts for this route, passed ONLY by the scoring path.
     *
     * Omitted when the caller named the route, which is what makes naming it
     * the way back in: a route the scorer refuses can still be run with an
     * explicit `service`, and one success clears the condition for good.
     */
    localCounts?: { calls: number; successes: number };
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
  if (
    opts.localCounts &&
    opts.localCounts.calls >= NEVER_SUCCEEDED_MIN_CALLS &&
    opts.localCounts.successes === 0
  ) {
    // A route that has failed every call it has ever been given is not a
    // transient failure, which is what the breaker is for — it decays, so a
    // permanently misconfigured route keeps being chosen, failing, and costing
    // an attempt before the fallback. Measured on a real install:
    // `local_inference` was 0 for 8 against an endpoint that was simply not
    // running, and still read as ready.
    //
    // Not blocked outright: naming it with `service` bypasses this entirely,
    // because the operator fixing the box needs a way to prove it works, and
    // one success is what clears it.
    return skip(
      route,
      "never_succeeded",
      `route has failed every one of its ${opts.localCounts.calls} attempts, so it is not ` +
        `being scored — name it with \`service\` to run it anyway (one success re-admits it), ` +
        `or disable it in config`,
    );
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
    // A KNOWN kind that has declared it cannot bill you gets the remedy that
    // works, and it has to be given HERE.
    //
    // The same advice was added to the `billingIsBlocked` branch below and was
    // unreachable for any non-included kind, because this branch catches those
    // first — so a `metered_api` route with `paid_usage_possible: false` was
    // still told to add `allow_paid_usage: true`, which is "yes, bill me" for
    // a route the operator has said cannot. The fix that was supposed to stop
    // that was one branch too late.
    if (billing.kind !== "unknown" && !billing.paidUsagePossible) {
      return skip(
        route,
        "unknown_billing",
        `billing_confidence is \`unknown\` for '${route}', which blocks it even though its ` +
          `billing kind (${billing.kind}) is declared and \`paid_usage_possible\` is false. ` +
          `That is what \`billing_confidence: unknown\` means — "do not trust this ` +
          `classification". Set it to the value you actually believe (\`documented\` or ` +
          `\`inferred\`); do NOT allow paid usage on a route you have said cannot bill you.`,
      );
    }
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
    // THREE conditions reach `billingIsBlocked`, and the message below fitted
    // only two of them.
    //
    // A route with `paid_usage_possible: false` and a KNOWN kind is blocked
    // solely because its `billing_confidence` is `unknown` — a deliberate
    // operator signal meaning "I do not trust this classification", kept on
    // purpose. But it was told "route can incur paid usage" (contradicting
    // `paid=no` on the same screen) and handed `paid_usage_possible: false` as
    // the remedy, which it already had. An acceptance pass measured the
    // recommended fix producing byte-identical output: the only working escape
    // was `allow_paid_usage: true` — "yes, bill me" — for a free local model.
    if (billing.kind !== "unknown" && !billing.paidUsagePossible) {
      return skip(
        route,
        "paid_blocked",
        `billing_confidence is \`unknown\` for '${route}', which blocks it even though ` +
          `its billing kind (${billing.kind}) is declared and \`paid_usage_possible\` is ` +
          `false. That is what \`billing_confidence: unknown\` means — "do not trust this ` +
          `classification" — so the fix is to set it to the value you actually believe ` +
          `(\`documented\` or \`inferred\`), NOT to allow paid usage on a route you have ` +
          `said cannot bill you.`,
      );
    }
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

  // An HTTP endpoint cannot execute, structurally: no agent loop, no file
  // access, no shell. PRODUCT.md states this as design rather than gap — and
  // routing still sent `execute` work to one, because an undeclared capability
  // defaults to 1.0 and NO endpoint example in config.default.yaml declares
  // any. An acceptance pass measured a `--task-type execute` dispatch routed to
  // an endpoint returning prose and exit 0: execution reported as succeeded
  // when none happened. It surfaces exactly when the CLI routes are busy or
  // tripped — the degraded case the caller is least able to check.
  //
  // A REFUSAL rather than a capability score, for two reasons. A score of 0
  // still leaves the route selectable when it is the only candidate, which is
  // the failing case itself. And declared capabilities must not be able to
  // override it: this is the same rule as the safety-flag check below — a
  // declaration cannot conjure an ability the route does not have.
  if (opts.taskType === "execute" && svc.type === "openai_compatible") {
    return skip(
      route,
      "cannot_execute",
      "this is an HTTP model endpoint — it has no agent loop, no file access and no shell, " +
        "so it cannot carry out an `execute` task. Endpoint routes serve plan, review and " +
        "second opinions. Use a CLI route for execution, or send this as taskType: plan/review.",
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
