/**
 * End-to-end coverage for cross-process circuit-breaker persistence.
 *
 * CircuitBreaker itself is in-memory only, so a Router constructed fresh
 * (as happens on every server restart) used to give every route a clean
 * slate — even one still mid-cooldown from a real rate limit. These tests
 * use the REAL Router/CircuitBreaker/BreakerStore (no mocks) and simulate a
 * restart by simply constructing a second Router against the same on-disk
 * breaker_state.json, the way a new server process would.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Router } from "../src/router.js";
import { QuotaCache } from "../src/quota.js";
import { LeaderboardCache } from "../src/leaderboard.js";
import { BreakerStore } from "../src/breaker-store.js";
import { buildStatus, renderStatusText } from "../src/status.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type {
  DispatcherEvent,
  DispatchResult,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../src/types.js";

class FakeDispatcher implements Dispatcher {
  readonly id: string;
  constructor(
    id: string,
    private readonly response: DispatchResult,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response;
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: this.response };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

/**
 * Same-identity dispatcher whose outcome can flip mid-test. Failures here are
 * plain (not rate-limited), so the breaker only accumulates a failure count
 * without tripping below CIRCUIT_BREAKER_THRESHOLD — routeTo keeps calling
 * through to the dispatcher on every attempt, unlike a rate-limit trip which
 * gates all future calls until the breaker resets.
 */
class ToggleDispatcher implements Dispatcher {
  readonly id: string;
  succeed = false;
  constructor(id: string) {
    this.id = id;
  }
  private response(): DispatchResult {
    return this.succeed
      ? { output: "ok", service: this.id, success: true }
      : { output: "", service: this.id, success: false, error: "boom" };
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response();
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: this.response() };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

function makeService(name: string): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness: name,
    command: name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: [],
    // Route-policy would otherwise block an "unknown billing" route before
    // ever reaching the dispatcher — declare it local/included so these
    // tests exercise the breaker, not the billing gate.
    provider: "local",
    surface: "local_endpoint",
    authSource: "local_network",
    billingKind: "local_compute",
    paidUsagePossible: false,
    billingConfidence: "documented",
  };
}

