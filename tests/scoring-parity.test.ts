/**
 * Scoring regression fixtures — table-driven, byte-identical expected scores.
 *
 * NOT a parity suite any more, whatever its filename says. It was written to
 * pin this TypeScript port against the Python `router.py` it replaced, and
 * that file no longer exists in this repo — so "parity" describes a comparison
 * nobody can perform, and the `router.py:265-280` citations below point into
 * something unopenable. What the suite actually does now is refuse to let the
 * scoring formula move without someone saying so, which is worth keeping and
 * is a different claim.
 *
 * Deliberate divergences from the original formula are recorded at the fixture
 * that carries them, not here, so the explanation sits next to the number it
 * explains. There is one so far — see the taskType=local fixture.
 *
 * Formula (originally Python router.py:265-280, kept for provenance; the
 * quality_score factor it began with is gone along with the leaderboard):
 *   score = cli_capability * capability[task_type] * quota_score * weight
 *   + 0.3 bonus if prefer_large_context AND harness is "antigravity"/"antigravity_cli"
 *
 * One deliberate divergence: Python's `+0.3 if task_type=="local" AND
 * openai_compatible on localhost` is gone. A bonus only reorders within a
 * tier, so it could never reach a local endpoint sitting below a healthy
 * tier-1 route — the preference is a cross-tier selection rule now. See the
 * fixture's own comment.
 *
 * Each fixture lists the configured services, the mocks (quota),
 * the routing hints, and the expected winning service + final_score.
 */

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
    unreadableRoutes() {
      return [];
    }
    lastWriteError() {
      return undefined;
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
import path from "node:path";

// ---- Mocks (same shape as router.test.ts) -------------------------------



vi.mock("../src/quota.js", () => {
  class QuotaCache {
    private scores = new Map<string, number>();
    setScore(service: string, score: number): void {
      this.scores.set(service, score);
    }
    async getQuotaScore(service: string): Promise<number> {
      return this.scores.get(service) ?? 1.0;
    }
    // Counted, not no-op: the router asks this stand-in whether a route has
    // ever succeeded, and one that always answers "no calls" would silently
    // exempt every route here from the never-succeeded skip.
    private counts = new Map<string, { calls: number; successes: number }>();
    recordResult(service?: string, result?: { success?: boolean }): void {
      if (!service) return;
      const c = this.counts.get(service) ?? { calls: 0, successes: 0 };
      c.calls += 1;
      if (result?.success) c.successes += 1;
      this.counts.set(service, c);
    }
    localCountsFor(service: string): { calls: number; successes: number } {
      return this.counts.get(service) ?? { calls: 0, successes: 0 };
    }
  }
  return { QuotaCache };
});

// ---- Imports --------------------------------------------------------------

import { Router } from "../src/router.js";
import { QuotaCache } from "../src/quota.js";
import type { DispatchResult, RouterConfig, RouteHints, ServiceConfig } from "../src/types.js";
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


// ---- Helpers -------------------------------------------------------------

function svc(o: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    command: o.name,
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
    ...o,
  } as ServiceConfig;
}

class Stub implements Dispatcher {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return { output: "", service: this.id, success: true } as DispatchResult;
  }

  /**
   * Present, and throws.
   *
   * `Dispatcher` requires it, and this stub claimed to implement the
   * interface without it for as long as nothing typechecked the tests. A
   * throwing body is deliberately stronger than absence: the buffered entry
   * points must reach a dispatcher through `dispatch()`, because
   * OpenAICompatibleDispatcher's `dispatch()` sends `stream: false` on the
   * wire, and any test that accidentally routes a buffered call through
   * streaming now fails loudly here instead of passing quietly.
   */
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<import("../src/types.js").DispatcherEvent> {
    throw new Error(
      "Stub.stream() was called — a buffered entry point must use dispatch()",
    );
  }

  async checkQuota(): Promise<never> {
    throw new Error("n/a");
  }
  isAvailable(): boolean {
    return true;
  }
}

interface QuotaEntry {
  service: string;
  score: number;
}

