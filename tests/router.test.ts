/**
 * Router unit tests.
 *
 * Mocks the CircuitBreaker, QuotaCache, LeaderboardCache, and Dispatcher
 * modules — this test suite focuses on router scoring + dispatch logic,
 * not on those dependencies.
 */

// A clock-free, filesystem-free stand-in for the workspace lock.
//
// NOT a no-op: "serializes concurrent write-capable dispatches for the same
// workingDir" below depends on real mutual exclusion, so this keeps the
// in-process promise-chain semantics and drops only the cross-process file
// layer. That layer is what reads the clock, and several tests here drive
// Date.now through an exact mocked sequence to check the whole-call timeout
// budget — a stray clock read silently consumes entries and breaks them for
// reasons unrelated to what they test. The file layer has its own coverage in
// workspace-lock.test.ts.
vi.mock("../src/workspace-lock.js", () => {
  const held = new Map<string, Promise<void>>();
  return {
    LOCK_STALE_MS: 90_000,
    acquireWorkspaceLock: async (workingDir: string) => {
      const key = String(workingDir);
      const previous = held.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = previous.catch(() => undefined).then(
        () => new Promise<void>((resolve) => { release = resolve; }),
      );
      held.set(key, current);
      await previous.catch(() => undefined);
      return () => {
        release();
        if (held.get(key) === current) held.delete(key);
      };
    },
  };
});

// Persistence only — NOT a re-implementation of CircuitBreaker.
//
// The real CircuitBreaker now runs in these suites (it previously had a
// hand-written mock carrying a forceTrip() method production does not have,
// so the tests could not be pointed at the real threshold logic at all).
// BreakerStore stays stubbed because saving calls Date.now(), and several
// tests below drive Date.now through an exact mocked call sequence to check
// the whole-call timeout budget — real persistence silently consumes entries
// from that sequence. Persistence has its own coverage in
// breaker-store.test.ts and router-restart-survival.test.ts, both against the
// real class.
vi.mock("../src/breaker-store.js", () => ({
  BreakerStore: class {
    // In-memory, but FAITHFUL. update() is the read-modify-write the router
    // relies on to accumulate failures across dispatches; a stub that dropped
    // the previous value would make every failure the first one and quietly
    // disable the threshold these tests exercise.
    private readonly mem = new Map<string, unknown>();
    loadAll() {
      return {};
    }
    save() {}
    update(service: string, mutate: (cur: unknown) => unknown) {
      const next = mutate(this.mem.get(service));
      this.mem.set(service, next);
      return next;
    }
  },
}));


import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// ---- Mock dependency modules with minimal stand-ins ----------------------



vi.mock("../src/quota.js", () => {
  class QuotaCache {
    private scores = new Map<string, number>();
    setScore(service: string, score: number): void {
      this.scores.set(service, score);
    }
    async getQuotaScore(service: string): Promise<number> {
      return this.scores.get(service) ?? 1.0;
    }
    recordResult(): void {
      /* no-op for tests */
    }
  }
  return { QuotaCache };
});

vi.mock("../src/leaderboard.js", () => {
  class LeaderboardCache {
    private models = new Map<string, { qualityScore: number; elo: number | null }>();
    private tierOverrides = new Map<string, number>();
    setModel(model: string, qualityScore: number, elo: number | null = null): void {
      this.models.set(model, { qualityScore, elo });
    }
    setTier(model: string, tier: number): void {
      this.tierOverrides.set(model, tier);
    }
    async getQualityScore(
      model: string | undefined,
    ): Promise<{ qualityScore: number; elo: number | null }> {
      if (!model) return { qualityScore: 1.0, elo: null };
      return this.models.get(model) ?? { qualityScore: 1.0, elo: null };
    }
    async autoTier(
      model: string | undefined,
      _thinking: unknown,
      fallbackTier: number,
    ): Promise<number> {
      if (!model) return fallbackTier;
      return this.tierOverrides.get(model) ?? fallbackTier;
    }
  }
  return { LeaderboardCache };
});

// ---- Imports come AFTER vi.mock calls ------------------------------------

import { workspaceRunId } from "../src/workspaces.js";
import { Router, SCORING } from "../src/router.js";
import { aRunDirName } from "./support/fixtures.js";
import { nonLocalIncludedRoutePenalty } from "../src/route-policy.js";
import { buildRouteBilling } from "../src/billing.js";
import { QuotaCache } from "../src/quota.js";
import { LeaderboardCache } from "../src/leaderboard.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { DispatchResult, RouterConfig, ServiceConfig, TaskType } from "../src/types.js";
import type { Dispatcher } from "../src/dispatchers/base.js";

/**
 * Fresh breaker state per test, inside ONE directory per file.
 *
 * These suites used to vi.mock CircuitBreaker with a hand-written stand-in, so
 * persistence was inert and tests could not interfere. Running the real class
 * exposed genuine pollution: a breaker tripped by one test was rehydrated by
 * the next Router, which then skipped the route and failed unrelated
 * assertions.
 *
 * One mkdtemp per FILE with a counter inside it, not one per test: the
 * first version of this made a fresh temp dir per test and cleaned none of
 * them, which left 368 orphaned directories in a single run — the exact leak
 * setup-env.ts was just fixed for.
 */
let stateRoot: string;
let stateSeq = 0;

beforeAll(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "hr-router-state-"));
});

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  stateSeq += 1;
  const dir = path.join(stateRoot, String(stateSeq));
  mkdirSync(dir, { recursive: true });
  process.env.HARNESS_DISPATCH_STATE_DIR = dir;
});


const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd, windowsHide: true });
}

// ---- Test helpers --------------------------------------------------------

/**
 * Billing fields for a route that is NOT local — spread into makeService.
 *
 * makeService defaults every fixture to local on all four declared signals
 * (provider, surface, authSource, billingKind), which is fine for tests that
 * do not care and a trap for every test that does. It has now silently
 * inverted four local-routing tests during development: routes named "cloud",
 * "frontier" and "free_cli" were local by every field they declared, so the
 * assertions passed for reasons unrelated to what they claimed to check.
 *
 * Spelling it out at each site was the first fix and it did not take — the
 * fifth site got written from memory without it. A name is harder to forget
 * than four lines, and reads as intent rather than boilerplate.
 */
const NON_LOCAL = {
  provider: "anthropic",
  surface: "claude_code",
  authSource: "oauth_session",
  billingKind: "included_plan_usage",
} as const satisfies Partial<ServiceConfig>;

function makeService(overrides: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    command: overrides.name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: ["plan", "review"],
    provider: "local",
    surface: "local_endpoint",
    authSource: "local_network",
    billingKind: "local_compute",
    paidUsagePossible: false,
    billingConfidence: "documented",
    ...overrides,
  } as ServiceConfig;
}

function makeConfig(services: ServiceConfig[]): RouterConfig {
  const map: Record<string, ServiceConfig> = {};
  for (const svc of services) map[svc.name] = svc;
  return { services: map };
}

class StubDispatcher implements Dispatcher {
  readonly id: string;
  calls: Array<{ prompt: string; model?: string; timeoutMs?: number }> = [];
  private nextResult: DispatchResult;
  private available = true;

  constructor(id: string, result?: Partial<DispatchResult>) {
    this.id = id;
    this.nextResult = {
      output: `ok from ${id}`,
      service: id,
      success: true,
      ...(result ?? {}),
    } as DispatchResult;
  }

  setResult(result: Partial<DispatchResult>): void {
    this.nextResult = { ...this.nextResult, ...result } as DispatchResult;
  }

  setAvailable(v: boolean): void {
    this.available = v;
  }

  async dispatch(
    prompt: string,
    _files: string[],
    _workingDir: string,
    opts?: { modelOverride?: string; timeoutMs?: number },
  ): Promise<DispatchResult> {
    const call: { prompt: string; model?: string; timeoutMs?: number } = { prompt };
    if (opts?.modelOverride !== undefined) call.model = opts.modelOverride;
    if (opts?.timeoutMs !== undefined) call.timeoutMs = opts.timeoutMs;
    this.calls.push(call);
    return this.nextResult;
  }

  async checkQuota(): Promise<never> {
    throw new Error("not implemented for tests");
  }

