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
 *  - +0.3 when task_type="local" and the service is an openai_compatible
 *    endpoint on localhost / 127.0.0.1.
 *
 * Tier auto-derivation
 * --------------------
 * If a service has `leaderboardModel` set in config, its tier is
 * auto-derived from the Arena ELO score via LeaderboardCache.autoTier().
 * Explicit `tier` in config is the fallback when ELO is unavailable.
 *
 * R3: adds `stream()` / `streamTo()` that emit `DispatcherEvent`s with an
 * attached `RoutingDecision`. The buffered `route` / `routeTo` methods are
 * reimplemented on top of the streaming primitives.
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
import path from "node:path";
import { CircuitBreaker, type CircuitBreakerSnapshot } from "./circuit-breaker.js";
import { BreakerStore } from "./breaker-store.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { drainDispatcherStream } from "./dispatchers/base.js";
import { withDispatcherSpan, withRouterSpan } from "./observability/spans.js";
import { buildRouteBilling } from "./billing.js";
import { logDispatch } from "./dispatch-log.js";
import { effectiveSafetyProfile, requestedSafetyProfile } from "./safety.js";
import { evaluateRoutePolicy, nonLocalIncludedRoutePenalty } from "./route-policy.js";
import { acquireWorkspaceLock } from "./workspace-lock.js";
import {
  prepareWorkspace,
  workspacePolicyFor,
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
 * `service` is a raw string from the caller — a near-miss ("codex" for
 * "codex_cli") used to fail with no hint at what WOULD have worked, costing
 * a round-trip to `usage` to find out.
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
   * precedence, so it never silently overrides a real value. Used by `job`
   * to give background dispatches a generous ceiling without a caller
   * having to know to ask for one; `code` (which blocks the MCP call) does
   * not set this and keeps the dispatcher's own short default.
   */
  defaultTimeoutMs?: number;
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
 * flag is a different question, and the schema is explicit about which:
 * "modelHintMatched: true means the picked route actually declares this
 * model; false means it was forwarded blind and you should treat the result
 * with more suspicion". Reporting a name match as true told the agent the
 * opposite of the truth on the one signal the schema points it at for
 * self-correction.
 */
function declaresModel(svc: ServiceConfig, model: string | undefined): boolean {
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
 * over-specifying ("use codex_cli, with codex_cli"), and forwarding it sent
 * `--model codex_cli` to Codex, which rejected it with a real failed job and
 * a breaker event.
 *
 * Shared because it was not. The explicit path never had the suppression and
 * reported neither field, so 0.7.8's schema text — "a value that names a
 * configured route is NOT sent on as a model" — was true on the forced path
 * and false here, on the parameter the docs are written about. Three
 * independent copies of one rule is how they diverged; keep it in one place.
 *
 * The SCORED path deliberately differs: no service was named there, so any
 * route id is a routing nudge rather than a model.
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

async function withWorkspacePolicy<T>(
  svc: ServiceConfig,
  serviceName: string,
  safetyProfile: SafetyProfile | undefined,
  requestedPolicy: ServiceConfig["workspacePolicy"] | undefined,
  workingDir: string,
  files: string[],
  fn: (effectiveWorkingDir: string, effectiveFiles: string[]) => Promise<T>,
): Promise<T> {
  const policy = workspacePolicyFor(svc, safetyProfile, requestedPolicy);
  if (policy === "shared_locked") {
    const release = await acquireWorkspaceLock(workingDir);
    try {
      const workspace = await prepareWorkspace({
        routeName: serviceName,
        policy,
        workingDir,
        files,
      });
      const result = await fn(workspace.effectiveWorkingDir, workspace.files);
      return await workspace.finish(result as DispatchResult) as T;
    } finally {
      release();
    }
  }

  const shouldLockSnapshot = safetyProfile !== "read_only" && (policy === "copy" || policy === "git_worktree");
  const release = shouldLockSnapshot ? await acquireWorkspaceLock(workingDir) : undefined;
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>>;
  try {
    workspace = await prepareWorkspace({
      routeName: serviceName,
      policy,
      workingDir,
      files,
    });
  } finally {
    release?.();
  }
  const result = await fn(workspace.effectiveWorkingDir, workspace.files);
  return await workspace.finish(result as DispatchResult) as T;
}

async function* streamWithWorkspacePolicy<T>(
  svc: ServiceConfig,
  serviceName: string,
  safetyProfile: SafetyProfile | undefined,
  requestedPolicy: ServiceConfig["workspacePolicy"] | undefined,
  workingDir: string,
  files: string[],
  makeStream: (effectiveWorkingDir: string, effectiveFiles: string[]) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const policy = workspacePolicyFor(svc, safetyProfile, requestedPolicy);
  if (policy === "shared_locked") {
    const release = await acquireWorkspaceLock(workingDir);
    try {
      const workspace = await prepareWorkspace({
        routeName: serviceName,
        policy,
        workingDir,
        files,
      });
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
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>>;
  try {
    workspace = await prepareWorkspace({
      routeName: serviceName,
      policy,
      workingDir,
      files,
    });
  } finally {
    release?.();
  }
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
 * decision. The decision is emitted on the first event of each dispatch
 * attempt (so consumers can show "routing to claude_code" before the first
 * token arrives) and is also attached to every subsequent event in case the
 * consumer missed the first.
 */
export interface RouterStreamEvent {
  event: DispatcherEvent;
  decision: RoutingDecision | null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True only when baseUrl's HOST is loopback — see billing.ts hostOf(). */
function isLoopbackUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

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
   * list of guesses.
   *
   * The message used to say "all are disabled, exhausted, or circuit-broken"
   * whatever the cause, and print every breaker alongside it. A route skipped
   * as `paid_blocked` — a billing policy the operator chose — was therefore
   * reported as a health problem, next to a breaker blob reading
   * `tripped:false, failures:0`. That is this project's own counter-signal:
   * making a healthy route look unreliable. `skippedRoutes` carried the true
   * reason all along, so only the headline a human reads was wrong.
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
    // A ROUTE ID is not a model name.
    //
    // `hints.model` accepts either — the schema says so, and naming a route id
    // is the documented way to nudge routing toward it. But the value was then
    // ALSO forwarded to the winning route as `--model`, and when that was some
    // other route the result was a real provider call with a nonsense model.
    // Measured: one dispatch hinting a configured local route id was tried
    // against four subscription CLIs, each rejecting `--model <route id>`,
    // spending five calls and tripping two breakers. This product's own
    // counter-signal is "a route that is configured, reported ready, and never
    // actually used".
    //
    // So a route id still steers routing (modelMatchesService below matches on
    // the route NAME) and is simply not passed on as a model override. A value
    // that is not a configured route id keeps today's forward-blind behaviour,
    // which is what makes an undeclared-but-real model usable.
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
        // the CLI rejects it, and silently discarding the request gave a
        // mismatched hints.model no error and no explanation. See
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
        score += 0.5;
      }
      if (preferLargeContext) {
        // Boost by DECLARED context size (max_input_tokens in the route's
        // config), not by harness name — a 2M-context route (e.g.
        // Antigravity's default) gets the full boost, 1M-context routes get
        // half, and any user-added large-context harness benefits equally.
        const maxIn = svc.maxInputTokens ?? 0;
        if (maxIn >= 2_000_000) score += 0.3;
        else if (maxIn >= 1_000_000) score += 0.15;
      }
      // Exact host match, not substring — a remote URL merely CONTAINING
      // "localhost" is not a local route. Same defect as billing.ts's two
      // predicates; see hostOf() there.
      if (taskType === "local" && svc.type === "openai_compatible" && isLoopbackUrl(svc.baseUrl)) {
        score += 0.3;
      }

      const bucket = tierCandidates.get(tier);
      const candidate: Candidate = {
        score,
        name,
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

    const sortedTiers = [...tierCandidates.keys()].sort((a, b) => a - b);
    for (const tier of sortedTiers) {
      const candidates = tierCandidates.get(tier);
      if (!candidates || candidates.length === 0) continue;

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0]!;
      const svc = this.config.services[best.name]!;

      const reason =
        tier > minConfiguredTier
          ? `tier ${tier} fallback (all tier ${minConfiguredTier} services exhausted)`
          : `tier ${tier} best (${candidates.length} available)`;

      const effectiveSafety = effectiveSafetyProfile(svc, requestedSafety);
      return {
        service: best.name,
        tier,
        quotaScore: best.quotaScore,
        qualityScore: best.qualityScore,
        cliCapability: best.cliCapability,
        capabilityScore: best.capScore,
        taskType,
        // See the forced-service branch above for why this always prefers
        // the requested model rather than gating on modelMatchesService.
        model: modelOverride ?? resolveModel(svc, taskType),
        ...(preferredModel !== undefined
          ? { modelHintMatched: declaresModel(svc, preferredModel) }
          : {}),
        ...(modelIsRouteId && preferredModel !== undefined ? { modelHintDropped: true } : {}),
        elo: best.elo ?? undefined,
        finalScore: best.score,
        reason,
        skippedRoutes: skippedRoutes.slice(),
        safetyProfile: requestedSafetyProfile(svc, requestedSafety),
        effectiveSafetyProfile: effectiveSafety,
        billing: buildRouteBilling(svc),
        workspacePolicy: workspacePolicyFor(svc, effectiveSafety, requestedWorkspacePolicy),
      };
    }

    return null;
  }

  /**
   * Stream events from the chosen dispatcher, with the same fallback logic
   * as `route()`. When a dispatch fails (non-rate-limit), the router picks
   * another service and yields that service's events — so the caller sees
   * events from potentially multiple services during fallback.
   *
   * The last `completion` or `error` event always reflects the final
   * outcome (success-with-fallback or all-attempts-failed).
   */
  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number; defaultTimeoutMs?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number; defaultTimeoutMs?: number; signal?: AbortSignal },
  ): AsyncGenerator<RouterStreamEvent> {
    const hints = opts.hints ?? {};
    const maxFallbacks = opts.maxFallbacks ?? 2;
    const tried = new Set<string>();
    let lastDecision: RoutingDecision | null = null;
    // `defaultTimeoutMs` (currently only `job`'s background ceiling) is a
    // budget for the WHOLE call, not a per-attempt allowance — without this,
    // 3 fallback attempts (default + 2 retries) each getting the full
    // default would let one `job` call run 3x its stated ceiling before
    // failing conclusively. An explicit `hints.timeoutMs` or a route's own
    // configured `timeoutMs` is a deliberate per-attempt choice and is NOT
    // budgeted this way.
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
          dispatcher.stream(prompt, effectiveFiles, effectiveWorkingDir, dispatchOpts),
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
    opts: ExplicitDispatchOpts,
  ): AsyncGenerator<RouterStreamEvent> {
    if (!(service in this.dispatchers)) {
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
    });
    if (policy.blocked) {
      const result: DispatchResult = {
        output: "",
        service,
        success: false,
        error: policy.skipped?.message ?? "Route blocked by policy",
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
        dispatcher.stream(prompt, effectiveFiles, effectiveWorkingDir, dispatchOpts),
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
   * R3: reimplemented on top of `stream()`. The per-attempt result is
   * captured from the `completion` event and drives the fallback loop.
   *
   * The old route() also had a quirk: when pickService returned null with
   * no prior attempts, it yielded an error DispatchResult. On a later
   * fallback round that returned null it returned the last attempt's
   * result+decision. The streaming-based reimplementation below preserves
   * the same externally observable behaviour for existing tests.
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

  async #routeImpl(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number; signal?: AbortSignal } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    const hints = opts.hints ?? {};
    const maxFallbacks = opts.maxFallbacks ?? 2;
    const tried = new Set<string>();
    let lastResult: DispatchResult | null = null;
    let lastDecision: RoutingDecision | null = null;

    for (let attempt = 0; attempt <= maxFallbacks; attempt++) {
      const decision = await this.pickService({
        hints,
        prompt,
        files,
        exclude: tried,
      });

      if (decision === null) {
        if (lastResult !== null) {
          return { result: lastResult, decision: lastDecision };
        }
        return {
          result: {
            output: "",
            service: "none",
            success: false,
            error: this.noEligibleRouteError(),
            skippedRoutes: this.skippedRoutes(),
          } as DispatchResult,
          decision: null,
        };
      }

      const dispatcher = this.dispatchers[decision.service]!;
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
      {
        const effectiveTimeoutMs =
          hints.timeoutMs ?? this.config.services[decision.service]!.timeoutMs;
        if (effectiveTimeoutMs !== undefined) dispatchOpts.timeoutMs = effectiveTimeoutMs;
        if (opts.signal) dispatchOpts.signal = opts.signal;
      }
      // Prefer the buffered dispatch path when it's available — many R1/R2
      // tests assert on dispatcher.dispatch being called once; if we always
      // went through stream() those assertions would break. Dispatchers that
      // extend BaseDispatcher still ultimately funnel through stream(), but
      // dispatchers (like OpenAICompatibleDispatcher) that override dispatch
      // keep their fast-path.
      const spanAttrs: import("./observability/spans.js").DispatcherSpanAttrs = {
        "dispatcher.id": decision.service,
      };
      if (decision.model !== undefined) spanAttrs.model = decision.model;
      if (decision.taskType) spanAttrs["task_type"] = decision.taskType;
      const result = await withWorkspacePolicy(
        this.config.services[decision.service]!,
        decision.service,
        decision.effectiveSafetyProfile,
        decision.workspacePolicy,
        workingDir,
        files,
        (effectiveWorkingDir, effectiveFiles) =>
          withDispatcherSpan(
            "dispatch",
            spanAttrs,
            async (span) => {
              const r = await dispatcher.dispatch(
                prompt,
                effectiveFiles,
                effectiveWorkingDir,
                dispatchOpts,
              );
          span.setAttribute("success", r.success);
          if (r.rateLimited) span.setAttribute("rate_limited", true);
          if (r.tokensUsed) {
            span.setAttribute("tokens.input", r.tokensUsed.input);
            span.setAttribute("tokens.output", r.tokensUsed.output);
          }
          return r;
            },
          ),
      );
      this.handleResult(decision.service, result, decision);
      lastResult = result;
      lastDecision = decision;

      if (result.success) {
        if (attempt > 0) decision.reason += ` (fallback #${attempt} — prev failed)`;
        return { result, decision };
      }
      // Rate-limited and transient failures alike: handleResult already
      // tripped the breaker; exclude this service and fall back to the
      // next-best candidate rather than aborting the caller's request.
      tried.add(decision.service);
    }

    return {
      result:
        lastResult ??
        ({
          output: "",
          service: "none",
          success: false,
          error: "Router exhausted all fallback attempts.",
        } as DispatchResult),
      decision: lastDecision,
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
    if (!(service in this.dispatchers)) {
      return {
        result: {
          output: "",
          service,
          success: false,
          error: unknownServiceError(service, Object.keys(this.dispatchers)),
        } as DispatchResult,
        decision: null,
      };
    }

    const breaker = this.breakers.get(service);
    if (breaker && breaker.isTripped) {
      const cd = Math.round(breaker.cooldownRemaining() * 10) / 10;
      return {
        result: {
          output: "",
          service,
          success: false,
          error: `'${service}' is circuit-broken — ${cd}s cooldown remaining`,
        } as DispatchResult,
        decision: null,
      };
    }

    const svc = this.config.services[service]!;
    const dispatcher = this.dispatchers[service]!;
    const policy = evaluateRoutePolicy(service, svc, {
      dispatcher,
      ...(opts.safetyProfile !== undefined ? { requestedSafetyProfile: opts.safetyProfile } : {}),
      ...(opts.routePolicy !== undefined ? { routePolicy: opts.routePolicy } : {}),
    });
    if (policy.blocked) {
      const result: DispatchResult = {
        output: "",
        service,
        success: false,
        error: policy.skipped?.message ?? "Route blocked by policy",
      };
      if (policy.skipped) result.skippedRoutes = [policy.skipped];
      return {
        result,
        decision: null,
      };
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
    {
      const effectiveTimeoutMs = opts.timeoutMs ?? svc.timeoutMs;
      if (effectiveTimeoutMs !== undefined) dispatchOpts.timeoutMs = effectiveTimeoutMs;
      if (opts.signal) dispatchOpts.signal = opts.signal;
    }
    const result = await withWorkspacePolicy(
      svc,
      service,
      decision.effectiveSafetyProfile,
      decision.workspacePolicy,
      workingDir,
      files,
      (effectiveWorkingDir, effectiveFiles) =>
        this.dispatchers[service]!.dispatch(
          prompt,
          effectiveFiles,
          effectiveWorkingDir,
          dispatchOpts,
        ),
    );
    this.handleResult(service, result, decision);
    return { result, decision };
  }

  private handleResult(
    service: string,
    result: DispatchResult,
    decision?: RoutingDecision | null,
  ): void {
    logDispatch(service, result, decision);

    // A rejected INPUT says nothing about the route.
    //
    // The prompt-too-long refusal happens before any process is spawned, and
    // it fails identically on every argv route — so a single over-long prompt
    // cascading through three routes counted three calls and three failures,
    // and three such dispatches opened healthy routes for 300 seconds. The
    // route was never asked to do anything. Counting it is the shape
    // PRODUCT.md names as a counter-signal: usage numbers that make a working
    // route look unreliable.
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
    // its own breaker at boot, so two concurrent failures both read 0 and both
    // write 1. Measured: 8 concurrent failures persisted as `failures: 1` and
    // the breaker never tripped, leaving a dead route selectable.
    //
    // update() serialises the read-modify-write, so each process contributes
    // exactly one event; restoring afterwards keeps this process's routing
    // decisions consistent with what is now on disk.
    // Persistence must never fail a completed dispatch. The store guards its
    // own writes, but handleResult runs on the result path and a throw here
    // would discard work the user already paid for.
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
   * Dispatches run in DETACHED child processes, and handleResult now merges
   * each failure into the shared store — so the authority for breaker state
   * lives on disk, while this Router hydrates its in-memory breakers once, in
   * its constructor. Without a refresh here the two surfaces an agent is told
   * to consult went stale for the life of the server process:
   *
   *   status  -> breaker=closed failures=0, route listed in "Ready to route"
   *   dispatch-> "all are disabled, exhausted, or circuit-broken"
   *              {"fail_cli":{"tripped":true,"failures":5}}
   *
   * That contradiction was introduced by moving the authority to disk without
   * moving the readers with it. This is the readers catching up.
   */
  circuitBreakerStatus(): Record<string, ReturnType<CircuitBreaker["status"]>> {
    this.refreshBreakersFromStore();
    const out: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, b] of this.breakers) out[name] = b.status();
    return out;
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
