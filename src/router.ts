/**
 * Load-balancing router for harness-dispatch.
 *
 * Routing strategy
 * ----------------
 * Services are grouped by tier (lower number = higher quality). Selection
 * prefers the best-scoring candidate in the lowest eligible tier:
 *
 *   Tier 1 (frontier)  ->  Tier 2 (strong)  ->  Tier 3 (fast/local)
 *
 * Services that are circuit-broken, policy-blocked, unavailable, or already
 * tried this request are excluded from candidacy. On a failed dispatch
 * (including rate limits) the router excludes that service and retries with
 * the next-best candidate, up to `maxFallbacks` extra attempts per request
 * (default 2, i.e. 3 attempts total — pass maxFallbacks: 0 to let the caller
 * own retries). A request can therefore fail with untried routes remaining
 * when the attempt cap is hit before candidates run out.
 *
 * Quality scoring
 * ---------------
 * Within a tier, services are ranked by a composite score:
 *
 *   final_score = quality_score * cli_capability * capability[task_type]
 *                 * quota_score * weight
 *
 * Adjustments applied during selection (reflected in the reported
 * finalScore for picked/fallback routes, but not for forced/explicit ones):
 *  - Cost-based penalty under the "standard" route policy
 *    (nonLocalIncludedRoutePenalty): 0 for local routes, -0.2 for non-local
 *    included-plan/free-quota routes, -0.4 for routes that can incur real
 *    per-use cost (metered API, unknown billing) — cheapest/lowest-risk
 *    wins ties, in that order.
 *  - +0.5 when hints.model matches the service name or one of its models.
 *  - Under prefer_large_context, +0.3 for routes declaring >=2M
 *    max_input_tokens and +0.15 for >=1M — declared context size, not
 *    harness name.
 *
 * Two rules cross tiers, and only two.
 *
 * The first: a hints.model value that names a CONFIGURED ROUTE runs that route
 * wherever it sits, falling through to normal tier order when it is not an
 * eligible candidate. A score bonus cannot do this on its own, because a bonus
 * only reorders within a tier. `service` remains the way to force a route with
 * no fallback at all.
 *
 * The second, applied after it: task_type="local" picks the best-scoring
 * LOCAL route wherever it sits, falling back to normal tier order when none is
 * eligible. Local means what `routePolicy: "local_only"` means — declared
 * provider/surface/auth/billing, and NOT a loopback URL, because a metered
 * proxy on 127.0.0.1 declares itself metered and the task type meaning "free
 * local endpoint" must not prefer the PAID route. Tier ranks CAPABILITY, and
 * this task type means "capability is not what matters here".
 *
 * Tier auto-derivation
 * --------------------
 * If a service has `leaderboardModel` set in config, its tier is
 * auto-derived from the Arena ELO score via LeaderboardCache.autoTier().
 * Explicit `tier` in config is the fallback when ELO is unavailable.
 *
 * `stream()` / `streamTo()` emit `DispatcherEvent`s with an attached
 * `RoutingDecision`.
 *
 * There is ONE selection-and-fallback loop per shape — `#runStream` for the
 * routed path, `#runStreamTo` for an explicit route — and the buffered
 * `route()` / `routeTo()` drain them, so a rule such as timeout precedence
 * exists once rather than in four copies that can drift.
 *
 * What still differs between buffered and streaming is the dispatcher call
 * itself, and only that: see `DispatcherInvoke`.
 */

import type {
  DispatchResult,
  DispatcherEvent,
  RouterConfig,
  RoutingDecision,
  RouteHints,
  RouteSkip,
  SafetyProfile,
  ServiceConfig,
  TaskType,
} from "./types.js";
import { CircuitBreaker, type CircuitBreakerSnapshot } from "./circuit-breaker.js";
import { BreakerStore } from "./breaker-store.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import type { DispatchOpts, Dispatcher } from "./dispatchers/base.js";
import { drainDispatcherStream } from "./dispatchers/base.js";
import { withDispatcherSpan, withRouterSpan } from "./observability/spans.js";
import { buildRouteBilling } from "./billing.js";
import { logDispatch } from "./dispatch-log.js";
import { effectiveSafetyProfile, requestedSafetyProfile } from "./safety.js";
import { evaluateRoutePolicy, isLocalRoute, nonLocalIncludedRoutePenalty } from "./route-policy.js";
import { acquireWorkspaceLock } from "./workspace-lock.js";
import {
  prepareWorkspace,
  workspacePolicyFor,
  type PreparedWorkspace,
} from "./workspaces.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_TYPES_WITH_CAPABILITY: ReadonlySet<TaskType> = new Set([
  "execute",
  "plan",
  "review",
]);

/**
 * Every scoring adjustment, named and in one place.
 *
 * `tests/router.test.ts` pins these values with a message pointing at this
 * file's header, so changing one fails a test that tells you the other half to
 * update — the cheap version of a doc-accuracy check.
 */
export const SCORING = {
  /** hints.model names this route or one of its declared models. */
  modelMatchBonus: 0.5,
  /** Route declares >= 2M max_input_tokens, under preferLargeContext. */
  largeContextBonus: 0.3,
  /** Route declares >= 1M max_input_tokens, under preferLargeContext. */
  mediumContextBonus: 0.15,
  largeContextThreshold: 2_000_000,
  mediumContextThreshold: 1_000_000,
  /** Extra attempts after the first, when a dispatch fails. */
  defaultMaxFallbacks: 2,
} as const;


/**
 * `service` is a raw string from the caller, so a near-miss ("codex" for
 * "codex_cli") names the valid ids rather than costing a round-trip to `usage`
 * to find out what would have worked.
 */
function unknownServiceError(service: string, valid: string[]): string {
  return `Unknown service: ${service} (valid route ids: ${valid.join(", ")})`;
}