  isAvailable(): boolean {
    return this.available;
  }
}

/** Like StubDispatcher, but implements stream() for router.stream()/#runStream tests. */
class StreamStubDispatcher implements Dispatcher {
  readonly id: string;
  lastOpts: { modelOverride?: string; timeoutMs?: number } | undefined;
  private nextResult: DispatchResult;

  constructor(id: string, result?: Partial<DispatchResult>) {
    this.id = id;
    this.nextResult = {
      output: `ok from ${id}`,
      service: id,
      success: true,
      ...(result ?? {}),
    } as DispatchResult;
  }

  async dispatch(): Promise<DispatchResult> {
    throw new Error("not used in stream tests");
  }

  async *stream(
    _prompt: string,
    _files: string[],
    _workingDir: string,
    opts?: { modelOverride?: string; timeoutMs?: number },
  ): AsyncIterable<import("../src/types.js").DispatcherEvent> {
    this.lastOpts = opts;
    yield { type: "completion", result: this.nextResult };
  }

  async checkQuota(): Promise<never> {
    throw new Error("not implemented for tests");
  }

  isAvailable(): boolean {
    return true;
  }
}

// ---- Tests ---------------------------------------------------------------

describe("Router.pickService", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("prefers the service with higher ELO within the same tier", async () => {
    const a = makeService({
      name: "alpha",
      leaderboardModel: "model-a",
      tier: 1,
    });
    const b = makeService({
      name: "beta",
      leaderboardModel: "model-b",
      tier: 1,
    });
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-a",
      0.9,
      1400,
    );
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-b",
      0.8,
      1300,
    );
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "execute" } });
    expect(decision).not.toBeNull();
    expect(decision!.service).toBe("alpha");
    expect(decision!.tier).toBe(1);
  });

  it("honors a forced service via hints.service", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 2 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { service: "beta" } });
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toBe("forced");
  });

  it("does not forward a ROUTE ID to the harness as a model override", async () => {
    // `hints.model` accepts a route id — the schema says so, and it is the
    // documented way to nudge routing. But the value was ALSO handed to
    // whichever route won as `--model`, so hinting a route id that lost the
    // routing decision sent a nonsense model to a real provider. Measured:
    // one such dispatch was tried against four subscription CLIs, each
    // rejecting `--model <route id>`, spending five calls and tripping two
    // breakers.
    const local = makeService({ name: "fast_local", tier: 3, model: "local-model" });
    const other = makeService({ name: "alpha", tier: 1, model: "alpha-model" });
    const dispatchers: Record<string, Dispatcher> = {
      fast_local: new StubDispatcher("fast_local"),
      alpha: new StubDispatcher("alpha"),
    };
    const router = new Router(makeConfig([local, other]), quota, dispatchers, leaderboard);

    // The hinted route LOSES — excluded here, as it would be by a tripped
    // breaker or a policy block in the field. Whoever wins must not be handed
    // the loser's id as a model.
    //
    // Deliberately NOT via hints.service: on the forced path the caller has
    // already chosen the route, so `model` can only mean a model, and
    // suppressing it there dropped a caller's explicit request. That is its
    // own test below.
    const decision = await router.pickService({
      hints: { model: "fast_local" },
      exclude: new Set(["fast_local"]),
    });

    expect(decision?.service).toBe("alpha");
    expect(
      decision?.model,
      "a route id was forwarded to the harness as a model name",
    ).not.toBe("fast_local");
    expect(decision?.model).toBe("alpha-model");
  });

  it("drops a model that names the FORCED route itself", async () => {
    // Over-specifying: "use codex_cli, with codex_cli". 0.7.6 dropped it
    // (right), 0.7.7 forwarded it (wrong) and Codex rejected `--model
    // codex_cli` with a real failed job and a breaker event. Only the
    // self-naming case is ambiguous; the collides-with-another-route case
    // below must still be honoured, which is why one rule cannot cover both.
    const worker = makeService({ name: "worker_route", tier: 1, model: "route-default-model" });
    const dispatchers: Record<string, Dispatcher> = {
      worker_route: new StubDispatcher("worker_route"),
    };
    const router = new Router(makeConfig([worker]), quota, dispatchers, leaderboard);

    for (const spelling of ["worker_route", "WORKER_ROUTE"]) {
      const decision = await router.pickService({
        hints: { service: "worker_route", model: spelling },
      });
      expect(
        decision?.model,
        `"${spelling}" was forwarded to the harness as a model name`,
      ).toBe("route-default-model");
    }
  });

  it("refuses a routeTo whose routePolicy blocks the route, without pre-filtering", async () => {
    // routeTo enforces routePolicy itself, and that is NOT redundant with the
    // HTTP fanout filter even though the filter runs first on the shipped
    // path: routeTo is a public Router method, so a caller reaching it
    // directly gets the refusal or gets nothing.
    //
    // Pinned because it was unverified. Removing routePolicy from
    // explicitOptsFromHints left the whole suite green — the filter caught
    // every case — so the second enforcement point existed on trust. A guard
    // no test can distinguish from its own absence is one someone deletes.
    const a = makeService({ name: "alpha", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);

    const { result } = await router.routeTo("alpha", "hi", [], process.cwd(), {
      routePolicy: "blocked",
    });

    expect(result.success).toBe(false);
    expect(result.skippedRoutes?.[0]?.code).toBe("route_policy");
    expect(result.output, "a blocked route still produced output").toBe("");
  });

  it("refuses a streamTo whose routePolicy blocks the route", async () => {
    // The same check one method over, and the one that matters more: jobs.ts
    // dispatches through streamTo, so this is the path every MCP `dispatch`
    // takes. Found while pinning routeTo — sabotaging streamTo's copy left the
    // whole suite green, so the enforcement MCP relies on was resting on the
    // HTTP filter having caught it first, which for MCP is not true at all.
    const a = makeService({ name: "alpha", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);

    let final: DispatchResult | null = null;
    for await (const event of router.streamTo("alpha", "hi", [], process.cwd(), {
      routePolicy: "blocked",
    })) {
      if (event.event.type === "completion") final = event.event.result;
    }

    expect(final?.success).toBe(false);
    expect(final?.skippedRoutes?.[0]?.code).toBe("route_policy");
    expect(final?.output, "a blocked route still produced output").toBe("");
  });

  it("says so when it drops a model, on both the forced and the scored path", async () => {
    // Dropping a route id used as a model is right — but the tool schema said
    // the model is "ALWAYS passed to the harness" and server.ts said
    // "forwarded as-is", so a caller reading the response had no way to learn
    // otherwise. The whole point of the drop is that the route runs a
    // DIFFERENT model than the one asked for; that is a fact about the result,
    // not an implementation detail.
    const worker = makeService({ name: "worker_route", tier: 1, model: "route-default-model" });
    const collides = makeService({ name: "gpt-5.6-sol", tier: 3 });
    const dispatchers: Record<string, Dispatcher> = {
      worker_route: new StubDispatcher("worker_route"),
      "gpt-5.6-sol": new StubDispatcher("gpt-5.6-sol"),
    };
    const router = new Router(makeConfig([worker, collides]), quota, dispatchers, leaderboard);

    // Forced path: the model names the forced route itself, so it is dropped.
    const forced = await router.pickService({
      hints: { service: "worker_route", model: "worker_route" },
    });
    expect(forced?.model).toBe("route-default-model");
    expect(forced?.modelHintDropped, "the forced path dropped a model silently").toBe(true);

    // Scored path: the model is a route id used as a routing nudge.
    const scored = await router.pickService({
      hints: { taskType: "execute", model: "worker_route" },
    });
    expect(scored?.service).toBe("worker_route");
    expect(scored?.model).toBe("route-default-model");
    expect(scored?.modelHintDropped, "the scored path dropped a model silently").toBe(true);

    // And the negative, so this cannot be satisfied by always reporting true:
    // a model that reaches the harness must not be reported as dropped.
    const forwarded = await router.pickService({
      hints: { service: "worker_route", model: "gpt-5.6-sol" },
    });
    expect(forwarded?.model).toBe("gpt-5.6-sol");
    expect(forwarded?.modelHintDropped, "a forwarded model was reported as dropped").toBeFalsy();

    const unrecognized = await router.pickService({
      hints: { taskType: "execute", model: "some-unrecognized-model" },
    });
    expect(unrecognized?.model).toBe("some-unrecognized-model");
    expect(unrecognized?.modelHintDropped).toBeFalsy();
  });

  it("reports modelHintMatched from DECLARED models, not the route's name", async () => {
    // The schema says true means "the picked route actually declares this
    // model", and it is the signal an agent is told to use to decide how much
    // to trust a result. A route-name match reported true, so the one
    // self-correction signal said the opposite of the truth.
    const worker = makeService({
      name: "worker_route",
      tier: 1,
      model: "route-default-model",
    });
    const router = new Router(
      makeConfig([worker]),
      quota,
      { worker_route: new StubDispatcher("worker_route") },
      leaderboard,
    );

    const byName = await router.pickService({
      hints: { service: "worker_route", model: "worker_route" },
    });
    expect(byName?.modelHintMatched, "a route-name match was reported as a declared model").toBe(
      false,
    );

    const byModel = await router.pickService({
      hints: { service: "worker_route", model: "route-default-model" },
    });
    expect(byModel?.modelHintMatched).toBe(true);
  });

  it("still honours a model on a FORCED route, even if some other route is named that", async () => {
    // The over-fire the first version of the route-id fix caused. With the
    // service already chosen by the caller, `model` cannot be a routing nudge
    // — it can only be a model — so a model name that happens to collide with
    // another route's id must still reach the harness. It was being swapped
    // for the route default, silently, on an explicit request.
    const worker = makeService({ name: "worker_route", tier: 1, model: "route-default-model" });
    const collides = makeService({ name: "gpt-5.6-sol", tier: 3 });
    const dispatchers: Record<string, Dispatcher> = {
      worker_route: new StubDispatcher("worker_route"),
      "gpt-5.6-sol": new StubDispatcher("gpt-5.6-sol"),
    };
    const router = new Router(makeConfig([worker, collides]), quota, dispatchers, leaderboard);

    const decision = await router.pickService({
      hints: { service: "worker_route", model: "gpt-5.6-sol" },
    });

    expect(decision?.service).toBe("worker_route");
    expect(
      decision?.model,
      "an explicitly requested model was silently replaced by the route default",
    ).toBe("gpt-5.6-sol");
  });

  it("still lets a route id steer routing", async () => {
    // The other half: removing the forward must not remove the boost, which is
    // the documented reason to pass a route id at all.
    const local = makeService({ name: "fast_local", tier: 1 });
    const other = makeService({ name: "alpha", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = {
      fast_local: new StubDispatcher("fast_local"),
      alpha: new StubDispatcher("alpha"),
    };
    const router = new Router(makeConfig([local, other]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { model: "fast_local" } });
    expect(decision?.service).toBe("fast_local");
  });

  it("passes a requested model through to a forced service even if it matches nothing configured", async () => {
    const a = makeService({ name: "alpha", tier: 1, model: "alpha-default-model" });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { service: "alpha", model: "some-unrecognized-model" },
    });
    expect(decision?.service).toBe("alpha");
    // Previously silently discarded in favor of svc.model when it didn't
    // match any statically configured field — the dispatcher never saw it
    // and the caller got no signal their request was ignored.
    expect(decision?.model).toBe("some-unrecognized-model");
    // Since the router forwarded it "blind," the caller needs a way to tell
    // that apart from "I got exactly what I asked for."
    expect(decision?.modelHintMatched).toBe(false);
  });

  it("passes a requested model through to the best-scored candidate even if it matches nothing configured", async () => {
    const a = makeService({ name: "alpha", tier: 1, model: "alpha-default-model" });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { taskType: "execute", model: "some-unrecognized-model" },
    });
    expect(decision?.service).toBe("alpha");
    expect(decision?.model).toBe("some-unrecognized-model");
    expect(decision?.modelHintMatched).toBe(false);
  });

  it("marks modelHintMatched true when the requested model matches the picked route", async () => {
    const a = makeService({ name: "alpha", tier: 1, model: "alpha-default-model" });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { taskType: "execute", model: "alpha-default-model" },
    });
    expect(decision?.modelHintMatched).toBe(true);
  });

  it("omits modelHintMatched entirely when no model hint was given", async () => {
    const a = makeService({ name: "alpha", tier: 1, model: "alpha-default-model" });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "execute" } });
    expect(decision?.modelHintMatched).toBeUndefined();
  });

  it("does not let forced service bypass local-only policy", async () => {
    const cloud = makeService({
      name: "cloud",
      provider: "openai",
      surface: "openai_api",
      authSource: "api_key",
      billingKind: "included_plan_usage",
      paidUsagePossible: false,
      tier: 1,
    });
    const local = makeService({ name: "local", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = {
      cloud: new StubDispatcher("cloud"),
      local: new StubDispatcher("local"),
    };
    const router = new Router(makeConfig([cloud, local]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { service: "cloud", routePolicy: "local_only" },
    });
    expect(decision).toBeNull();
    expect(router.skippedRoutes()).toEqual([
      expect.objectContaining({ route: "cloud", code: "route_policy" }),
    ]);
  });

  it("penalizes included cloud routes in standard mode so local wins close calls", async () => {
    const cloud = makeService({
      name: "cloud",
      provider: "openai",
      surface: "codex_cli",
      authSource: "product_login",
      billingKind: "included_plan_usage",
      paidUsagePossible: false,
      tier: 1,
      leaderboardModel: "model-a",
    });
    const local = makeService({
      name: "local",
      tier: 1,
      leaderboardModel: "model-a",
    });
    const dispatchers: Record<string, Dispatcher> = {
      cloud: new StubDispatcher("cloud"),
      local: new StubDispatcher("local"),
    };
    const router = new Router(makeConfig([cloud, local]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { taskType: "plan", routePolicy: "standard" },
    });
    expect(decision?.service).toBe("local");
  });

  it("skips services whose circuit breaker is tripped", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const alphaBreaker = router.getBreaker("alpha");
    alphaBreaker!.trip();
    const decision = await router.pickService();
    expect(decision?.service).toBe("beta");
  });

  it("filters candidates by harness hint", async () => {
    const a = makeService({
      name: "alpha",
      harness: "claude_code",
      tier: 1,
    });
    const b = makeService({
      name: "beta",
      harness: "cursor",
      tier: 1,
    });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({
      hints: { harness: "cursor", safetyProfile: "full_auto" },
    });
    expect(decision?.service).toBe("beta");
  });

  it("falls through to tier-2 when all tier-1 services are broken", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 2 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    router.getBreaker("alpha")!.trip();
    const decision = await router.pickService();
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toMatch(/fallback/);
    expect(decision?.tier).toBe(2);
  });

  it("applies the prefer_large_context boost by declared max_input_tokens, not harness name", async () => {
    const nonAntigravity = makeService({
      name: "alpha",
      harness: "claude_code",
      tier: 2, // force into tier 2 so comparison is apples-to-apples
    });
    const antigravity = makeService({
      name: "antigravity_cli",
      harness: "antigravity_cli",
      tier: 2,
      maxInputTokens: 2_000_000, // >=2M declared context -> full +0.3 boost
    });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      antigravity_cli: new StubDispatcher("antigravity_cli"),
    };
    const router = new Router(
      makeConfig([nonAntigravity, antigravity]),
      quota,
      dispatchers,
      leaderboard,
    );
    const withoutBoost = await router.pickService({ hints: { preferLargeContext: false } });
    const withBoost = await router.pickService({ hints: { preferLargeContext: true } });
    // Without the boost they tie and alpha wins (iteration order). With the boost antigravity wins.
    expect(withoutBoost?.service).toBe("alpha");
    expect(withBoost?.service).toBe("antigravity_cli");
    // And the score delta equals 0.3 exactly for the antigravity service.
    expect(withBoost!.finalScore - withoutBoost!.finalScore).toBeCloseTo(0.3, 10);
  });

  it("pins the scoring constants that src/router.ts's header restates in prose", () => {
    // Not a test of behaviour — the tests around it cover that. This exists
    // because the header enumerates these numbers several hundred lines from
    // where they are used, and one of those restatements went stale: it
    // described a taskType=local bonus for a release after the bonus was
    // deleted. check-claims.mjs could not catch it, and cannot catch this
    // class at all — it verifies that things prose NAMES exist, never that
    // what prose SAYS is true.
    //
    // So: change a number here and this fails, with a message naming the other
    // half to update. Cheaper and less brittle than parsing the comment, and
    // it puts the reminder where the change happens.
    const header = "src/router.ts's header comment lists these — update it too";
    expect(SCORING.modelMatchBonus, header).toBe(0.5);
    expect(SCORING.largeContextBonus, header).toBe(0.3);
    expect(SCORING.mediumContextBonus, header).toBe(0.15);
    expect(SCORING.largeContextThreshold, header).toBe(2_000_000);
    expect(SCORING.mediumContextThreshold, header).toBe(1_000_000);
    expect(SCORING.defaultMaxFallbacks, header).toBe(2);
    // The penalty lives in route-policy.ts but the header quotes it here, so
    // it drifts the same way. Built through the real billing path rather than
    // hand-assembled, so a change to how billing is derived shows up too.
    const penaltyFor = (over: Partial<ServiceConfig>) =>
      nonLocalIncludedRoutePenalty(buildRouteBilling(makeService({ name: "p", ...over })));
    expect(penaltyFor({}), header).toBe(0);
    expect(
      penaltyFor({
        provider: "anthropic",
        surface: "vendor_cli",
        authSource: "oauth_session",
        billingKind: "included_plan_usage",
      }),
      header,
    ).toBe(0.2);
    expect(
      penaltyFor({
        provider: "openai",
        surface: "openai_api",
        authSource: "api_key",
        billingKind: "metered_api",
      }),
      header,
    ).toBe(0.4);
  });

  it("prefers a local route for taskType=local over a cloud one in the same tier", async () => {
    const cloud = makeService({
      name: "cloud",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      provider: "anthropic",
      surface: "vendor_cli",
      authSource: "oauth_session",
      billingKind: "included_plan_usage",
    });
    const local = makeService({
      name: "ollama",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    const dispatchers: Record<string, Dispatcher> = {
      cloud: new StubDispatcher("cloud"),
      ollama: new StubDispatcher("ollama"),
    };
    const router = new Router(makeConfig([cloud, local]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "local" } });
    expect(decision?.service).toBe("ollama");
  });

  it("reaches a local route for taskType=local ACROSS tiers, not just within one", async () => {
    // The schema says 'local' "prefers free local endpoints". It could not:
    // the preference was a +0.3 score bonus, a bonus only reorders within a
    // tier, and local endpoints live in the cheap tier — so any healthy tier-1
    // route won before the bonus was consulted. Measured on a real config,
    // every taskType including 'local' resolved to the same tier-1 CLI and the
    // configured local box had 0 calls in a month.
    const frontier = makeService({
      name: "frontier",
      tier: 1,
      provider: "anthropic",
      surface: "vendor_cli",
      authSource: "oauth_session",
      billingKind: "included_plan_usage",
    });
    const localBox = makeService({
      name: "local_box",
      tier: 3,
      type: "openai_compatible",
      // NOT loopback, deliberately. The old test keyed on a localhost URL,
      // which is why a real box on a LAN or tailnet address was never local
      // enough — while routePolicy: 'local_only' considered it local all
      // along, off the same declared fields.
      baseUrl: "http://node-a17.tailnet.ts.net:1234/v1",
      provider: "local",
      surface: "local_endpoint",
      authSource: "local_network",
      billingKind: "local_compute",
    });
    const dispatchers: Record<string, Dispatcher> = {
      frontier: new StubDispatcher("frontier"),
      local_box: new StubDispatcher("local_box"),
    };
    const router = new Router(makeConfig([frontier, localBox]), quota, dispatchers, leaderboard);

    const local = await router.pickService({ hints: { taskType: "local" } });
    expect(local?.service, "a tier-1 route beat the local box for trivial work").toBe("local_box");
    expect(local?.reason).toMatch(/local route preferred/);

    // And ONLY this task type crosses tiers. Tier gating is what stops plan
    // and review drifting onto a weak route to save a fraction of a point.
    for (const taskType of ["execute", "plan", "review"] as const) {
      const other = await router.pickService({ hints: { taskType } });
      expect(other?.service, `taskType ${taskType} escaped its tier`).toBe("frontier");
    }
  });

  it("does not treat a METERED proxy on loopback as local", async () => {
    // The hazard that made the loopback half of the predicate worth deleting.
    // A LiteLLM / OpenRouter-style proxy fronting a paid API from 127.0.0.1
    // declares provider openai, surface openai_api, billing metered_api —
    // isLocalRoute correctly says no. An `|| isLoopbackUrl(...)` overrode that,
    // so taskType 'local', whose entire meaning is "free local endpoint",
    // became the ONE task type that preferred the PAID route, across tiers,
    // over a free subscription CLI. A user would see metered spend on exactly
    // the dispatches they marked trivial.
    //
    // NON_LOCAL on the free route is load-bearing: with makeService's defaults
    // it is local too, both routes qualify, and it wins on score regardless —
    // so the test passes whether or not the bug is present. Confirmed by
    // reintroducing the clause against a defaulted fixture: nothing failed.
    const freeCli = makeService({ name: "free_cli", tier: 1, ...NON_LOCAL });
    const paidProxy = makeService({
      name: "paid_proxy",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "http://localhost:8080/v1",
      provider: "openai",
      surface: "openai_api",
      authSource: "api_key",
      billingKind: "metered_api",
      paidUsagePossible: true,
      allowPaidUsage: true,
    });
    const dispatchers: Record<string, Dispatcher> = {
      free_cli: new StubDispatcher("free_cli"),
      paid_proxy: new StubDispatcher("paid_proxy"),
    };
    const router = new Router(makeConfig([freeCli, paidProxy]), quota, dispatchers, leaderboard);

    const decision = await router.pickService({ hints: { taskType: "local" } });
    expect(decision?.service, "a metered loopback proxy was preferred as 'local'").toBe("free_cli");
    // And the proxy really was eligible — otherwise this passes because the
    // route never entered candidacy, which proves nothing about the predicate.
    //
    // `plan`, not `execute`: an openai_compatible route is now refused for
    // execute outright (it has no agent loop or file access), so an execute
    // probe would report it skipped for a reason that has nothing to do with
    // the locality predicate under test — and the control would start passing
    // for the wrong reason, which is exactly what it exists to prevent. An
    // endpoint is legitimately eligible for plan.
    const anyTask = await router.pickService({ hints: { taskType: "plan" } });
    expect(anyTask?.skippedRoutes?.some((s) => s.route === "paid_proxy") ?? false).toBe(false);
  });

  it("falls back to normal tier order when no local route is eligible", async () => {
    // A machine with no local endpoint must behave exactly as before.
    const frontier = makeService({
      name: "frontier",
      tier: 1,
      provider: "anthropic",
      surface: "vendor_cli",
      authSource: "oauth_session",
      billingKind: "included_plan_usage",
    });
    const cloud = makeService({
      name: "cloud",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      // Spelled out because makeService defaults EVERY fixture to local on all
      // four signals — provider, surface, auth source, billing kind. A test
      // meaning "no local route is eligible" that leaves those at their
      // defaults is testing the opposite of what it says.
      provider: "anthropic",
      surface: "vendor_cli",
      authSource: "oauth_session",
      billingKind: "included_plan_usage",
    });
    const dispatchers: Record<string, Dispatcher> = {
      frontier: new StubDispatcher("frontier"),
      cloud: new StubDispatcher("cloud"),
    };
    const router = new Router(makeConfig([frontier, cloud]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "local" } });
    expect(decision?.service).toBe("frontier");
    expect(decision?.reason).toMatch(/tier 1 best/);
  });

  it("resolves the escalation model when task_type is in escalateOn", async () => {
    const a = makeService({
      name: "alpha",
      model: "default-model",
      escalateModel: "big-model",
      escalateOn: ["plan", "review"],
    });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const executeDec = await router.pickService({ hints: { taskType: "execute" } });
    const planDec = await router.pickService({ hints: { taskType: "plan" } });
    expect(executeDec?.model).toBe("default-model");
    expect(planDec?.model).toBe("big-model");
  });
});