describe("Router restart survival — breaker state persists across process boundaries", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hr-breaker-restart-"));
    stateFile = path.join(dir, "breaker_state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildRouter(
    services: Record<string, ServiceConfig>,
    dispatchers: Record<string, Dispatcher>,
  ): Router {
    const config: RouterConfig = { services };
    const quota = new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") });
    const leaderboard = new LeaderboardCache();
    return new Router(config, quota, dispatchers, leaderboard, new BreakerStore(stateFile));
  }

  it("a rate-limited route stays excluded after the router is reconstructed (simulated server restart)", async () => {
    const services = { flaky: makeService("flaky"), backup: makeService("backup") };
    const dispatchers = {
      flaky: new FakeDispatcher("flaky", {
        output: "",
        service: "flaky",
        success: false,
        rateLimited: true,
        retryAfter: 300,
      }),
      backup: new FakeDispatcher("backup", { output: "ok", service: "backup", success: true }),
    };

    const routerA = buildRouter(services, dispatchers);
    await routerA.routeTo("flaky", "go", [], "/tmp");
    expect(routerA.getBreaker("flaky")!.isTripped).toBe(true);

    // Simulate a full process restart: a brand-new Router, same on-disk state.
    const routerB = buildRouter(services, dispatchers);
    expect(routerB.getBreaker("flaky")!.isTripped).toBe(true);
    expect(routerB.getBreaker("flaky")!.cooldownRemaining()).toBeGreaterThan(290);

    const decision = await routerB.pickService({});
    expect(decision?.service).toBe("backup");
  });

  it("a healthy route leaves no persisted state, so a restart starts it clean", async () => {
    const services = { steady: makeService("steady") };
    const dispatchers = {
      steady: new FakeDispatcher("steady", { output: "ok", service: "steady", success: true }),
    };

    const routerA = buildRouter(services, dispatchers);
    await routerA.routeTo("steady", "go", [], "/tmp");
    expect(routerA.getBreaker("steady")!.isTripped).toBe(false);

    const routerB = buildRouter(services, dispatchers);
    expect(routerB.getBreaker("steady")!.isTripped).toBe(false);
  });

  it("a cooldown that fully elapsed since the last persist doesn't block a fresh router", async () => {
    const services = { flaky: makeService("flaky") };
    const dispatchers = {
      flaky: new FakeDispatcher("flaky", {
        output: "",
        service: "flaky",
        success: false,
        rateLimited: true,
        // 500ms, not 50ms. The first assertion below has to observe the
        // breaker while it is STILL tripped, and a 50ms cooldown raced the
        // test's own execution: on a slow Windows CI runner it had already
        // elapsed by the time the expect ran, failing with "expected false to
        // be true" on a breaker that had worked correctly. A cooldown short
        // enough to wait out must still be long enough to see.
        retryAfter: 0.5,
      }),
    };

    const routerA = buildRouter(services, dispatchers);
    await routerA.routeTo("flaky", "go", [], "/tmp");
    expect(routerA.getBreaker("flaky")!.isTripped).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 700));

    const routerB = buildRouter(services, dispatchers);
    expect(routerB.getBreaker("flaky")!.isTripped).toBe(false);
  });

  it("sub-threshold failures persist as a partial failure count across a restart", async () => {
    const services = { flaky: makeService("flaky") };
    const dispatcher = new ToggleDispatcher("flaky");
    const dispatchers = { flaky: dispatcher };

    const routerA = buildRouter(services, dispatchers);
    await routerA.routeTo("flaky", "go", [], "/tmp");
    await routerA.routeTo("flaky", "go", [], "/tmp");
    expect(routerA.getBreaker("flaky")!.status()).toEqual({ tripped: false, failures: 2 });

    const routerB = buildRouter(services, dispatchers);
    expect(routerB.getBreaker("flaky")!.status()).toEqual({ tripped: false, failures: 2 });
  });

  it("a later success resets the persisted failure count to zero", async () => {
    const services = { recovering: makeService("recovering") };
    const dispatcher = new ToggleDispatcher("recovering");
    const dispatchers = { recovering: dispatcher };

    const routerA = buildRouter(services, dispatchers);
    await routerA.routeTo("recovering", "go", [], "/tmp");
    await routerA.routeTo("recovering", "go", [], "/tmp");
    expect(routerA.getBreaker("recovering")!.status().failures).toBe(2);

    // recordSuccess() resets the breaker, and that reset must also be
    // persisted (not just trips), or a restart would resurrect the stale count.
    dispatcher.succeed = true;
    await routerA.routeTo("recovering", "go", [], "/tmp");
    expect(routerA.getBreaker("recovering")!.status()).toEqual({ tripped: false, failures: 0 });

    const routerB = buildRouter(services, dispatchers);
    expect(routerB.getBreaker("recovering")!.status()).toEqual({ tripped: false, failures: 0 });
  });

  it("a corrupt record is reported as unknown state, not as a healthy route", async () => {
    // Losing the record un-trips the route — nothing can recover the count.
    // What is NOT acceptable is doing that silently: `breaker=closed
    // failures=0` is an assertion about the route, and after a corrupt read
    // the process has no basis for it.
    const stateDir = path.join(dir, "breaker_state");
    const services = { flaky: makeService("flaky") };
    const dispatchers = {
      flaky: new FakeDispatcher("flaky", {
        output: "",
        service: "flaky",
        success: false,
        rateLimited: true,
        retryAfter: 300,
      }),
    };
    const build = (): Router =>
      new Router(
        { services },
        new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") }),
        dispatchers,
        new LeaderboardCache(),
        new BreakerStore(stateDir),
      );

    const routerA = build();
    await routerA.routeTo("flaky", "go", [], "/tmp");
    expect(routerA.getBreaker("flaky")!.isTripped).toBe(true);

    // Truncated mid-write, the realistic corruption for an atomic-rename store
    // whose rename was interrupted.
    const record = readdirSync(stateDir).find((f) => f.endsWith(".json"))!;
    writeFileSync(path.join(stateDir, record), '{"failures": 5, "blockedUn');

    const routerB = build();
    expect(routerB.getBreaker("flaky")!.isTripped).toBe(false);
    routerB.circuitBreakerStatus();
    expect(routerB.breakerStateUnreadable()).toEqual(["flaky"]);

    const status = await buildStatus(
      { services },
      dispatchers,
      new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") }),
      routerB,
      new LeaderboardCache(),
    );
    expect(status.routes[0]!.breaker.stateUnreadable).toBe(true);
    expect(renderStatusText(status)).toContain("saved breaker state unreadable");
  });

  it("an unreadable record with no matching route is still reported, not dropped", () => {
    // The per-route line is where this normally shows, and a corrupt LEGACY
    // blob has no route name at all — so the report had nowhere to go in
    // exactly the case it was added for. Same for a record left behind by a
    // route since renamed.
    const stateDir = path.join(dir, "breaker_state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(dir, "breaker_state.json"), "{ truncated mid-writ");
    writeFileSync(path.join(stateDir, "route_since_renamed.json"), "{ also bad");

    const services = { flaky: makeService("flaky") };
    const dispatchers = { flaky: new FakeDispatcher("flaky", { output: "ok", service: "flaky", success: true }) };
    const router = new Router(
      { services },
      new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") }),
      dispatchers,
      new LeaderboardCache(),
      new BreakerStore(stateDir),
    );
    router.circuitBreakerStatus();
    expect(router.breakerStateUnreadable().sort()).toEqual([
      "(legacy breaker_state.json)",
      "route_since_renamed",
    ]);
  });

  it("state warnings are reported apart from config warnings, under their own heading", async () => {
    // configWarnings says "these change behaviour" and means config entries
    // that were ignored. A lost cooldown is neither — nothing was
    // misconfigured and nothing was ignored — and `doctor` plus the CLI's
    // "ignored config entries" list both read configWarnings directly, so
    // filing it there would have reached them mislabelled.
    const stateDir = path.join(dir, "breaker_state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "route_since_renamed.json"), "{ bad");

    const services = { flaky: makeService("flaky") };
    const dispatchers = { flaky: new FakeDispatcher("flaky", { output: "ok", service: "flaky", success: true }) };
    const router = new Router(
      { services },
      new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") }),
      dispatchers,
      new LeaderboardCache(),
      new BreakerStore(stateDir),
    );
    const status = await buildStatus(
      { services },
      dispatchers,
      new QuotaCache(dispatchers, { stateFile: path.join(dir, "quota_state.json") }),
      router,
      new LeaderboardCache(),
    );

    expect(status.stateWarnings).toEqual([
      "saved breaker state for route_since_renamed is unreadable — a cooldown it held may have been lost",
    ]);
    expect(status.configWarnings).toBeUndefined();
    const text = renderStatusText(status);
    expect(text).toContain("Saved state (1) — could not be read:");
    expect(text).not.toContain("Config warnings");
  });
});
