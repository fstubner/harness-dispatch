/**
 * Router unit tests.
 *
 * Mocks the CircuitBreaker, QuotaCache, LeaderboardCache, and Dispatcher
 * modules — this test suite focuses on router scoring + dispatch logic,
 * not on those dependencies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// ---- Mock dependency modules with minimal stand-ins ----------------------

vi.mock("../src/circuit-breaker.js", () => {
  class CircuitBreaker {
    failures = 0;
    private _tripped = false;
    private _cooldown = 300;
    get isTripped(): boolean {
      return this._tripped;
    }
    recordFailure(): void {
      this.failures += 1;
    }
    recordSuccess(): void {
      this.failures = 0;
      this._tripped = false;
    }
    trip(retryAfter?: number): void {
      this._tripped = true;
      if (retryAfter !== undefined && retryAfter > 0) this._cooldown = retryAfter;
    }
    forceTrip(): void {
      // Test helper — bypass the threshold
      this._tripped = true;
    }
    cooldownRemaining(): number {
      return this._tripped ? this._cooldown : 0;
    }
    status(): { tripped: boolean; failures: number; cooldownRemainingSec?: number } {
      if (this._tripped) {
        return { tripped: true, failures: this.failures, cooldownRemainingSec: this._cooldown };
      }
      return { tripped: false, failures: this.failures };
    }
  }
  return { CircuitBreaker };
});

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

import { Router } from "../src/router.js";
import { QuotaCache } from "../src/quota.js";
import { LeaderboardCache } from "../src/leaderboard.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { DispatchResult, RouterConfig, ServiceConfig, TaskType } from "../src/types.js";
import type { Dispatcher } from "../src/dispatchers/base.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd, windowsHide: true });
}

// ---- Test helpers --------------------------------------------------------

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
    (alphaBreaker as unknown as { forceTrip(): void }).forceTrip();
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
    (router.getBreaker("alpha") as unknown as { forceTrip(): void }).forceTrip();
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

  it("applies +0.3 taskType=local boost to localhost openai_compatible services", async () => {
    const cloud = makeService({
      name: "cloud",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
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

    const staleRoot = path.join(root, ".harness-dispatch", "workspaces", "stale-run");
    await fs.mkdir(staleRoot, { recursive: true });
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(staleRoot, staleTime, staleTime);

    const svc = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new StubDispatcher("alpha");
    const router = new Router(makeConfig([svc]), quota, { alpha: dispatcher }, leaderboard);

    const originalEnv = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
    process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = String(24 * 60 * 60 * 1000);
    try {
      const { result } = await router.route("noop", [], root, {
        hints: { safetyProfile: "workspace_edit", workspacePolicy: "copy" },
      });
      expect(result.success).toBe(true);
      // The fresh workspace this same call created must survive pruning —
      // only the pre-existing stale one should be gone.
      expect(result.workspace?.workspaceRoot).toBeDefined();
      await expect(fs.stat(result.workspace!.workspaceRoot!)).resolves.toBeDefined();
    } finally {
      if (originalEnv === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
      else process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS = originalEnv;
    }

    await expect(fs.stat(staleRoot)).rejects.toThrow();
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

    // Simulate a leftover worktree from a run older than the retention
    // window, created the same way prepareGitWorktreeWorkspace does.
    const staleGitWorkspaceRoot = path.join(
      os.tmpdir(),
      "harness-dispatch",
      "workspaces",
      path.basename(root).replace(/[^A-Za-z0-9_.-]/g, "_"),
    );
    const staleWorkspaceRoot = path.join(staleGitWorkspaceRoot, "stale-run");
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
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(0); // callStart
    dateSpy.mockReturnValueOnce(0); // attempt 0 remaining calc
    dateSpy.mockReturnValueOnce(3_599_900); // attempt 1 remaining calc
    dateSpy.mockReturnValue(3_600_100); // attempt 2 remaining calc (budget exhausted)

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
});