describe("Router.route", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("returns the successful result on first attempt", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new StubDispatcher("alpha");
    const router = new Router(
      makeConfig([a]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );
    const { result, decision } = await router.route("hi", [], "/tmp");
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok from alpha");
    expect(decision?.service).toBe("alpha");
    expect(decision?.reason).not.toMatch(/fallback/);
  });

  it("serializes concurrent write-capable dispatches for the same workingDir", async () => {
    const svc = makeService({ name: "alpha", tier: 1 });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class BlockingDispatcher extends StubDispatcher {
      override async dispatch(
        prompt: string,
        files: string[],
        workingDir: string,
        opts?: { modelOverride?: string },
      ): Promise<DispatchResult> {
        events.push(`start:${prompt}`);
        if (prompt === "first") await firstGate;
        const result = await super.dispatch(prompt, files, workingDir, opts);
        events.push(`end:${prompt}`);
        return result;
      }
    }
    const dispatcher = new BlockingDispatcher("alpha");
    const router = new Router(
      makeConfig([svc]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );

    const p1 = router.route("first", [], "/repo", {
      hints: { safetyProfile: "workspace_edit" },
    });
    await vi.waitFor(() => expect(events).toEqual(["start:first"]));
    const p2 = router.route("second", [], "/repo", {
      hints: { safetyProfile: "workspace_edit" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["start:first"]);
    releaseFirst();
    await p1;
    await p2;
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("allows concurrent read-only dispatches for the same workingDir", async () => {
    const svc = makeService({ name: "alpha", tier: 1, safetyProfile: "read_only" });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class BlockingDispatcher extends StubDispatcher {
      override async dispatch(
        prompt: string,
        files: string[],
        workingDir: string,
        opts?: { modelOverride?: string },
      ): Promise<DispatchResult> {
        events.push(`start:${prompt}`);
        if (prompt === "first") await firstGate;
        const result = await super.dispatch(prompt, files, workingDir, opts);
        events.push(`end:${prompt}`);
        return result;
      }
    }
    const dispatcher = new BlockingDispatcher("alpha");
    const router = new Router(
      makeConfig([svc]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );

    const p1 = router.route("first", [], "/repo", {
      hints: { safetyProfile: "read_only" },
    });
    await vi.waitFor(() => expect(events).toEqual(["start:first"]));
    const p2 = router.route("second", [], "/repo", {
      hints: { safetyProfile: "read_only" },
    });
    await vi.waitFor(() => expect(events).toContain("start:second"));

    releaseFirst();
    await p1;
    await p2;
    expect(events.indexOf("start:second")).toBeLessThan(events.indexOf("end:first"));
  });

  it("runs copy-isolated workspace_edit dispatches away from the source workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-copy-"));
    await fs.writeFile(path.join(root, "calc.mjs"), "export const value = 1;\n", "utf8");
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "ignored.txt"), "heavy\n", "utf8");

    class EditingDispatcher extends StubDispatcher {
      seenWorkingDir = "";
      override async dispatch(
        prompt: string,
        files: string[],
        workingDir: string,
        opts?: { modelOverride?: string },
      ): Promise<DispatchResult> {
        this.seenWorkingDir = workingDir;
        await fs.writeFile(path.join(workingDir, "calc.mjs"), "export const value = 2;\n", "utf8");
        await fs.writeFile(path.join(workingDir, "notes.md"), `prompt=${prompt}\n`, "utf8");
        return super.dispatch(prompt, files, workingDir, opts);
      }
    }

    const svc = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new EditingDispatcher("alpha");
    const router = new Router(
      makeConfig([svc]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );

    const { result } = await router.route("edit calc", [], root, {
      hints: { safetyProfile: "workspace_edit", workspacePolicy: "copy" },
    });

    expect(result.success).toBe(true);
    expect(dispatcher.seenWorkingDir).not.toBe(root);
    expect(await fs.readFile(path.join(root, "calc.mjs"), "utf8")).toBe("export const value = 1;\n");
    expect(result.workspace).toEqual(
      expect.objectContaining({
        policy: "copy",
        isolated: true,
        originalWorkingDir: path.resolve(root),
        effectiveWorkingDir: dispatcher.seenWorkingDir,
      }),
    );
    expect(result.workspace?.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "calc.mjs", kind: "modified" }),
        expect.objectContaining({ path: "notes.md", kind: "added" }),
      ]),
    );
    await expect(fs.stat(path.join(dispatcher.seenWorkingDir, "node_modules", "ignored.txt"))).rejects.toThrow();
  });

  it("runs git_worktree-isolated workspace_edit dispatches in a detached worktree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-worktree-"));
    await git(root, ["init"]);
    await fs.writeFile(path.join(root, "calc.mjs"), "export const value = 1;\n", "utf8");
    await git(root, ["add", "calc.mjs"]);
    await git(root, [
      "-c",
      "user.name=Harness Router Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);

    class EditingDispatcher extends StubDispatcher {
      seenWorkingDir = "";
      override async dispatch(
        prompt: string,
        files: string[],
        workingDir: string,
        opts?: { modelOverride?: string },
      ): Promise<DispatchResult> {
        this.seenWorkingDir = workingDir;
        await fs.writeFile(path.join(workingDir, "calc.mjs"), "export const value = 3;\n", "utf8");
        return super.dispatch(prompt, files, workingDir, opts);
      }
    }

    const svc = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new EditingDispatcher("alpha");
    const router = new Router(
      makeConfig([svc]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );

    const { result } = await router.route("edit calc", [], root, {
      hints: { safetyProfile: "workspace_edit", workspacePolicy: "git_worktree" },
    });

    expect(result.success).toBe(true);
    expect(dispatcher.seenWorkingDir).not.toBe(root);
    expect(await fs.readFile(path.join(root, "calc.mjs"), "utf8")).toBe("export const value = 1;\n");
    expect(result.workspace).toEqual(
      expect.objectContaining({
        policy: "git_worktree",
        isolated: true,
        originalWorkingDir: path.resolve(root),
        effectiveWorkingDir: dispatcher.seenWorkingDir,
      }),
    );
    expect(result.workspace?.changedFiles).toEqual([
      expect.objectContaining({ path: "calc.mjs", kind: "modified" }),
    ]);

    const worktreeRoot = result.workspace?.workspaceRoot
      ? path.join(result.workspace.workspaceRoot, "worktree")
      : undefined;
    if (worktreeRoot) {
      await git(root, ["worktree", "remove", "--force", worktreeRoot]);
    }
  });

  it("prunes copy workspaces older than the retention window before creating a new one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-copy-prune-"));
    await fs.writeFile(path.join(root, "calc.mjs"), "export const value = 1;\n", "utf8");

    // Workspaces live OUTSIDE the project now, so the stale one to prune goes
    // where the product actually puts them. Pinned via the env override rather
    // than reaching into os.tmpdir(), so the test cannot delete a real
    // workspace belonging to something else on this machine.
    const wsHome = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-ws-home-"));
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const svc = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new StubDispatcher("alpha");
    const router = new Router(makeConfig([svc]), quota, { alpha: dispatcher }, leaderboard);

    const originalEnv = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
    const originalDir = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = String(24 * 60 * 60 * 1000);
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = wsHome;
    try {
      // Two dispatches, because the stale run has to go where the product
      // actually puts one: INSIDE this project's own root, whose name is a
      // digest of the project path. The old fixture was an empty directory
      // sitting in the base — the right shape back when the base and the
      // prune root were the same thing, and since per-project roots arrived,
      // a directory at a level nothing generates. It passed for the wrong
      // reason and stopped the moment reclamation began checking that a
      // directory looks like one of ours.
      const first = await router.route("noop", [], root, {
        hints: { safetyProfile: "workspace_edit", workspacePolicy: "copy" },
      });
      expect(first.result.success).toBe(true);
      const projectRoot = path.dirname(first.result.workspace!.workspaceRoot!);

      // Built by the product's own generator, not spelled out: a run
      // directory with a hand-written suffix is not one reclamation
      // recognises, and a test using one measures something else.
      const staleRun = path.join(projectRoot, aRunDirName("alpha"));
      await fs.mkdir(path.join(staleRun, "workspace"), { recursive: true });
      await fs.utimes(staleRun, staleTime, staleTime);

      const { result } = await router.route("noop", [], root, {
        hints: { safetyProfile: "workspace_edit", workspacePolicy: "copy" },
      });
      expect(result.success).toBe(true);
      // The fresh workspace this same call created must survive pruning —
      // only the pre-existing stale one should be gone.
      expect(result.workspace?.workspaceRoot).toBeDefined();
      await expect(fs.stat(result.workspace!.workspaceRoot!)).resolves.toBeDefined();
      await expect(
        fs.stat(staleRun),
        "a run past the retention window survived inside its own project root",
      ).rejects.toThrow();

      // The guarantee the move exists for: a copy dispatch leaves NOTHING in
      // the user's project. Nesting the workspace here is what let sibling
      // workspaces leak into the patch as deletions, destroying another job's
      // work and offering to delete the user's files.
      await expect(fs.stat(path.join(root, ".harness-dispatch"))).rejects.toThrow();
    } finally {
      if (originalEnv === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
      else process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = originalEnv;
      if (originalDir === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = originalDir;
      await fs.rm(wsHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("reclaims the project root of a project that never dispatches again", async () => {
    // The retention sweep only ever looks INSIDE one project's root, and only
    // runs when a dispatch happens for that same project. So a project
    // dispatched once and then renamed, deleted, or created as a throwaway
    // temp directory keeps its stale runs forever — the code that would
    // reclaim them is reachable only by a project that no longer exists.
    //
    // Measured before this was fixed: 840 project roots on one machine, 839
    // still holding runs five days past a 24-hour window. tests/setup-env.ts
    // records what that costs when it is not caught — 2,605 orphaned
    // directories and 0 bytes free on a 931 GB volume.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hd-proj-"));
    const wsHome = await fs.mkdtemp(path.join(os.tmpdir(), "hd-ws-home-"));
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // A project root belonging to some OTHER, now-vanished project.
    const abandoned = path.join(wsHome, "gone-project-deadbeef");
    const abandonedRun = aRunDirName("alpha");
    await fs.mkdir(path.join(abandoned, abandonedRun, "workspace"), {
      recursive: true,
    });
    await fs.utimes(path.join(abandoned, abandonedRun), stale, stale);

    // A directory this tool never created, everything in it long past the
    // window. HARNESS_DISPATCH_WORKSPACES_DIR is a setting the README
    // recommends pointing at a directory of your choosing, so the base is not
    // necessarily ours alone — and this sweep deletes recursively. An
    // acceptance pass reproduced exactly this against the built artifact:
    // unrelated directories with real content destroyed by one dispatch.
    // Age is not evidence of ownership.
    const notOurs = path.join(wsHome, "my-important-notes");
    await fs.mkdir(path.join(notOurs, "subdir"), { recursive: true });
    await fs.writeFile(path.join(notOurs, "subdir", "notes.txt"), "irreplaceable", "utf8");
    await fs.utimes(path.join(notOurs, "subdir"), stale, stale);

    // A foreign directory whose NAME collides with the shape this used to
    // check. The first guard was `-[0-9a-f]{8}$`, and eight decimal digits are
    // valid hex, so every `<name>-<YYYYMMDD>` matched: a second acceptance pass
    // planted exactly this beside the directory above and watched one dispatch
    // delete it recursively while the other survived. Ownership is now a marker
    // this tool writes, not a name that looks about right.
    const datedBackup = path.join(wsHome, "backup-20260401");
    await fs.mkdir(datedBackup, { recursive: true });
    await fs.writeFile(path.join(datedBackup, "data.bin"), "precious", "utf8");
    await fs.utimes(path.join(datedBackup, "data.bin"), stale, stale);

    // And one whose run is still inside the window: it must survive, or a
    // live dispatch elsewhere on the machine loses its workspace.
    const active = path.join(wsHome, "busy-project-cafebabe");
    await fs.mkdir(path.join(active, aRunDirName("alpha"), "workspace"), {
      recursive: true,
    });

    const svc = makeService({ name: "alpha", tier: 1 });
    const router = new Router(
      makeConfig([svc]),
      quota,
      { alpha: new StubDispatcher("alpha") },
      leaderboard,
    );
    const originalEnv = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
    const originalDir = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = String(24 * 60 * 60 * 1000);
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = wsHome;
    try {
      const { result } = await router.route("noop", [], root, {
        hints: { safetyProfile: "workspace_edit", workspacePolicy: "copy" },
      });
      expect(result.success).toBe(true);

      await expect(
        fs.stat(abandoned),
        "an abandoned project root survived — the leak is back",
      ).rejects.toThrow();
      await expect(
        fs.stat(active),
        "a project root with a run still inside the window was deleted",
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(notOurs, "subdir", "notes.txt")),
        "a directory harness-dispatch never created was deleted",
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(datedBackup, "data.bin")),
        "a foreign directory was deleted because its NAME looked like ours",
      ).resolves.toBeDefined();
      // And this dispatch's own root is obviously not self-deleted.
      await expect(fs.stat(result.workspace!.workspaceRoot!)).resolves.toBeDefined();
    } finally {
      if (originalEnv === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
      else process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = originalEnv;
      if (originalDir === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = originalDir;
      await fs.rm(wsHome, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("prunes git worktrees older than the retention window before creating a new one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-worktree-prune-"));
    await git(root, ["init"]);
    await fs.writeFile(path.join(root, "calc.mjs"), "export const value = 1;\n", "utf8");
    await git(root, ["add", "calc.mjs"]);
    await git(root, [
      "-c",
      "user.name=Harness Router Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);

    // Learn the workspaces root from the product rather than recomputing its
    // naming scheme here. The hand-built copy of that formula went stale the
    // moment the scheme changed, and a prune test that plants its fixture in
    // the wrong directory passes for the wrong reason just as easily as it
    // fails.
    const svcProbe = makeService({ name: "alpha", tier: 1 });
    const probeRouter = new Router(
      makeConfig([svcProbe]),
      quota,
      { alpha: new StubDispatcher("alpha") },
      leaderboard,
    );
    const probe = await probeRouter.route("noop", [], root, {
      hints: { safetyProfile: "workspace_edit", workspacePolicy: "git_worktree" },
    });
    const probeRoot = probe.result.workspace?.workspaceRoot;
    expect(probeRoot, "probe dispatch produced no workspace").toBeDefined();
    await git(root, ["worktree", "remove", "--force", path.join(probeRoot!, "worktree")]);
    await fs.rm(probeRoot!, { recursive: true, force: true, maxRetries: 3 });
    const staleGitWorkspaceRoot = path.dirname(probeRoot!);

    // Simulate a leftover worktree from a run older than the retention
    // window, NAMED THE WAY THE PRODUCT NAMES ONE.
    //
    // This said "created the same way prepareGitWorktreeWorkspace does" while
    // using the hand-written name "stale-run", which that function cannot
    // generate. The sweep now refuses to delete anything whose name it did not
    // produce — a recursive delete taking positive evidence that the directory
    // is ours — so the fixture was testing an input that never occurs, and
    // would have gone on passing while the real shape went unswept.
    // `workspaceRunId` is exported for exactly this.
    const staleWorkspaceRoot = path.join(staleGitWorkspaceRoot, workspaceRunId("alpha"));
    const staleWorktreeRoot = path.join(staleWorkspaceRoot, "worktree");
    await fs.mkdir(staleWorkspaceRoot, { recursive: true });
    await git(root, ["worktree", "add", "--detach", staleWorktreeRoot, "HEAD"]);
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(staleWorkspaceRoot, staleTime, staleTime);

    const svc = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new StubDispatcher("alpha");
    const router = new Router(makeConfig([svc]), quota, { alpha: dispatcher }, leaderboard);

    const originalEnv = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
    process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = String(24 * 60 * 60 * 1000);
    let worktreeRoot: string | undefined;
    try {
      const { result } = await router.route("noop", [], root, {
        hints: { safetyProfile: "workspace_edit", workspacePolicy: "git_worktree" },
      });
      expect(result.success).toBe(true);
      worktreeRoot = result.workspace?.workspaceRoot
        ? path.join(result.workspace.workspaceRoot, "worktree")
        : undefined;
    } finally {
      if (originalEnv === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
      else process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = originalEnv;
    }

    // The stale worktree must be gone from both disk and git's own registry.
    await expect(fs.stat(staleWorktreeRoot)).rejects.toThrow();
    const { stdout: list } = await execFile("git", ["worktree", "list"], {
      cwd: root,
      windowsHide: true,
    });
    expect(String(list)).not.toContain("stale-run");

    if (worktreeRoot) {
      await git(root, ["worktree", "remove", "--force", worktreeRoot]);
    }
  });

  it("falls back on transient error (non-rate-limited)", async () => {
    const a = makeService({ name: "alpha", tier: 1, leaderboardModel: "model-a" });
    const b = makeService({ name: "beta", tier: 1, leaderboardModel: "model-b" });
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-a",
      0.9,
      1400,
    );
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-b",
      0.85,
      1350,
    );
    const alphaD = new StubDispatcher("alpha");
    alphaD.setResult({ success: false, error: "boom" });
    const betaD = new StubDispatcher("beta");
    const router = new Router(
      makeConfig([a, b]),
      quota,
      { alpha: alphaD, beta: betaD },
      leaderboard,
    );
    const { result, decision } = await router.route("hi", [], "/tmp", {
      hints: { taskType: "execute" },
    });
    expect(result.success).toBe(true);
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toMatch(/fallback #1/);
  });

  it("falls back to the next candidate on a rate-limited result", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const alphaD = new StubDispatcher("alpha");
    alphaD.setResult({
      success: false,
      rateLimited: true,
      error: "429",
    } as Partial<DispatchResult>);
    const betaD = new StubDispatcher("beta");
    const router = new Router(
      makeConfig([a, b]),
      quota,
      { alpha: alphaD, beta: betaD },
      leaderboard,
    );
    const { result } = await router.route("hi", [], "/tmp");
    // Alpha rate-limits; the router excludes it and falls back to beta,
    // which succeeds — a rate limit should not fail the whole request.
    expect(result.success).toBe(true);
    expect(result.service).toBe("beta");
    expect(alphaD.calls.length).toBe(1);
    expect(betaD.calls.length).toBe(1);
  });

  it("gives up after maxFallbacks even when a rate-limited candidate remains untried", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const c = makeService({ name: "gamma", tier: 1 });
    const rateLimited = { success: false, rateLimited: true, error: "429" } as Partial<DispatchResult>;
    const alphaD = new StubDispatcher("alpha");
    alphaD.setResult(rateLimited);
    const betaD = new StubDispatcher("beta");
    betaD.setResult(rateLimited);
    const gammaD = new StubDispatcher("gamma");
    gammaD.setResult(rateLimited);
    const router = new Router(
      makeConfig([a, b, c]),
      quota,
      { alpha: alphaD, beta: betaD, gamma: gammaD },
      leaderboard,
    );
    // maxFallbacks: 1 -> 2 total attempts; the third candidate is never tried.
    const { result } = await router.route("hi", [], "/tmp", { maxFallbacks: 1 });
    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    const totalCalls = alphaD.calls.length + betaD.calls.length + gammaD.calls.length;
    expect(totalCalls).toBe(2);
  });

  it("returns a synthesized failure when no services are available", async () => {
    const router = new Router(makeConfig([]), quota, {}, leaderboard);
    const { result, decision } = await router.route("hi", [], "/tmp");
    expect(result.success).toBe(false);
    expect(result.service).toBe("none");
    expect(decision).toBeNull();
  });

  it("passes a per-call hints.timeoutMs through to the dispatcher", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.route("hi", [], "/tmp", { hints: { timeoutMs: 1_800_000 } });
    expect(alphaD.calls[0]?.timeoutMs).toBe(1_800_000);
  });

  it("falls back to the service's configured timeoutMs when no hint is given", async () => {
    const a = makeService({ name: "alpha", tier: 1, timeoutMs: 900_000 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.route("hi", [], "/tmp");
    expect(alphaD.calls[0]?.timeoutMs).toBe(900_000);
  });

  it("prefers a per-call timeoutMs hint over the service's configured default", async () => {
    const a = makeService({ name: "alpha", tier: 1, timeoutMs: 900_000 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.route("hi", [], "/tmp", { hints: { timeoutMs: 1_800_000 } });
    expect(alphaD.calls[0]?.timeoutMs).toBe(1_800_000);
  });

  it("leaves timeoutMs unset when neither a hint nor config override is given", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.route("hi", [], "/tmp");
    expect(alphaD.calls[0]?.timeoutMs).toBeUndefined();
  });
});

// The rule "a per-call timeoutMs hint beats the service's configured default"
// is written out FOUR times in router.ts — once per entry point (route :1184,
// routeTo :1070, stream :902, streamTo :1347) — and only the `route()` copy was
// pinned. An audit mutation swapped the operands in the `stream()` copy and the
// whole suite stayed green, which is the copy that matters: jobs.ts and the HTTP
// server both dispatch through `stream`/`streamTo`, so every background job and
// every HTTP call runs on the untested one.
//
// Table-driven on purpose. The point is not four more tests; it is that adding a
// fifth entry point without a row here is visibly incomplete, and that a fix
// applied to one copy cannot pass while the others still have the bug. Collapsing
// the four implementations (the real fix) should collapse this table with them.
describe("timeout precedence holds on every entry point, not just route()", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  /** Runs one entry point and reports the timeoutMs the dispatcher was handed. */
  const ENTRY_POINTS: Array<{
    name: string;
    /** Streaming entry points need the stub that implements `stream`. */
    streaming: boolean;
    run: (router: Router, timeoutMs?: number) => Promise<void>;
  }> = [
    {
      name: "route",
      streaming: false,
      run: async (router, timeoutMs) => {
        await router.route("hi", [], "/tmp", timeoutMs === undefined ? {} : { hints: { timeoutMs } });
      },
    },
    {
      name: "routeTo",
      streaming: false,
      run: async (router, timeoutMs) => {
        await router.routeTo("alpha", "hi", [], "/tmp", timeoutMs === undefined ? {} : { timeoutMs });
      },
    },
    {
      name: "stream",
      streaming: true,
      run: async (router, timeoutMs) => {
        for await (const _ of router.stream(
          "hi",
          [],
          "/tmp",
          timeoutMs === undefined ? {} : { hints: { timeoutMs } },
        )) {
          // drain
        }
      },
    },
    {
      name: "streamTo",
      streaming: true,
      run: async (router, timeoutMs) => {
        for await (const _ of router.streamTo(
          "alpha",
          "hi",
          [],
          "/tmp",
          timeoutMs === undefined ? {} : { timeoutMs },
        )) {
          // drain
        }
      },
    },
  ];

  function build(entry: (typeof ENTRY_POINTS)[number], svcTimeoutMs?: number) {
    const svc = makeService(
      svcTimeoutMs === undefined
        ? { name: "alpha", tier: 1 }
        : { name: "alpha", tier: 1, timeoutMs: svcTimeoutMs },
    );
    const dispatcher = entry.streaming
      ? new StreamStubDispatcher("alpha")
      : new StubDispatcher("alpha");
    const router = new Router(makeConfig([svc]), quota, { alpha: dispatcher }, leaderboard);
    const seen = (): number | undefined =>
      dispatcher instanceof StreamStubDispatcher
        ? dispatcher.lastOpts?.timeoutMs
        : dispatcher.calls[0]?.timeoutMs;
    return { router, seen };
  }

  it.each(ENTRY_POINTS.map((e) => [e.name, e] as const))(
    "%s prefers a per-call hint over the service's configured default",
    async (_name, entry) => {
      const { router, seen } = build(entry, 900_000);
      await entry.run(router, 1_800_000);
      expect(seen(), "the service's 900s default won over the caller's 1800s hint").toBe(1_800_000);
    },
  );

  it.each(ENTRY_POINTS.map((e) => [e.name, e] as const))(
    "%s falls back to the service's configured default when no hint is given",
    async (_name, entry) => {
      const { router, seen } = build(entry, 900_000);
      await entry.run(router);
      expect(seen()).toBe(900_000);
    },
  );

  it.each(ENTRY_POINTS.map((e) => [e.name, e] as const))(
    "%s leaves timeoutMs unset when neither is given",
    async (_name, entry) => {
      const { router, seen } = build(entry);
      await entry.run(router);
      expect(seen()).toBeUndefined();
    },
  );
});

describe("Router.stream — defaultTimeoutMs is a whole-call budget", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("gives the first attempt the full default when nothing has elapsed yet", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StreamStubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);

    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    for await (const _ of router.stream("hi", [], "/tmp", { defaultTimeoutMs: 3_600_000 })) {
      // drain
    }
    dateSpy.mockRestore();

    expect(alphaD.lastOpts?.timeoutMs).toBe(3_600_000);
  });

  it("shrinks a fallback attempt's timeout to whatever budget remains, and stops once it's gone", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const c = makeService({ name: "gamma", tier: 1 });
    const alphaD = new StreamStubDispatcher("alpha", { success: false, error: "boom" });
    const betaD = new StreamStubDispatcher("beta", { success: false, error: "boom" });
    const gammaD = new StreamStubDispatcher("gamma", { success: false, error: "boom" });
    const router = new Router(
      makeConfig([a, b, c]),
      quota,
      { alpha: alphaD, beta: betaD, gamma: gammaD },
      leaderboard,
    );

    // callStart=0; attempt 0 (alpha) sees the full budget; by the time
    // attempt 1 (beta) starts, 3,599,900ms have "elapsed" so only 100ms of
    // budget remains; by attempt 2 the budget is already spent.
    //
    // The clock is a VARIABLE advanced when each dispatcher runs, not a
    // mockReturnValueOnce sequence: internal code (breaker snapshots) also
    // calls Date.now(), so a positional sequence breaks whenever an unrelated
    // call is added or removed.
    let simulatedNow = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => simulatedNow);
    const alphaStream = alphaD.stream.bind(alphaD);
    alphaD.stream = (...args: Parameters<typeof alphaStream>) => {
      const it = alphaStream(...args);
      simulatedNow = 3_599_900; // alpha "takes" almost the whole budget
      return it;
    };
    const betaStream = betaD.stream.bind(betaD);
    betaD.stream = (...args: Parameters<typeof betaStream>) => {
      const it = betaStream(...args);
      simulatedNow = 3_600_100; // beta overruns what was left
      return it;
    };

    for await (const _ of router.stream("hi", [], "/tmp", {
      maxFallbacks: 2,
      defaultTimeoutMs: 3_600_000,
    })) {
      // drain
    }
    dateSpy.mockRestore();

    expect(alphaD.lastOpts?.timeoutMs).toBe(3_600_000);
    expect(betaD.lastOpts?.timeoutMs).toBe(100);
    // gamma is never dispatched — the budget was exhausted before attempt 2 started.
    expect(gammaD.lastOpts).toBeUndefined();
  });

  it("does NOT cap an explicit hints.timeoutMs by the elapsed background budget", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const alphaD = new StreamStubDispatcher("alpha", { success: false, error: "boom" });
    const betaD = new StreamStubDispatcher("beta", { success: true });
    const router = new Router(makeConfig([a, b]), quota, { alpha: alphaD, beta: betaD }, leaderboard);

    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(3_600_000_000); // way past any default
    for await (const _ of router.stream("hi", [], "/tmp", {
      hints: { timeoutMs: 1_800_000 },
      defaultTimeoutMs: 3_600_000,
    })) {
      // drain
    }
    dateSpy.mockRestore();

    // Explicit hint is a deliberate per-attempt choice — not budgeted.
    expect(alphaD.lastOpts?.timeoutMs).toBe(1_800_000);
    expect(betaD.lastOpts?.timeoutMs).toBe(1_800_000);
  });
});