interface Fixture {
  name: string;
  services: ServiceConfig[];
  hints?: RouteHints;
  quotas?: QuotaEntry[];
  brokenServices?: string[]; // names of services to circuit-break before picking
  expected: {
    service: string;
    finalScore: number;
    tier: number;
    reasonContains?: string;
  };
}

// ---- Fixtures ------------------------------------------------------------

const FIXTURES: Fixture[] = [
  // ------------------------------------------------------------------------
  // 1. Two claude-family tier-1 services, execute task, different weights.
  //    alpha: 1.10 * 0.95 * 1.0 * 1.2   = 1.254
  //    beta:  1.08 * 1.0  * 1.0 * 1.0   = 1.08
  //    -> alpha wins with 1.254
  // ------------------------------------------------------------------------
  {
    name: "two tier-1, execute task, higher weight x capability wins",
    services: [
      svc({
        name: "alpha",
        tier: 1,
        cliCapability: 1.1,
        weight: 1.2,
        capabilities: { execute: 0.95, plan: 1.0, review: 1.0 },
      }),
      svc({
        name: "beta",
        tier: 1,
        cliCapability: 1.08,
        capabilities: { execute: 1.0, plan: 0.83, review: 0.82 },
      }),
    ],
    hints: { taskType: "execute" },
    expected: { service: "alpha", finalScore: 1.254, tier: 1 },
  },

  // ------------------------------------------------------------------------
  // 2. Tier-1 service circuit-broken, tier-2 available.
  //    beta: 1.0 * 1.0 * 1.0 * 0.8 = 0.8
  //    reason contains "fallback"
  // ------------------------------------------------------------------------
  {
    name: "tier-1 broken -> tier-2 fallback",
    services: [
      svc({ name: "alpha", tier: 1 }),
      svc({ name: "beta", tier: 2, weight: 0.8 }),
    ],
    brokenServices: ["alpha"],
    expected: {
      service: "beta",
      finalScore: 0.8,
      tier: 2,
      reasonContains: "fallback",
    },
  },

  // ------------------------------------------------------------------------
  // 3. Forced-service hint.
  //    alpha is lower-scoring but forced via hints.service.
  //    alpha: 1.0 * 1.0 * 1.0 * 0.7 = 0.7 (no task_type -> cap=1.0)
  //    reason: "forced"
  // ------------------------------------------------------------------------
  {
    name: "forced service bypasses tier selection",
    services: [
      svc({ name: "alpha", tier: 1, weight: 0.7 }),
      svc({ name: "beta", tier: 1, weight: 0.95 }),
    ],
    hints: { service: "alpha" },
    expected: {
      service: "alpha",
      finalScore: 0.7,
      tier: 1,
      reasonContains: "forced",
    },
  },

  // ------------------------------------------------------------------------
  // 4. preferLargeContext=true: gemini tier-2 beats non-gemini tier-2.
  //    NOTE (deviation from prompt): the prompt asked for a non-antigravity
  //    tier-1 service with quota=0 competing against an antigravity tier-2.
  //    Tier-1 always wins over tier-2 regardless of score (Python
  //    router.py:296-309), so that setup wouldn't actually let antigravity
  //    win. Both services are moved to tier 2 so the +0.3 boost is the
  //    deciding factor.
  //    non-antigravity: 1.0 * 1.0 * 1.0 * 0.85        = 0.85
  //    antigravity:     1.0 * 1.0 * 1.0 * 0.7  + 0.3   = 1.0
  //    -> antigravity wins
  // ------------------------------------------------------------------------
  {
    // The boost keys off DECLARED max_input_tokens (>=2M -> +0.3), not the
    // harness name — antigravity wins here because its entry declares 2M.
    name: "preferLargeContext boosts declared 2M-context routes by 0.3",
    services: [
      svc({
        name: "non_antigravity",
        tier: 2,
        weight: 0.85,
        harness: "claude_code",
      }),
      svc({
        name: "antigravity_cli",
        tier: 2,
        harness: "antigravity_cli",
        weight: 0.7,
        maxInputTokens: 2_000_000,
      }),
    ],
    hints: { preferLargeContext: true },
    expected: { service: "antigravity_cli", finalScore: 1.0, tier: 2 },
  },

  // ------------------------------------------------------------------------
  // 5. taskType=local: the local route wins by the cross-tier RULE, not by a
  //    score bonus. Both scores are the plain formula:
  //      cloud:  1.0 * 1.0 * 1.0 * 0.75 = 0.75  (declared non-local)
  //      ollama: 1.0 * 1.0 * 1.0 * 0.6  = 0.6   (local, and so preferred)
  //    -> ollama wins on 0.6 while cloud sits at 0.75, which is the point.
  // ------------------------------------------------------------------------
  {
    // DELIBERATE DIVERGENCE from the Python formula, recorded rather than
    // silenced — this suite exists to catch accidental drift, so a reasoned
    // change has to say so here or it looks like drift forever.
    //
    // Python added +0.3 for a localhost openai_compatible route under
    // taskType=local, making this fixture score 0.9. That bonus could never
    // do its job: it only reorders WITHIN a tier, and local endpoints sit in
    // the cheap tier, so any healthy tier-1 route won before the bonus was
    // consulted. Measured on a real config, every taskType including 'local'
    // resolved to the same tier-1 CLI and the configured local box had 0 calls
    // in a month.
    //
    // The preference is now a cross-tier selection rule instead, so the bonus
    // is gone and the score is the plain formula. `ollama` still wins — by the
    // rule rather than by an inflated number.
    name: "taskType=local prefers the local route (no score bonus; see comment)",
    services: [
      svc({
        name: "cloud",
        tier: 3,
        weight: 0.75,
        type: "openai_compatible",
        baseUrl: "https://api.cloud.example.com/v1",
        // Spelled out because svc() defaults EVERY fixture to local on all
        // four declared signals. A route named "cloud" that is local by every
        // field it declares makes this fixture assert the opposite of its
        // name — and it did: cloud won the local preference on score.
        provider: "anthropic",
        surface: "claude_code",
        authSource: "oauth_session",
        billingKind: "included_plan_usage",
      }),
      svc({
        name: "ollama",
        tier: 3,
        weight: 0.6,
        type: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
      }),
    ],
    hints: { taskType: "local" },
    expected: { service: "ollama", finalScore: 0.6, tier: 3 },
  },
];