/**
 * Options for explicit-service dispatch (routeTo / streamTo).
 *
 * `model` is an instruction, not a routing hint: the caller already chose
 * the service, so the value is passed to the harness as a model override
 * verbatim (an invalid name fails loudly downstream instead of being
 * silently dropped). `taskType` feeds capability scoring metadata and
 * per-task model escalation (escalateOn/escalateModel).
 */
export interface ExplicitDispatchOpts {
  /** Abort an in-flight run; forwarded to the dispatcher and on to the child. */
  signal?: AbortSignal;
  safetyProfile?: SafetyProfile;
  workspacePolicy?: ServiceConfig["workspacePolicy"];
  routePolicy?: import("./types.js").RoutePolicy;
  model?: string;
  taskType?: TaskType;
  timeoutMs?: number;
  /**
   * Fallback timeout when neither `timeoutMs` (explicit per-call override)
   * nor the service's own `timeoutMs` config is set — below both in
   * precedence, so it never silently overrides a real value. Background
   * dispatches set it to get a generous ceiling without a caller having to
   * ask for one; a blocking call leaves it unset and keeps the dispatcher's
   * own short default.
   */
  defaultTimeoutMs?: number;
  /**
   * Called once the run's workspace exists, with a single-use `finish`.
   *
   * For the job runner only: a cancelled job abandons the stream before any
   * completion arrives, and the completion is where an isolated workspace's
   * record — its changed files, its patch — is produced. Without this, a
   * cancelled `copy`/`git_worktree` run leaves edits nobody can diff or apply.
   */
  onWorkspace?: (workspace: PreparedWorkspace) => void;
}

function resolveModel(svc: ServiceConfig, taskType: TaskType): string | undefined {
  if (svc.escalateModel && svc.escalateOn.includes(taskType)) {
    return svc.escalateModel;
  }
  return svc.model;
}

function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function modelMatchesService(name: string, svc: ServiceConfig, model: string | undefined): boolean {
  if (!model) return false;
  return (
    sameModel(name, model) ||
    sameModel(svc.model, model) ||
    sameModel(svc.leaderboardModel, model) ||
    sameModel(svc.escalateModel, model)
  );
}

/**
 * Does this route actually DECLARE this model? The route's own name does not
 * count.
 *
 * Distinct from modelMatchesService, which includes the name because a route
 * id is a legitimate routing nudge and should score like one. The reported
 * flag is a different question: `modelHintMatched: false` tells the agent the
 * model was forwarded blind, so counting a route-name match as a declaration
 * would invert the one signal the schema points it at for self-correction.
 */
export function declaresModel(svc: ServiceConfig, model: string | undefined): boolean {
  if (!model) return false;
  return (
    sameModel(svc.model, model) ||
    sameModel(svc.leaderboardModel, model) ||
    sameModel(svc.escalateModel, model)
  );
}

/**
 * Resolve a caller's `model` against a route the caller NAMED — the forced
 * path (`hints.service`) and the explicit path (the top-level `service`
 * param, which reaches `streamTo`/`routeTo`).
 *
 * With the service already chosen, `model` can only be a model, so a value
 * that merely collides with SOME OTHER route's id must still reach the
 * harness. The one exception is a value naming THIS route: that is
 * over-specifying ("use codex_cli, with codex_cli"), and forwarding it sends
 * `--model codex_cli` to a harness that rejects it, costing a failed job and
 * a breaker event.
 *
 * Shared by the forced and explicit paths so the rule exists once. The SCORED
 * path deliberately differs: no service was named there, so any route id is a
 * routing nudge rather than a model.
 */
function resolveNamedRouteModel(
  serviceName: string,
  svc: ServiceConfig,
  requested: string | undefined,
  taskType: TaskType,
): { model: string | undefined; modelHintMatched?: boolean; modelHintDropped?: boolean } {
  const routeDefault = resolveModel(svc, taskType);
  if (requested === undefined) return { model: routeDefault };
  const matched = declaresModel(svc, requested);
  if (sameModel(serviceName, requested)) {
    return { model: routeDefault, modelHintMatched: matched, modelHintDropped: true };
  }
  return { model: requested, modelHintMatched: matched };
}

function capabilityScore(svc: ServiceConfig, taskType: TaskType): number {
  if (!TASK_TYPES_WITH_CAPABILITY.has(taskType)) return 1.0;
  const key = taskType as "execute" | "plan" | "review";
  return svc.capabilities[key] ?? 1.0;
}

/**
 * How the router asks a dispatcher to do the work.
 *
 * The single thing that differs between the buffered and streaming entry
 * points, passed as a parameter rather than duplicated as a second loop.
 *
 * Not simply `stream()` for everything: `OpenAICompatibleDispatcher` overrides
 * `dispatch()` with a one-shot POST that sets `stream: false` on the wire,
 * deliberately, and draining `stream()` would flip that request for every
 * endpoint route — a live behaviour change against third-party gateways, one
 * of which this repo has a note about ignoring `stream: true`.
 */
type DispatcherInvoke = (
  dispatcher: Dispatcher,
  prompt: string,
  files: string[],
  workingDir: string,
  opts: DispatchOpts,
) => AsyncIterable<DispatcherEvent>;

/** Real streaming: the dispatcher emits events as they happen. */
const STREAMING_INVOKE: DispatcherInvoke = (dispatcher, prompt, files, workingDir, opts) =>
  dispatcher.stream(prompt, files, workingDir, opts);

/**
 * Buffered: call `dispatch()` and present its single result as a one-event
 * stream, so the shared loop (and the workspace-policy wrapper, which finishes
 * a workspace when it sees the completion event) needs no second shape.
 */