describe("Router.routeTo", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("returns an error for unknown service", async () => {
    const router = new Router(makeConfig([]), quota, {}, leaderboard);
    const { result, decision } = await router.routeTo("nope", "hi", [], "/tmp");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown service/);
    expect(decision).toBeNull();
  });

  it("dispatches directly to the requested service with reason 'explicit'", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const router = new Router(
      makeConfig([a]),
      quota,
      { alpha: new StubDispatcher("alpha") },
      leaderboard,
    );
    const { decision } = await router.routeTo("alpha", "hi", [], "/tmp");
    expect(decision?.reason).toBe("explicit");
    expect(decision?.service).toBe("alpha");
  });

  it("passes an explicit opts.timeoutMs through to the dispatcher", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.routeTo("alpha", "hi", [], "/tmp", { timeoutMs: 1_200_000 });
    expect(alphaD.calls[0]?.timeoutMs).toBe(1_200_000);
  });

  it("falls back to the service's configured timeoutMs on routeTo when no opt is given", async () => {
    const a = makeService({ name: "alpha", tier: 1, timeoutMs: 900_000 });
    const alphaD = new StubDispatcher("alpha");
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);
    await router.routeTo("alpha", "hi", [], "/tmp");
    expect(alphaD.calls[0]?.timeoutMs).toBe(900_000);
  });
