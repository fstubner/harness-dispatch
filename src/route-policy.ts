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
  // A credential that is missing is knowable before the call, unlike health.
  //
  // The three checks that look like they should catch this cannot. The
  // never-succeeded skip is a LIFETIME test, so a route that worked last week
  // on a machine where the variable was exported is not dead. The breaker
  // needs repeated failures, and one 401 per route is not repeated. And
  // `doctor --live` is opt-in precisely because it spends quota. Without this,
  // `usage` and `status` call such a route ready, the router scores it, and it
  // returns an authentication error on the first call.
  //
  // The config warning about unset variables is a line about the FILE; this
  // carries it down to the route, so the route is skipped with the variable
  // named before a provider is ever contacted.
  //
  // Set only for endpoint routes (see markUnsetApiKeys). Its one false
  // positive is a local server that ignores the key it is sent, where the
  // honest fix — deleting an api_key line that does nothing — is also what
  // this message asks for.
  if (svc.apiKeyUnsetRef !== undefined) {
    return skip(
      route,
      "credential_unset",
      `its api_key is ${svc.apiKeyUnsetRef}, and that variable is not set here, so the ` +
        `route has no credential and every call would fail to authenticate. Export the ` +
        `variable, or remove the api_key line if this endpoint needs none.`,
    );
  }
  if (
    opts.localCounts &&
    opts.localCounts.calls >= NEVER_SUCCEEDED_MIN_CALLS &&
    opts.localCounts.successes === 0
  ) {
    // A route that has failed every call it has ever been given is not a
    // transient failure, which is what the breaker is for — it decays, so a
    // permanently misconfigured route keeps being chosen, failing, and costing
    // an attempt before the fallback, while still reading as ready.
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
    // is. Saying "billing source is unknown" for both contradicts `status`,
    // which prints such a route as `billing=metered_api` — the kind is known
    // perfectly well; what is unknown is how sure we are of it.
    //
    // The remedy for a KNOWN kind that has declared it cannot bill you has to
    // be given HERE: this branch catches those before the `billingIsBlocked`
    // branch below, which would otherwise tell a `metered_api` route with
    // `paid_usage_possible: false` to add `allow_paid_usage: true` — "yes,
    // bill me" for a route the operator has said cannot.
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
        `block, not an availability problem. If '${route}' cannot bill you (a local model, a ` +
        `free endpoint), declare that in config.yaml with \`billing_kind: local_compute\` (or ` +
        `\`free_quota\`); if it can, add \`allow_paid_usage: true\` to accept that it may`,
    );
  }
  if (billingIsBlocked(billing)) {
    // THREE conditions reach `billingIsBlocked`, and the message below fits
    // only two of them. A route with `paid_usage_possible: false` and a KNOWN
    // kind is blocked solely because its `billing_confidence` is `unknown` — a
    // deliberate operator signal meaning "I do not trust this classification".
    // Telling it "route can incur paid usage" contradicts `paid=no` on the
    // same screen and offers a remedy it already has, leaving
    // `allow_paid_usage: true` — "yes, bill me" — as the only escape for a
    // free local model.
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
  // access, no shell. Nothing else stops `execute` work reaching one, because
  // an undeclared capability defaults to 1.0 and no endpoint example in
  // config.default.yaml declares any — and the endpoint answers with prose and
  // exit 0, reporting execution that never happened. It happens exactly when
  // the CLI routes are busy or tripped, the degraded case the caller is least
  // able to check.
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
 * (metered API, unknown billing) must pay MORE than that, not less, or the
 * router can prefer spending real money over using a subscription you're
 * already paying for or a free local model.
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
 * `routePolicy: "local_only"`. A narrower test — a loopback hostname — makes
 * one word mean two things, and silently excludes a real local box on a LAN or
 * tailnet address from the task type named after it.
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

// ---------------------------------------------------------------------------
// Fanout targets
// ---------------------------------------------------------------------------

/** A requested fanout target that names no configured route or model. */
export class UnknownFanoutTargetError extends Error {}

/**
 * Does `want` name this route: its id, its `model`, or its `escalate_model`?
 *
 * The one rule for what a fanout `models` entry means, shared by the MCP and
 * HTTP surfaces. They each matched on their own and disagreed — MCP accepted
 * model names, HTTP only route ids — so the same request was valid on one and
 * a 400 on the other.
 */
export function routeMatchesTarget(
  name: string,
  svc: Pick<ServiceConfig, "model" | "escalateModel">,
  want: string,
): boolean {
  const w = want.toLowerCase();
  return [name, svc.model, svc.escalateModel].some(
    (v) => typeof v === "string" && v !== "" && v.toLowerCase() === w,
  );
}

/**
 * Which routes a fanout runs on, and which it declined.
 *
 * `requested` empty means every configured route. Otherwise each entry must
 * match something (a name matching nothing would be silently dropped, and two of
 * them would answer `completed: true` with no results), and the arms are the
 * routes matching ANY entry, once each, in config order. Each arm then passes
 * route policy exactly as a single dispatch does; a refusal is reported in
 * `skippedRoutes` rather than dropped.
 */
export function selectFanoutRoutes(opts: {
  services: Readonly<Record<string, ServiceConfig>>;
  dispatchers: Readonly<Record<string, Dispatcher>>;
  breakerTripped: (route: string) => boolean;
  requested: readonly string[];
  hints: { safetyProfile?: SafetyProfile; routePolicy?: RoutePolicy; taskType?: TaskType };
}): { routes: string[]; skippedRoutes: RouteSkip[] } {
  const entries = Object.entries(opts.services);
  const unmatched = opts.requested.filter(
    (want) => !entries.some(([name, svc]) => routeMatchesTarget(name, svc, want)),
  );
  if (unmatched.length > 0) {
    throw new UnknownFanoutTargetError(
      `Unknown fanout target(s): ${unmatched.join(", ")}. ` +
        `Valid route ids: ${entries.map(([name]) => name).join(", ")}. ` +
        `models: accepts route ids or model names.`,
    );
  }
  const routes: string[] = [];
  const skippedRoutes: RouteSkip[] = [];
  for (const [name, svc] of entries) {
    if (
      opts.requested.length > 0 &&
      !opts.requested.some((want) => routeMatchesTarget(name, svc, want))
    ) {
      continue;
    }
    // `Object.hasOwn`, not a plain lookup: a route literally named
    // `constructor` would otherwise be handed the inherited function.
    const dispatcher = Object.hasOwn(opts.dispatchers, name) ? opts.dispatchers[name] : undefined;
    // routePolicy is the half that decides ELIGIBILITY — local_only,
    // approval_required and blocked are enforced here, not in routeTo, so
    // omitting it lets a fanout arm run whatever the policy forbids.
    const policy = evaluateRoutePolicy(name, svc, {
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      circuitBroken: opts.breakerTripped(name),
      ...(opts.hints.safetyProfile !== undefined
        ? { requestedSafetyProfile: opts.hints.safetyProfile }
        : {}),
      ...(opts.hints.routePolicy !== undefined ? { routePolicy: opts.hints.routePolicy } : {}),
      // So an `execute` task is refused for an HTTP endpoint route here too.
      ...(opts.hints.taskType !== undefined ? { taskType: opts.hints.taskType } : {}),
    });
    if (policy.skipped) skippedRoutes.push(policy.skipped);
    if (!policy.blocked) routes.push(name);
  }
  return { routes, skippedRoutes };
}