const BUFFERED_INVOKE: DispatcherInvoke = async function* (
  dispatcher,
  prompt,
  files,
  workingDir,
  opts,
) {
  const spanAttrs: import("./observability/spans.js").DispatcherSpanAttrs = {
    "dispatcher.id": dispatcher.id,
  };
  if (opts.modelOverride !== undefined) spanAttrs.model = opts.modelOverride;
  const result = await withDispatcherSpan("dispatch", spanAttrs, async (span) => {
    const r = await dispatcher.dispatch(prompt, files, workingDir, opts);
    span.setAttribute("success", r.success);
    if (r.rateLimited) span.setAttribute("rate_limited", true);
    if (r.tokensUsed) {
      span.setAttribute("tokens.input", r.tokensUsed.input);
      span.setAttribute("tokens.output", r.tokensUsed.output);
    }
    return r;
  });
  yield { type: "completion", result };
};

/**
 * A prepared workspace whose `finish` runs at most once, however many callers
 * reach it.
 *
 * Two can: the stream below finishes it when the dispatcher completes, and a
 * cancelled job finishes it itself (see `onWorkspace`). They can race, and a
 * second `finish` would fingerprint, or try to remove, a workspace the first
 * already dealt with.
 */
function finishOnce(workspace: PreparedWorkspace): PreparedWorkspace {
  let done: Promise<DispatchResult> | undefined;
  return { ...workspace, finish: (result) => (done ??= workspace.finish(result)) };
}

async function* streamWithWorkspacePolicy<T>(
  svc: ServiceConfig,
  serviceName: string,
  safetyProfile: SafetyProfile | undefined,
  requestedPolicy: ServiceConfig["workspacePolicy"] | undefined,
  workingDir: string,
  files: string[],
  makeStream: (effectiveWorkingDir: string, effectiveFiles: string[]) => AsyncIterable<T>,
  onWorkspace?: (workspace: PreparedWorkspace) => void,
): AsyncGenerator<T> {
  const policy = workspacePolicyFor(svc, safetyProfile, requestedPolicy);
  if (policy === "shared_locked") {
    const release = await acquireWorkspaceLock(workingDir);
    try {
      const workspace = finishOnce(
        await prepareWorkspace({
          routeName: serviceName,
          policy,
          workingDir,
          files,
        }),
      );
      onWorkspace?.(workspace);
      for await (const event of makeStream(workspace.effectiveWorkingDir, workspace.files)) {
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "completion"
        ) {
          const completion = event as DispatcherEvent;
          if (completion.type === "completion") {
            yield {
              ...completion,
              result: await workspace.finish(completion.result),
            } as T;
            continue;
          }
        }
        yield event;
      }
    } finally {
      release();
    }
    return;
  }

  const shouldLockSnapshot = safetyProfile !== "read_only" && (policy === "copy" || policy === "git_worktree");
  const release = shouldLockSnapshot ? await acquireWorkspaceLock(workingDir) : undefined;
  let workspace: PreparedWorkspace;
  try {
    workspace = finishOnce(
      await prepareWorkspace({
        routeName: serviceName,
        policy,
        workingDir,
        files,
      }),
    );
  } finally {
    release?.();
  }
  onWorkspace?.(workspace);
  for await (const event of makeStream(workspace.effectiveWorkingDir, workspace.files)) {
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "completion"
    ) {
      const completion = event as DispatcherEvent;
      if (completion.type === "completion") {
        yield {
          ...completion,
          result: await workspace.finish(completion.result),
        } as T;
        continue;
      }
    }
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Internal candidate tuple
// ---------------------------------------------------------------------------

interface Candidate {
  score: number;
  name: string;
  /** Kept on the candidate so the local-preference pass can report the tier it came from. */
  tier: number;
  /** By the same test `routePolicy: "local_only"` uses — see isLocalRoute. */
  local: boolean;
  quotaScore: number;
  qualityScore: number;
  elo: number | null;
  cliCapability: number;
  capScore: number;
}

// ---------------------------------------------------------------------------
// Streaming event shape
// ---------------------------------------------------------------------------

/**
 * Router streaming events wrap the dispatcher event with the active routing
 * decision. The decision is attached to every event of a dispatch attempt, so
 * a consumer can show "routing to claude_code" before the first token arrives
 * and cannot miss it by joining late.
 */
export interface RouterStreamEvent {
  event: DispatcherEvent;
  decision: RoutingDecision | null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// No loopback-URL check here: "local" is a declared property of a route, not a
// shape its URL happens to have. billing.ts keeps its own loopback check for
// structural INFERENCE about routes that declare nothing, which is a different
// job and the right place for it.

export class Router {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();
  private lastSkippedRoutes: RouteSkip[] = [];
  private readonly breakerStore: BreakerStore;

  constructor(
    private readonly config: RouterConfig,
    private readonly quota: QuotaCache,
    private readonly dispatchers: Record<string, Dispatcher>,
    private readonly leaderboard: LeaderboardCache,
    breakerStore?: BreakerStore,
  ) {
    this.breakerStore = breakerStore ?? new BreakerStore();
    // Restart survival: a route rate-limited right before the process died
    // would otherwise come back with a clean slate the instant the server
    // restarts — hydrate any cooldown still in effect from the last process.
    const persisted = this.breakerStore.loadAll();
    for (const name of Object.keys(config.services)) {
      const breaker = new CircuitBreaker();
      const snapshot = persisted[name];
      if (snapshot) breaker.restore(snapshot);
      this.breakers.set(name, breaker);
    }
  }

  getBreaker(service: string): CircuitBreaker | undefined {
    return this.breakers.get(service);
  }

  skippedRoutes(): RouteSkip[] {
    return this.lastSkippedRoutes.slice();
  }