it("names the real reason when nothing is eligible, instead of guessing at three", async () => {
    // The message was fixed text — "all are disabled, exhausted, or
    // circuit-broken" — whatever had actually happened, printed next to every
    // breaker including untripped ones. A route the operator deliberately
    // blocked on billing was therefore reported as a health problem, beside a
    // breaker blob reading tripped:false, failures:0. That is this project's
    // own counter-signal: making a healthy route look unreliable.
    const paid = makeService({
      name: "metered",
      tier: 1,
      billingKind: "metered_api",
      paidUsagePossible: true,
    });
    const router = new Router(makeConfig([paid]), quota, { metered: new StubDispatcher("metered") }, leaderboard);
    const res = await router.route("hi", [], "/tmp");

    expect(res.result.success).toBe(false);
    expect(res.result.error).toContain("paid_blocked");
    expect(res.result.error).toContain("metered");
    // The causes that did NOT apply must not be asserted.
    expect(res.result.error).not.toMatch(/disabled, exhausted, or circuit-broken/);
    // No breaker tripped, so no breaker blob: an untripped one reads as
    // evidence of a fault that is not there.
    expect(res.result.error).not.toMatch(/breaker/i);
    // The machine-readable detail is unchanged.
    expect(res.result.skippedRoutes?.[0]?.code).toBe("paid_blocked");
  });
});

