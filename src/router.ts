/**
 * Load-balancing router for harness-router.
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
 *  - +0.3 when prefer_large_context is set and the service's harness is
 *    antigravity or antigravity_cli.
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
import { CircuitBreaker } from "./circuit-breaker.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { drainDispatcherStream } from "./dispatchers/base.js";
import { withDispatcherSpan, withRouterSpan } from "./observability/spans.js";
import { buildRouteBilling } from "./billing.js";
import { effectiveSafetyProfile, requestedSafetyProfile } from "./safety.js";
import { evaluateRoutePolicy, nonLocalIncludedRoutePenalty } from "./route-policy.js";
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

const workspaceLocks = new Map<string, Promise<void>>();

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
  safetyProfile?: SafetyProfile;
  workspacePolicy?: ServiceConfig["workspacePolicy"];
  routePolicy?: import("./types.js").RoutePolicy;
  model?: string;
  taskType?: TaskType;
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

function capabilityScore(svc: ServiceConfig, taskType: TaskType): number {
  if (!TASK_TYPES_WITH_CAPABILITY.has(taskType)) return 1.0;
  const key = taskType as "execute" | "plan" | "review";
  return svc.capabilities[key] ?? 1.0;
}

function workspaceLockKey(workingDir: string): string {
  const resolved = path.resolve(workingDir || process.cwd());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function acquireWorkspaceLock(workingDir: string): Promise<() => void> {
  const key = workspaceLockKey(workingDir);
  const previous = workspaceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.catch(() => undefined).then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  workspaceLocks.set(key, current);
  await previous.catch(() => undefined);
  return () => {
    release();
    if (workspaceLocks.get(key) === current) {
      workspaceLocks.delete(key);
    }
  };
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

export class Router {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();
  private lastSkippedRoutes: RouteSkip[] = [];

  constructor(
    private readonly config: RouterConfig,
    private readonly quota: QuotaCache,
    private readonly dispatchers: Record<string, Dispatcher>,
    private readonly leaderboard: LeaderboardCache,
  ) {
    for (const name of Object.keys(config.services)) {
      this.breakers.set(name, new CircuitBreaker());
    }
  }

  getBreaker(service: string): CircuitBreaker | undefined {
    return this.breakers.get(service);
  }

  skippedRoutes(): RouteSkip[] {
    return this.lastSkippedRoutes.slice();
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
    const preferredModel = hints.model;
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
        // Always pass through a requested model, even if it doesn't match
        // anything this route statically declares — modelMatchesService only
        // affects scoring (which route gets picked), not whether the
        // caller's request reaches the dispatcher. A route the router
        // "doesn't recognize" a model for may still support it (CLIs accept
        // arbitrary --model values); silently discarding the request instead
        // meant a mismatched hints.model got no error and no explanation.
        model: preferredModel ?? resolveModel(svc, taskType),
        ...(preferredModel !== undefined
          ? { modelHintMatched: modelMatchesService(forceService, svc, preferredModel) }
          : {}),
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
      if (
        preferLargeContext &&
        (harnessKey === "antigravity_cli" || harnessKey === "antigravity")
      ) {
        score += 0.3;
      }
      if (
        taskType === "local" &&
        svc.type === "openai_compatible" &&
        (svc.baseUrl?.includes("localhost") || svc.baseUrl?.includes("127.0.0.1"))
      ) {
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
        model: preferredModel ?? resolveModel(svc, taskType),
        ...(preferredModel !== undefined
          ? { modelHintMatched: modelMatchesService(best.name, svc, preferredModel) }
          : {}),
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
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number },
  ): AsyncGenerator<RouterStreamEvent> {
    const hints = opts.hints ?? {};
    const maxFallbacks = opts.maxFallbacks ?? 2;
    const tried = new Set<string>();
    let lastDecision: RoutingDecision | null = null;

    for (let attempt = 0; attempt <= maxFallbacks; attempt++) {
      const decision = await this.pickService({
        hints,
        prompt,
        files,
        exclude: tried,
      });

      if (decision === null) {
        if (lastDecision === null) {
          const breakerInfo: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
          for (const [name, b] of this.breakers) breakerInfo[name] = b.status();
          const result: DispatchResult = {
            output: "",
            service: "none",
            success: false,
            error:
              "No available services — all are disabled, exhausted, or circuit-broken. " +
              `Breaker state: ${JSON.stringify(breakerInfo)}`,
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
      const dispatchOpts: { modelOverride?: string; safetyProfile?: import("./types.js").SafetyProfile } = {};
      if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
      if (decision.effectiveSafetyProfile !== undefined) {
        dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
      }

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
      this.handleResult(decision.service, finalResult);

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
            error: `Unknown service: ${service}`,
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
      model: opts.model ?? resolveModel(svc, taskType),
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight,
      reason: "explicit",
      safetyProfile: requestedSafetyProfile(svc, opts.safetyProfile),
      effectiveSafetyProfile: effectiveSafety,
      billing: buildRouteBilling(svc),
      workspacePolicy: workspacePolicyFor(svc, effectiveSafety, opts.workspacePolicy),
    };

    const dispatchOpts: { modelOverride?: string; safetyProfile?: import("./types.js").SafetyProfile } = {};
    if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
    if (decision.effectiveSafetyProfile !== undefined) {
      dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
    }

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
    this.handleResult(service, finalResult);
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
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
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
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
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
        const breakerInfo: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
        for (const [name, b] of this.breakers) breakerInfo[name] = b.status();
        return {
          result: {
            output: "",
            service: "none",
            success: false,
            error:
              "No available services — all are disabled, exhausted, or circuit-broken. " +
              `Breaker state: ${JSON.stringify(breakerInfo)}`,
            skippedRoutes: this.skippedRoutes(),
          } as DispatchResult,
          decision: null,
        };
      }

      const dispatcher = this.dispatchers[decision.service]!;
      const dispatchOpts: { modelOverride?: string; safetyProfile?: import("./types.js").SafetyProfile } = {};
      if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
      if (decision.effectiveSafetyProfile !== undefined) {
        dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
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
      this.handleResult(decision.service, result);
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
          error: `Unknown service: ${service}`,
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
      model: opts.model ?? resolveModel(svc, taskType),
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight,
      reason: "explicit",
      safetyProfile: requestedSafetyProfile(svc, opts.safetyProfile),
      effectiveSafetyProfile: effectiveSafety,
      billing: buildRouteBilling(svc),
      workspacePolicy: workspacePolicyFor(svc, effectiveSafety, opts.workspacePolicy),
    };
    const dispatchOpts: { modelOverride?: string; safetyProfile?: import("./types.js").SafetyProfile } = {};
    if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
    if (decision.effectiveSafetyProfile !== undefined) {
      dispatchOpts.safetyProfile = decision.effectiveSafetyProfile;
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
    this.handleResult(service, result);
    return { result, decision };
  }

  private handleResult(service: string, result: DispatchResult): void {
    this.quota.recordResult(service, result);
    const breaker = this.breakers.get(service);
    if (!breaker) return;
    if (result.success) {
      breaker.recordSuccess();
    } else if (result.rateLimited) {
      breaker.trip(result.retryAfter);
    } else {
      breaker.recordFailure(result.retryAfter);
    }
  }

  circuitBreakerStatus(): Record<string, ReturnType<CircuitBreaker["status"]>> {
    const out: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, b] of this.breakers) out[name] = b.status();
    return out;
  }
}

export { drainDispatcherStream };