  /**
   * Why nothing was eligible — read off what ACTUALLY happened, not a fixed
   * list of guesses. A route skipped as `paid_blocked` is a billing policy the
   * operator chose, not a health problem, and reporting it as one makes a
   * healthy route look unreliable.
   *
   * Breakers are named only when one is actually tripped; an untripped blob is
   * noise that reads as evidence.
   */
  private noEligibleRouteError(): string {
    const byCode = new Map<string, string[]>();
    for (const skip of this.lastSkippedRoutes) {
      const routes = byCode.get(skip.code) ?? [];
      routes.push(skip.route);
      byCode.set(skip.code, routes);
    }
    const why =
      byCode.size > 0
        ? [...byCode].map(([code, routes]) => `${code}: ${routes.join(", ")}`).join("; ")
        : "no routes are configured";

    const tripped: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, breaker] of this.breakers) {
      const state = breaker.status();
      if (state.tripped) tripped[name] = state;
    }
    const breakerNote =
      Object.keys(tripped).length > 0 ? ` Tripped breakers: ${JSON.stringify(tripped)}` : "";

    return `No route was eligible for this dispatch — ${why}.${breakerNote}`;
  }

  async pickService(opts: {
    hints?: RouteHints;
    prompt?: string;
    files?: string[];
    exclude?: Set<string>;
  } = {}): Promise<RoutingDecision | null> {
    const hints = opts.hints ?? {};
    const exclude = opts.exclude ?? new Set<string>();

    const forceService = hints.service;
    // A ROUTE ID is not a model name. `hints.model` accepts either, and a
    // route id steers routing (modelMatchesService below matches on the route
    // NAME) without being passed on as a model override — forwarding it to the
    // winning route as `--model` would be a real provider call with a nonsense
    // model, rejected and charged for. A value that is not a configured route
    // id is forwarded blind, which is what makes an undeclared-but-real model
    // usable.
    const preferredModel = hints.model;
    const modelIsRouteId =
      preferredModel !== undefined &&
      Object.keys(this.config.services).some((name) => sameModel(name, preferredModel));
    const modelOverride = modelIsRouteId ? undefined : preferredModel;
    const preferLargeContext = hints.preferLargeContext ?? false;
    const taskType: TaskType = hints.taskType ?? "";
    const filterHarness = hints.harness;
    const requestedSafety = hints.safetyProfile;
    const requestedWorkspacePolicy = hints.workspacePolicy;
    const skippedRoutes: RouteSkip[] = [];
    this.lastSkippedRoutes = skippedRoutes;

    if (forceService) {
      if (exclude.has(forceService)) return null;
      const breaker = this.breakers.get(forceService);
      const dispatcher = this.dispatchers[forceService];
      const svc = this.config.services[forceService];
      if (!svc) return null;
      const policy = evaluateRoutePolicy(forceService, svc, {
        ...(dispatcher !== undefined ? { dispatcher } : {}),
        circuitBroken: Boolean(breaker?.isTripped),
        ...(requestedSafety !== undefined ? { requestedSafetyProfile: requestedSafety } : {}),
        ...(hints.routePolicy !== undefined ? { routePolicy: hints.routePolicy } : {}),
        taskType,
      });
      if (policy.skipped) skippedRoutes.push(policy.skipped);
      if (policy.blocked || dispatcher === undefined) return null;

      const quotaScore = await this.quota.getQuotaScore(forceService);
      const { qualityScore, elo } = await this.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const capScore = capabilityScore(svc, taskType);
      const finalScore =
        qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight;

      const effectiveSafety = effectiveSafetyProfile(svc, requestedSafety);
      return {
        service: forceService,
        tier: svc.tier,
        quotaScore,
        qualityScore,
        cliCapability: svc.cliCapability,
        capabilityScore: capScore,
        taskType,
        // A requested model is passed through even when this route declares
        // nothing like it — the router not recognizing a model does not mean
        // the CLI rejects it, and discarding it silently would leave a
        // mismatched hints.model with no error and no explanation. See
        // resolveNamedRouteModel for the one case that is suppressed.
        ...resolveNamedRouteModel(forceService, svc, preferredModel, taskType),
        elo: elo ?? undefined,
        finalScore,
        reason: "forced",
        skippedRoutes: skippedRoutes.slice(),
        safetyProfile: requestedSafetyProfile(svc, requestedSafety),
        effectiveSafetyProfile: effectiveSafety,
        billing: buildRouteBilling(svc),
        workspacePolicy: workspacePolicyFor(svc, effectiveSafety, requestedWorkspacePolicy),
      };
    }

    const tierCandidates = new Map<number, Candidate[]>();

    for (const [name, svc] of Object.entries(this.config.services)) {
      if (exclude.has(name)) continue;
      const breaker = this.breakers.get(name);
      const dispatcher = this.dispatchers[name];
      const policy = evaluateRoutePolicy(name, svc, {
        ...(dispatcher !== undefined ? { dispatcher } : {}),
        circuitBroken: Boolean(breaker?.isTripped),
        ...(requestedSafety !== undefined ? { requestedSafetyProfile: requestedSafety } : {}),
        ...(hints.routePolicy !== undefined ? { routePolicy: hints.routePolicy } : {}),
        taskType,
        // Only here, and deliberately not on the two explicit paths above and
        // below: a route the scorer will not choose must still run when the
        // caller names it, or a fixed endpoint has no way of proving itself.
        localCounts: this.quota.localCountsFor(name),
      });
      if (policy.skipped) skippedRoutes.push(policy.skipped);
      if (policy.blocked || dispatcher === undefined) continue;

      const harnessKey = svc.harness ?? name;
      if (filterHarness && harnessKey !== filterHarness) continue;

      const tier = svc.leaderboardModel
        ? await this.leaderboard.autoTier(svc.leaderboardModel, svc.thinkingLevel, svc.tier)
        : svc.tier;

      const quotaScore = await this.quota.getQuotaScore(name);
      const { qualityScore, elo } = await this.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const capScore = capabilityScore(svc, taskType);

      const effectiveQuality = qualityScore * svc.cliCapability * capScore;
      let score = effectiveQuality * quotaScore * svc.weight;
      if ((hints.routePolicy ?? "standard") === "standard") {
        score -= nonLocalIncludedRoutePenalty(buildRouteBilling(svc));
      }

      if (modelMatchesService(name, svc, preferredModel)) {
        score += SCORING.modelMatchBonus;
      }
      if (preferLargeContext) {
        // Boost by DECLARED context size (max_input_tokens in the route's
        // config), not by harness name — a 2M-context route gets the full
        // boost, 1M-context routes get half, and any user-added large-context
        // harness benefits equally.
        const maxIn = svc.maxInputTokens ?? 0;
        if (maxIn >= SCORING.largeContextThreshold) score += SCORING.largeContextBonus;
        else if (maxIn >= SCORING.mediumContextThreshold) score += SCORING.mediumContextBonus;
      }
      // No `taskType === "local"` bonus here: a bonus only reorders WITHIN a
      // tier, and local endpoints sit in the cheap tier, so any healthy tier-1
      // route wins before it is consulted. The cross-tier preference below is
      // the one mechanism for that intent.
      const bucket = tierCandidates.get(tier);
      const candidate: Candidate = {
        score,
        name,
        tier,
        // DECLARED signals only — the same test `routePolicy: "local_only"`
        // uses, never "or the URL looks like localhost" (see the header). A
        // genuine local box declaring the fields is covered; one declaring
        // NOTHING on a known runtime port is inferred local by billing.ts
        // (providerFromService -> isKnownLocalRuntime, ports 11434/1234); and
        // one on some other port declaring nothing never reaches candidacy —
        // route-policy.ts skips it as unknown_billing first.
        local: isLocalRoute(buildRouteBilling(svc)),
        quotaScore,
        qualityScore,
        elo,
        cliCapability: svc.cliCapability,
        capScore,
      };
      if (bucket) bucket.push(candidate);
      else tierCandidates.set(tier, [candidate]);
    }

    if (tierCandidates.size === 0) return null;

    let minConfiguredTier = Infinity;
    for (const svc of Object.values(this.config.services)) {
      if (svc.enabled && svc.tier < minConfiguredTier) minConfiguredTier = svc.tier;
    }

    // Cross-tier rule one: a ROUTE ID in `hints.model` runs that route
    // wherever it sits. It matters most on the HTTP surface, where
    // `/v1/models` advertises route ids as model ids and `service` is refused
    // by name (see http/parse.ts), so this is an OpenAI client's only way to
    // choose a route.
    //
    // Ahead of the 'local' rule below, because naming a route is a specific
    // instruction and a task type is a general preference. Falls through when
    // the named route is not an eligible candidate — blocked, tripped, or
    // excluded by a previous failed attempt — so fallback and every policy
    // refusal are unaffected.
    if (modelIsRouteId && preferredModel !== undefined) {
      const named = [...tierCandidates.values()]
        .flat()
        .find((c) => sameModel(c.name, preferredModel));
      if (named) {
        const others = [...tierCandidates.values()]
          .flat()
          .filter((c) => c.name !== named.name)
          .sort((a, b) => b.score - a.score);
        return this.#decide(named, {
          taskType,
          reason: `route named by hints.model (tier ${named.tier})`,
          compared: [named, ...others],
          modelOverride,
          preferredModel,
          modelIsRouteId,
          skippedRoutes,
          requestedSafety,
          requestedWorkspacePolicy,
        });
      }
    }

    // Cross-tier rule two: `taskType: "local"` prefers the best local route
    // wherever it sits. The schema says 'local' is for "trivial/mechanical"
    // work and "prefers free local endpoints"; tier ranks CAPABILITY, which is
    // the wrong question for a task explicitly marked as not needing it.
    //
    // Tier gating is right in general — it is what stops plan and review work
    // drifting onto a weak route to save a fraction of a point. Falls through
    // when no local route is eligible, so a machine with none routes by tier
    // as usual.
    const localTiers = [...tierCandidates.keys()].sort((a, b) => a - b);
    if (taskType === "local") {
      const localCandidates = localTiers
        .flatMap((t) => tierCandidates.get(t) ?? [])
        .filter((c) => c.local)
        .sort((a, b) => b.score - a.score);
      const best = localCandidates[0];
      if (best) {
        return this.#decide(best, {
          taskType,
          reason:
            `local route preferred for taskType 'local' ` +
            `(${localCandidates.length} local of ${localTiers.reduce((n, t) => n + (tierCandidates.get(t)?.length ?? 0), 0)} eligible)`,
          compared: localCandidates,
          modelOverride,
          preferredModel,
          modelIsRouteId,
          skippedRoutes,
          requestedSafety,
          requestedWorkspacePolicy,
        });
      }
    }

    const sortedTiers = [...tierCandidates.keys()].sort((a, b) => a - b);
    for (const tier of sortedTiers) {
      const candidates = tierCandidates.get(tier);
      if (!candidates || candidates.length === 0) continue;

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0]!;

      const reason =
        tier > minConfiguredTier
          ? `tier ${tier} fallback (all tier ${minConfiguredTier} services exhausted)`
          : `tier ${tier} best (${candidates.length} available)`;

      return this.#decide(best, {
        taskType,
        reason,
        compared: candidates,
        modelOverride,
        preferredModel,
        modelIsRouteId,
        skippedRoutes,
        requestedSafety,
        requestedWorkspacePolicy,
      });
    }

    return null;
  }

  /**
   * Build the RoutingDecision for a winning candidate — one place for all
   * three scored paths (the named-route rule, the 'local' rule, the tier
   * loop). `modelHintMatched` says the picked route declares the requested
   * model; `modelHintDropped` says the value named a route and so was used for
   * routing only. See the forced-service branch for why `model` always prefers
   * the requested value rather than gating on modelMatchesService.
   */
  #decide(
    best: Candidate,
    o: {
      taskType: TaskType;
      reason: string;
      /**
       * Every candidate this one beat, best first. Capped at four and rounded
       * because this is for reading: the choice turns on 0.92 vs 0.81, never
       * on the fifteenth decimal place.
       */
      compared: Candidate[];
      modelOverride: string | undefined;
      preferredModel: string | undefined;
      modelIsRouteId: boolean;
      skippedRoutes: RouteSkip[];
      requestedSafety: RouteHints["safetyProfile"];
      requestedWorkspacePolicy: RouteHints["workspacePolicy"];
    },
  ): RoutingDecision {
    const svc = this.config.services[best.name]!;
    const effectiveSafety = effectiveSafetyProfile(svc, o.requestedSafety);
    return {
      service: best.name,
      tier: best.tier,
      quotaScore: best.quotaScore,
      qualityScore: best.qualityScore,
      cliCapability: best.cliCapability,
      capabilityScore: best.capScore,
      taskType: o.taskType,
      model: o.modelOverride ?? resolveModel(svc, o.taskType),
      ...(o.preferredModel !== undefined
        ? { modelHintMatched: declaresModel(svc, o.preferredModel) }
        : {}),
      ...(o.modelIsRouteId && o.preferredModel !== undefined ? { modelHintDropped: true } : {}),
      elo: best.elo ?? undefined,
      finalScore: best.score,
      reason: o.reason,
      candidates: o.compared.slice(0, 4).map((c) => ({
        route: c.name,
        score: Math.round(c.score * 1000) / 1000,
      })),
      skippedRoutes: o.skippedRoutes.slice(),
      safetyProfile: requestedSafetyProfile(svc, o.requestedSafety),
      effectiveSafetyProfile: effectiveSafety,
      billing: buildRouteBilling(svc),
      workspacePolicy: workspacePolicyFor(svc, effectiveSafety, o.requestedWorkspacePolicy),
    };
  }

  /**
   * Stream events from the chosen dispatcher, with the same fallback logic as
   * `route()`. On a failed dispatch the router picks another service and
   * yields that service's events, so the caller may see events from several
   * services. The last `completion` or `error` event always reflects the final
   * outcome.
   */
  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: {
      hints?: RouteHints;
      maxFallbacks?: number;
      defaultTimeoutMs?: number;
      signal?: AbortSignal;
      onWorkspace?: (workspace: PreparedWorkspace) => void;
    } = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: {
      hints?: RouteHints;
      maxFallbacks?: number;
      defaultTimeoutMs?: number;
      signal?: AbortSignal;
      invoke?: DispatcherInvoke;
      onWorkspace?: (workspace: PreparedWorkspace) => void;
    },
  ): AsyncGenerator<RouterStreamEvent> {
    const hints = opts.hints ?? {};
    const invoke = opts.invoke ?? STREAMING_INVOKE;
    const maxFallbacks = opts.maxFallbacks ?? SCORING.defaultMaxFallbacks;
    const tried = new Set<string>();
    let lastDecision: RoutingDecision | null = null;
    // `defaultTimeoutMs` is a budget for the WHOLE call, not a per-attempt
    // allowance: three fallback attempts each getting the full default would
    // run 3x the stated ceiling before failing conclusively. An explicit
    // `hints.timeoutMs` or a route's own configured `timeoutMs` is a
    // deliberate per-attempt choice and is NOT budgeted this way.
    const callStart = Date.now();

    for (let attempt = 0; attempt <= maxFallbacks; attempt++) {
      const decision = await this.pickService({
        hints,
        prompt,
        files,
        exclude: tried,
      });

      if (decision === null) {
        if (lastDecision === null) {
          const result: DispatchResult = {
            output: "",
            service: "none",
            success: false,
            error: this.noEligibleRouteError(),
            skippedRoutes: this.skippedRoutes(),
          };
          yield { event: { type: "completion", result }, decision: null };
        }
        return;
      }

      lastDecision = decision;
      if (attempt > 0) {
        decision.reason += ` (fallback #${attempt} — prev failed)`;
      }

      const dispatcher = this.dispatchers[decision.service]!;
      const svc = this.config.services[decision.service]!;
      const dispatchOpts: {
        modelOverride?: string;
        safetyProfile?: import("./types.js").SafetyProfile;
        timeoutMs?: number;
      signal?: AbortSignal;
              } = {};
      if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
      if (decision.effectiveSafetyProfile !== undefined) {
        dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
      }
      let effectiveTimeoutMs = hints.timeoutMs ?? svc.timeoutMs;
      if (effectiveTimeoutMs === undefined && opts.defaultTimeoutMs !== undefined) {
        const remaining = opts.defaultTimeoutMs - (Date.now() - callStart);
        if (remaining <= 0 && attempt > 0) {
          // Whole-call budget already spent on earlier attempts — the
          // previous attempt's completion event was already yielded, so
          // stop retrying instead of starting another full-length attempt.
          return;
        }
        effectiveTimeoutMs = Math.max(remaining, 1);
      }
      if (effectiveTimeoutMs !== undefined) dispatchOpts.timeoutMs = effectiveTimeoutMs;
      if (opts.signal) dispatchOpts.signal = opts.signal;

      let finalResult: DispatchResult | null = null;
      for await (const event of streamWithWorkspacePolicy(
        svc,
        decision.service,
        decision.effectiveSafetyProfile,
        decision.workspacePolicy,
        workingDir,
        files,
        (effectiveWorkingDir, effectiveFiles) =>
          invoke(dispatcher, prompt, effectiveFiles, effectiveWorkingDir, dispatchOpts),
        opts.onWorkspace,
      )) {
        yield { event, decision };
        if (event.type === "completion") {
          finalResult = event.result;
        }
      }
      if (finalResult === null) {
        // Dispatcher misbehaved — synthesize a failure and YIELD it so the
        // caller always receives a terminal completion event for the attempt,
        // then record it for breaker/quota accounting.
        finalResult = {
          output: "",
          service: decision.service,
          success: false,
          error: "Dispatcher stream ended without a completion event",
        };
        yield { event: { type: "completion", result: finalResult }, decision };
      }
      this.handleResult(decision.service, finalResult, decision);

      if (finalResult.success) return;
      // Rate-limited and transient failures alike: the breaker state was
      // updated by handleResult; exclude this service and fall back to the
      // next-best candidate rather than aborting the caller's request.
      tried.add(decision.service);
    }
  }

  /**
   * Stream from a specific service, bypassing tier selection. Same semantics
   * as `routeTo()` but yields events in real time.
   */
  streamTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
    opts: ExplicitDispatchOpts = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.#runStreamTo(service, prompt, files, workingDir, opts);
  }

  async *#runStreamTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
    opts: ExplicitDispatchOpts & { invoke?: DispatcherInvoke },
  ): AsyncGenerator<RouterStreamEvent> {
    const invoke = opts.invoke ?? STREAMING_INVOKE;
    // `Object.hasOwn`, not `in`: an inherited key resolves to a real function
    // on the next line's lookup, so `dispatcher === undefined` would not catch
    // it either.
    if (!Object.hasOwn(this.dispatchers, service)) {
      yield {
        event: {
          type: "completion",
          result: {
            output: "",
            service,
            success: false,
            error: unknownServiceError(service, Object.keys(this.dispatchers)),
          },
        },
        decision: null,
      };
      return;
    }

    const breaker = this.breakers.get(service);
    if (breaker && breaker.isTripped) {
      const cd = Math.round(breaker.cooldownRemaining() * 10) / 10;
      yield {
        event: {
          type: "completion",
          result: {
            output: "",
            service,
            success: false,
            error: `'${service}' is circuit-broken — ${cd}s cooldown remaining`,
          },
        },
        decision: null,
      };
      return;
    }

    const svc = this.config.services[service]!;
    const dispatcher = this.dispatchers[service]!;
    const policy = evaluateRoutePolicy(service, svc, {
      dispatcher,
      ...(opts.safetyProfile !== undefined ? { requestedSafetyProfile: opts.safetyProfile } : {}),
      ...(opts.routePolicy !== undefined ? { routePolicy: opts.routePolicy } : {}),
      ...(opts.taskType !== undefined ? { taskType: opts.taskType } : {}),
    });
    if (policy.blocked) {
      const result: DispatchResult = {
        output: "",
        service,
        success: false,
        // Named, because a skip message is written as a CLAUSE about a route
        // ("route is disabled", "this is an HTTP model endpoint — …") for the
        // scored path, which prefixes it with the route it is about. Passed
        // through verbatim here it reached the user as a sentence with no
        // subject: `harness-dispatch dispatch --service x` answered "this is
        // an HTTP model endpoint — …" and never said which route that was.
        error:
          policy.skipped !== undefined
            ? `${service}: ${policy.skipped.message}`
            : `${service}: route blocked by policy`,
      };
      if (policy.skipped) result.skippedRoutes = [policy.skipped];
      yield {
        event: {
          type: "completion",
          result,
        },
        decision: null,
      };
      return;
    }
    const quotaScore = await this.quota.getQuotaScore(service);
    const { qualityScore, elo } = await this.leaderboard.getQualityScore(
      svc.leaderboardModel,
      svc.thinkingLevel,
    );
    const taskType: TaskType = opts.taskType ?? "";
    const capScore = capabilityScore(svc, taskType);
    const effectiveSafety = effectiveSafetyProfile(svc, opts.safetyProfile);
    const decision: RoutingDecision = {
      service,
      tier: svc.tier,
      quotaScore,
      qualityScore,
      cliCapability: svc.cliCapability,
      capabilityScore: capScore,
      taskType,
      ...resolveNamedRouteModel(service, svc, opts.model, taskType),
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight,
      reason: "explicit",
      safetyProfile: requestedSafetyProfile(svc, opts.safetyProfile),
      effectiveSafetyProfile: effectiveSafety,
      billing: buildRouteBilling(svc),
      workspacePolicy: workspacePolicyFor(svc, effectiveSafety, opts.workspacePolicy),
    };

    const dispatchOpts: {
      modelOverride?: string;
      safetyProfile?: import("./types.js").SafetyProfile;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {};
    if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
    if (decision.effectiveSafetyProfile !== undefined) {
      dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
    }
    const effectiveTimeoutMs = opts.timeoutMs ?? svc.timeoutMs ?? opts.defaultTimeoutMs;
    if (effectiveTimeoutMs !== undefined) dispatchOpts.timeoutMs = effectiveTimeoutMs;
    if (opts.signal) dispatchOpts.signal = opts.signal;

    let finalResult: DispatchResult | null = null;
    for await (const event of streamWithWorkspacePolicy(
      svc,
      service,
      decision.effectiveSafetyProfile,
      decision.workspacePolicy,
      workingDir,
      files,
      (effectiveWorkingDir, effectiveFiles) =>
        invoke(dispatcher, prompt, effectiveFiles, effectiveWorkingDir, dispatchOpts),
      opts.onWorkspace,
    )) {
      yield { event, decision };
      if (event.type === "completion") finalResult = event.result;
    }
    if (finalResult === null) {
      finalResult = {
        output: "",
        service,
        success: false,
        error: "Dispatcher stream ended without a completion event",
      };
      yield { event: { type: "completion", result: finalResult }, decision };
    }
    this.handleResult(service, finalResult, decision);
  }

  /**
   * Route a task, with automatic fallback on transient failures.
   *
   * Built on `stream()`: the per-attempt result is captured from the
   * `completion` event and drives the fallback loop. When pickService returns
   * null with no prior attempts the result is an error DispatchResult; on a
   * later fallback round that returns null, the last attempt's
   * result+decision stands.
   */
  async route(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number; signal?: AbortSignal } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    return withRouterSpan(
      {
        "router.op": "route",
        ...(opts.hints?.taskType ? { task_type: opts.hints.taskType } : {}),
      },
      async (span) => {
        const out = await this.#routeImpl(prompt, files, workingDir, opts);
        if (out.decision) {
          span.setAttribute("service", out.decision.service);
          span.setAttribute("tier", out.decision.tier);
        }
        span.setAttribute("success", out.result.success);
        return out;
      },
    );
  }

  /**
   * The buffered entry point, drained from the one shared loop.
   *
   * Selection, fallback, timeout precedence, workspace policy and breaker
   * accounting all live in `#runStream`, so there is no second copy to drift.
   * `BUFFERED_INVOKE` keeps the one thing that genuinely differs: the
   * dispatcher's own `dispatch()`, so a route with a non-streaming fast path
   * still uses it.
   */
  async #routeImpl(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number; signal?: AbortSignal } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    let result: DispatchResult | null = null;
    let decision: RoutingDecision | null = null;
    for await (const event of this.#runStream(prompt, files, workingDir, {
      ...opts,
      invoke: BUFFERED_INVOKE,
    })) {
      if (event.decision !== null) decision = event.decision;
      if (event.event.type === "completion") result = event.event.result;
    }
    return {
      result:
        result ??
        ({
          output: "",
          service: "none",
          success: false,
          error: "Router exhausted all fallback attempts.",
        } as DispatchResult),
      decision,
    };
  }

  /**
   * Dispatch to a specific service, bypassing tier selection.
   */
  async routeTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
    opts: ExplicitDispatchOpts = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    // Drained from `#runStreamTo`, for the reasons on `#routeImpl`: one
    // explicit-dispatch body, so the timeout rule cannot diverge.
    let result: DispatchResult | null = null;
    let decision: RoutingDecision | null = null;
    for await (const event of this.#runStreamTo(service, prompt, files, workingDir, {
      ...opts,
      invoke: BUFFERED_INVOKE,
    })) {
      if (event.decision !== null) decision = event.decision;
      if (event.event.type === "completion") result = event.event.result;
    }
    return {
      result:
        result ??
        ({
          output: "",
          service,
          success: false,
          error: "Dispatcher stream ended without a completion event",
        } as DispatchResult),
      decision,
    };
  }

  private handleResult(
    service: string,
    result: DispatchResult,
    decision?: RoutingDecision | null,
  ): void {
    logDispatch(service, result, decision);

    // A rejected INPUT says nothing about the route.
    //
    // The prompt-too-long refusal happens before any process is spawned and
    // fails identically on every argv route, so counting it would charge a
    // cascade of failures — and eventually a trip — to routes that were never
    // asked to do anything.
    //
    // Still logged, so the dispatch is visible in the dispatch log; simply not
    // charged to the route's counters or its breaker.
    if (result.inputRejected) return;

    this.quota.recordResult(service, result);
    const breaker = this.breakers.get(service);
    if (!breaker) return;

    // Apply the event to the PERSISTED state, then adopt the result.
    //
    // Mutating the in-memory breaker and writing its snapshot loses events
    // across processes: every dispatch runs in a detached child that loaded
    // its own breaker at boot, so concurrent failures all read 0 and all write
    // 1, the breaker never trips, and a dead route stays selectable.
    //
    // update() serialises the read-modify-write, so each process contributes
    // exactly one event; restoring afterwards keeps this process's routing
    // decisions consistent with what is now on disk. Wrapped, because a throw
    // on the result path would discard work the user already paid for.
    const merged = this.safeBreakerUpdate(service, (current) => {
      const shared = new CircuitBreaker();
      if (current) shared.restore(current);
      if (result.success) {
        shared.recordSuccess();
      } else if (result.rateLimited) {
        shared.trip(result.retryAfter);
      } else {
        shared.recordFailure(result.retryAfter);
      }
      return shared.snapshot();
    });
    breaker.restore(merged);
  }

  /**
   * Re-hydrate from the persisted store before reporting.
   *
   * The authority for breaker state lives on disk (dispatches run in detached
   * children and handleResult merges each failure into the shared store) while
   * this Router hydrates its in-memory breakers once, in its constructor.
   * Without a refresh here, `status` would report a route healthy and ready
   * for the life of the server process while every dispatch refused it as
   * circuit-broken.
   */
  circuitBreakerStatus(): Record<string, ReturnType<CircuitBreaker["status"]>> {
    this.refreshBreakersFromStore();
    const out: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, b] of this.breakers) out[name] = b.status();
    return out;
  }

  /**
   * Routes whose persisted breaker record could not be read, as of the last
   * store refresh. Reported rather than swallowed: an unreadable record is
   * indistinguishable from a healthy one in the in-memory breaker, so without
   * this the only honest answer available ("unknown") could not be given.
   */
  breakerStateUnreadable(): string[] {
    return this.breakerStore.unreadableRoutes();
  }

  /**
   * Adopt any breaker state written by another process.
   *
   * Only ever restores — a persisted snapshot already encodes the cooldown as
   * a wall-clock deadline, so a stale one expires on read rather than needing
   * to be aged out here.
   */
  private safeBreakerUpdate(
    service: string,
    mutate: (current: CircuitBreakerSnapshot | undefined) => CircuitBreakerSnapshot,
  ): CircuitBreakerSnapshot {
    try {
      return this.breakerStore.update(service, mutate);
    } catch {
      // Fall back to this process's own view rather than losing the result.
      return mutate(this.breakers.get(service)?.snapshot());
    }
  }

  private refreshBreakersFromStore(): void {
    let persisted: Record<string, CircuitBreakerSnapshot>;
    try {
      persisted = this.breakerStore.loadAll();
    } catch {
      return; // Reporting must not fail because the store is unreadable.
    }
    for (const [name, snapshot] of Object.entries(persisted)) {
      const breaker = this.breakers.get(name);
      if (breaker) breaker.restore(snapshot);
    }
  }
}

export { drainDispatcherStream };