describe("a rejected input is not charged to the route", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache({} as never);
    leaderboard = new LeaderboardCache();
  });

  /**
   * The prompt-too-long refusal happens before any process is spawned and
   * fails identically on every argv route, so one over-long prompt cascading
   * through three routes counted three calls and three failures — and three
   * such dispatches opened healthy routes for 300 seconds. The route was never
   * asked to do anything.
   *
   * This tests the ROUTER's handling. A companion test in
   * dispatchers/generic-cli.test.ts covers the dispatcher setting the flag;
   * neither is sufficient alone, and the router half had no coverage at all —
   * disabling it passed every router test.
   */
  it("records no failure and leaves the breaker closed", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StubDispatcher("alpha", {
      success: false,
      error: "prompt too long for alpha",
      inputRejected: true,
    });
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);

    // Well past the breaker's 5-failure threshold, if these counted.
    for (let i = 0; i < 8; i += 1) {
      await router.routeTo("alpha", "hi", [], "/tmp");
    }

    const breaker = router.circuitBreakerStatus()["alpha"];
    expect(breaker?.tripped, "a rejected input tripped the route's breaker").toBe(false);
    expect(breaker?.failures, "a rejected input was counted as a route failure").toBe(0);
  });

  it("still counts a genuine failure", async () => {
    // The negative: suppressing the wrong thing would hide real breakage.
    const a = makeService({ name: "alpha", tier: 1 });
    const alphaD = new StubDispatcher("alpha", { success: false, error: "the CLI crashed" });
    const router = new Router(makeConfig([a]), quota, { alpha: alphaD }, leaderboard);

    await router.routeTo("alpha", "hi", [], "/tmp");

    expect(router.circuitBreakerStatus()["alpha"]?.failures).toBeGreaterThan(0);
  });
});