// ---- Runner --------------------------------------------------------------

function buildContext(fixture: Fixture): {
  router: Router;
  quota: QuotaCache;
} {
  const quota = new QuotaCache({});
  for (const q of fixture.quotas ?? []) {
    (quota as unknown as { setScore: (s: string, v: number) => void }).setScore(
      q.service,
      q.score,
    );
  }
  const services: Record<string, ServiceConfig> = {};
  const dispatchers: Record<string, Dispatcher> = {};
  for (const s of fixture.services) {
    services[s.name] = s;
    dispatchers[s.name] = new Stub(s.name);
  }
  const config: RouterConfig = { services };
  const router = new Router(config, quota, dispatchers);
  for (const name of fixture.brokenServices ?? []) {
    const b = router.getBreaker(name);
    b!.trip();
  }
  return { router, quota };
}

describe("Scoring regression — the formula does not move without someone saying so", () => {
  let warned = false;
  beforeEach(() => {
    warned = false;
  });

  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const { router } = buildContext(fixture);
      const decision = await router.pickService({
        ...(fixture.hints ? { hints: fixture.hints } : {}),
      });
      expect(decision).not.toBeNull();
      expect(decision!.service).toBe(fixture.expected.service);
      expect(decision!.tier).toBe(fixture.expected.tier);
      // 4-decimal precision check on the final score.
      expect(Number(decision!.finalScore.toFixed(4))).toBeCloseTo(
        fixture.expected.finalScore,
        4,
      );
      if (fixture.expected.reasonContains) {
        expect(decision!.reason).toContain(fixture.expected.reasonContains);
      }
      // touch the flag so the lint doesn't complain about the unused var
      if (!warned) warned = true;
      expect(warned).toBe(true);
    });
  }
});
