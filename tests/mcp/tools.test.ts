import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { invokeTool, TOOL_NAMES } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { LeaderboardCache } from "../../src/leaderboard.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatcherEvent,
  DispatchResult,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

class FakeDispatcher implements Dispatcher {
  readonly id: string;
  constructor(
    id: string,
    private readonly response: DispatchResult = {
      output: "hello",
      service: id,
      success: true,
    },
    private readonly available = true,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response;
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "stdout", chunk: this.response.output };
    yield { type: "completion", result: this.response };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return this.available;
  }
}

function makeService(name: string, over: Partial<ServiceConfig> = {}): ServiceConfig {
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
    leaderboardModel: `${name}-model`,
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    provider: "local",
    surface: "local_endpoint",
    authSource: "local_network",
    billingKind: "local_compute",
    paidUsagePossible: false,
    billingConfidence: "documented",
    ...over,
  };
}

function buildHolder(
  services: Record<string, ServiceConfig>,
  dispatchers: Record<string, Dispatcher>,
): RuntimeHolder {
  const config: RouterConfig = { services };
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-not-used:" });
  const leaderboard = new LeaderboardCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (leaderboard as any).fetchedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (leaderboard as any).data = {
    "a-model": 1500,
    "b-model": 1400,
    "c-model": 1300,
    "preferred-model": 1600,
  };
  const router = new Router(config, quota, dispatchers, leaderboard);
  const state: RuntimeState = {
    config,
    dispatchers,
    quota,
    router,
    leaderboard,
    mtimeMs: 0,
  };
  return new RuntimeHolder(state);
}

beforeEach(() => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "harness-router-jobs-"));
  vi.stubEnv("HARNESS_ROUTER_JOBS_DIR", jobsDir);
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
});

describe("MCP tools — public surface", () => {
  it("exports the public code, job, and usage tools", () => {
    expect(TOOL_NAMES).toEqual(["code", "job", "usage"]);
  });
});

describe("MCP tools — code", () => {
  it("routes successfully in default single mode", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", { leaderboardModel: "a-model" }),
        b: makeService("b", { leaderboardModel: "b-model" }),
      },
      {
        a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
      },
    );

    const r = await invokeTool("code", { prompt: "hi", hints: { taskType: "plan" } }, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as {
      mode: "single";
      success: boolean;
      route: string;
      output: string;
      routing?: { tier: number; finalScore: number };
    };
    expect(data.mode).toBe("single");
    expect(data.success).toBe(true);
    expect(data.route).toBe("a");
    expect(data.output).toBe("from a");
    expect(data.routing?.finalScore).toBeGreaterThan(0);
  });

  it("boosts a preferred model without exposing service or harness hints", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", { leaderboardModel: "a-model" }),
        b: makeService("b", { leaderboardModel: "preferred-model" }),
      },
      {
        a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      { prompt: "hi", hints: { model: "preferred-model", taskType: "plan" } },
      { holder },
    );
    const data = r.data as { route: string; model?: string };
    expect(data.route).toBe("b");
    expect(data.model).toBe("preferred-model");
  });

  it("surfaces skipped routes in single mode", async () => {
    const holder = buildHolder(
      {
        paid: makeService("paid", {
          provider: "openai",
          surface: "openai_api",
          authSource: "api_key",
          billingKind: "metered_api",
          paidUsagePossible: true,
          leaderboardModel: "preferred-model",
        }),
        local: makeService("local", { leaderboardModel: "a-model" }),
      },
      {
        paid: new FakeDispatcher("paid", { output: "paid", service: "paid", success: true }),
        local: new FakeDispatcher("local", { output: "local", service: "local", success: true }),
      },
    );

    const r = await invokeTool("code", { prompt: "hi", hints: { taskType: "plan" } }, { holder });
    const data = r.data as { route: string; skippedRoutes?: Array<{ route: string; code: string }> };
    expect(data.route).toBe("local");
    expect(data.skippedRoutes).toEqual([
      expect.objectContaining({ route: "paid", code: "paid_blocked" }),
    ]);
  });

  it("keeps local-only requests on local routes", async () => {
    const holder = buildHolder(
      {
        cloud: makeService("cloud", {
          provider: "openai",
          surface: "openai_api",
          authSource: "api_key",
          billingKind: "included_plan_usage",
          paidUsagePossible: false,
          leaderboardModel: "preferred-model",
        }),
        local: makeService("local", { leaderboardModel: "a-model" }),
      },
      {
        cloud: new FakeDispatcher("cloud", { output: "cloud", service: "cloud", success: true }),
        local: new FakeDispatcher("local", { output: "local", service: "local", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      { prompt: "hi", hints: { taskType: "plan", routePolicy: "local_only" } },
      { holder },
    );
    const data = r.data as { route: string; skippedRoutes?: Array<{ route: string; code: string }> };
    expect(data.route).toBe("local");
    expect(data.skippedRoutes).toEqual([
      expect.objectContaining({ route: "cloud", code: "route_policy" }),
    ]);
  });

  it("requires approval before explicit non-local routes when requested", async () => {
    const holder = buildHolder(
      {
        cloud: makeService("cloud", {
          provider: "anthropic",
          surface: "claude_code",
          authSource: "product_login",
          billingKind: "included_plan_usage",
          paidUsagePossible: false,
        }),
      },
      {
        cloud: new FakeDispatcher("cloud", { output: "cloud", service: "cloud", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      { prompt: "hi", hints: { routePolicy: "approval_required" } },
      { holder },
    );
    const data = r.data as { success: boolean; skippedRoutes?: Array<{ route: string; code: string }> };
    expect(data.success).toBe(false);
    expect(data.skippedRoutes).toEqual([
      expect.objectContaining({ route: "cloud", code: "approval_required" }),
    ]);
  });

  it("fans out to all available routes", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", { capabilities: { execute: 0.9, plan: 0.95, review: 0.9 } }),
        b: makeService("b", { capabilities: { execute: 1.0, plan: 0.8, review: 0.7 } }),
      },
      {
        a: new FakeDispatcher("a", { output: "A", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "B", service: "b", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      { mode: "fanout", prompt: "hi", hints: { taskType: "plan" } },
      { holder },
    );
    const data = r.data as {
      mode: "fanout";
      results: Array<{ route: string; success: boolean; output: string }>;
    };
    expect(data.mode).toBe("fanout");
    expect(data.results).toHaveLength(2);
    expect(data.results[0]!.route).toBe("a");
    expect(data.results.map((item) => item.output).sort()).toEqual(["A", "B"]);
  });

  it("blocks explicit write-capable fanout without an isolated workspace policy", async () => {
    const holder = buildHolder(
      {
        a: makeService("a"),
        b: makeService("b"),
      },
      {
        a: new FakeDispatcher("a", { output: "A", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "B", service: "b", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      {
        mode: "fanout",
        prompt: "edit files",
        hints: { safetyProfile: "workspace_edit" },
      },
      { holder },
    );
    const data = r.data as {
      mode: "fanout";
      results: Array<{ route: string }>;
      skippedRoutes?: Array<{ route: string; code: string }>;
    };
    expect(data.results).toEqual([]);
    expect(data.skippedRoutes).toEqual([
      expect.objectContaining({ route: "fanout", code: "workspace_isolation_required" }),
    ]);
  });

  it("allows explicit write-capable fanout with copy-isolated workspaces", async () => {
    const workingDir = mkdtempSync(path.join(tmpdir(), "harness-router-fanout-copy-"));
    const holder = buildHolder(
      {
        a: makeService("a"),
        b: makeService("b"),
      },
      {
        a: new FakeDispatcher("a", { output: "A", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "B", service: "b", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      {
        mode: "fanout",
        prompt: "edit files",
        workingDir,
        workspacePolicy: "copy",
        hints: { safetyProfile: "workspace_edit" },
      },
      { holder },
    );
    const data = r.data as {
      mode: "fanout";
      results: Array<{ route: string; workspace?: { policy: string; isolated: boolean } }>;
    };
    expect(data.results.map((item) => item.route).sort()).toEqual(["a", "b"]);
    expect(data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace: expect.objectContaining({ policy: "copy", isolated: true }),
        }),
      ]),
    );
  });

  it("surfaces skipped routes in fanout mode", async () => {
    const holder = buildHolder(
      {
        paid: makeService("paid", {
          provider: "openai",
          surface: "openai_api",
          authSource: "api_key",
          billingKind: "metered_api",
          paidUsagePossible: true,
        }),
        local: makeService("local"),
      },
      {
        paid: new FakeDispatcher("paid", { output: "paid", service: "paid", success: true }),
        local: new FakeDispatcher("local", { output: "local", service: "local", success: true }),
      },
    );

    const r = await invokeTool("code", { mode: "fanout", prompt: "hi" }, { holder });
    const data = r.data as {
      results: Array<{ route: string }>;
      skippedRoutes?: Array<{ route: string; code: string }>;
    };
    expect(data.results.map((item) => item.route)).toEqual(["local"]);
    expect(data.skippedRoutes).toEqual([
      expect.objectContaining({ route: "paid", code: "paid_blocked" }),
    ]);
  });

  it("runs opted-in paid API routes in fanout mode", async () => {
    const holder = buildHolder(
      {
        cloud: makeService("cloud", {
          provider: "openai",
          surface: "openai_api",
          authSource: "api_key",
          billingKind: "metered_api",
          paidUsagePossible: true,
          allowPaidUsage: true,
        }),
        local: makeService("local"),
      },
      {
        cloud: new FakeDispatcher("cloud", { output: "cloud", service: "cloud", success: true }),
        local: new FakeDispatcher("local", { output: "local", service: "local", success: true }),
      },
    );

    const r = await invokeTool(
      "code",
      {
        mode: "fanout",
        prompt: "hi",
        hints: { routePolicy: "standard" },
      },
      { holder },
    );
    const data = r.data as {
      results: Array<{ route: string }>;
      skippedRoutes?: Array<{ route: string; code: string }>;
    };
    expect(data.results.map((item) => item.route)).toEqual(["cloud", "local"]);
    expect(data.skippedRoutes ?? []).toEqual([]);
  });

  it("filters fanout by model labels", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", { leaderboardModel: "a-model" }),
        b: makeService("b", { leaderboardModel: "b-model" }),
      },
      {
        a: new FakeDispatcher("a"),
        b: new FakeDispatcher("b"),
      },
    );

    const r = await invokeTool("code", { mode: "fanout", prompt: "hi", models: ["b-model"] }, { holder });
    const data = r.data as { results: Array<{ route: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.route).toBe("b");
  });

  it("starts and inspects an async job", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", { leaderboardModel: "a-model" }),
      },
      {
        a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }),
      },
    );

    const started = await invokeTool(
      "job",
      { action: "start", prompt: "hi", service: "a" },
      { holder },
    );
    const startData = started.data as { jobId: string; status: string; jobDir: string };
    expect(startData.jobId).toMatch(/^job-/);
    expect(startData.status).toBe("queued");

    let data: { status: { status: string }; result?: { result: { output: string } } } | null =
      null;
    for (let i = 0; i < 100; i += 1) {
      const inspected = await invokeTool(
        "job",
        { action: "get", jobId: startData.jobId },
        { holder },
      );
      data = inspected.data as typeof data;
      if (data?.status.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(data?.status.status).toBe("completed");
    expect(data?.result?.result.output).toBe("async A");
    rmSync(startData.jobDir, { recursive: true, force: true });
  });

  it("warns when workingDir is omitted and defaults to the router's own cwd", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "hi", service: "a", success: true }) },
    );

    const withoutWorkingDir = await invokeTool("code", { prompt: "hi" }, { holder });
    const withoutData = withoutWorkingDir.data as { warning?: string };
    expect(withoutData.warning).toMatch(/workingDir was not provided/);

    const withWorkingDir = await invokeTool(
      "code",
      { prompt: "hi", workingDir: "/some/project" },
      { holder },
    );
    const withData = withWorkingDir.data as { warning?: string };
    expect(withData.warning).toBeUndefined();
  });

  it("includes poll guidance when starting a job, and drops it once completed", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    const started = await invokeTool(
      "job",
      { action: "start", prompt: "hi", service: "a", workingDir: "/some/project" },
      { holder },
    );
    const startData = started.data as {
      jobId: string;
      jobDir: string;
      nextPollSeconds?: number;
      instructions?: string;
      warning?: string;
    };
    expect(startData.nextPollSeconds).toBeGreaterThan(0);
    expect(startData.instructions).toMatch(/job action=get/);
    // workingDir was provided explicitly, so no defaulted-cwd warning.
    expect(startData.warning).toBeUndefined();

    let data: { status: { status: string }; result?: { result: { output: string } } } | null =
      null;
    for (let i = 0; i < 100; i += 1) {
      const inspected = await invokeTool("job", { action: "get", jobId: startData.jobId }, { holder });
      data = inspected.data as typeof data;
      if (data?.status.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(data?.status.status).toBe("completed");
    rmSync(startData.jobDir, { recursive: true, force: true });
  });

  it("plumbs hints.taskType and hints.model through to an explicit-service job dispatch", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", {
          leaderboardModel: "a-model",
          capabilities: { execute: 1.0, plan: 0.4, review: 1.0 },
        }),
      },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    const started = await invokeTool(
      "job",
      {
        action: "start",
        prompt: "hi",
        service: "a",
        workingDir: "/some/project",
        hints: { taskType: "plan", model: "explicit-override" },
      },
      { holder },
    );
    const startData = started.data as { jobId: string; jobDir: string };

    let data: {
      status: { status: string };
      result?: { decision: { taskType: string; model?: string; capabilityScore: number } };
    } | null = null;
    for (let i = 0; i < 100; i += 1) {
      const inspected = await invokeTool("job", { action: "get", jobId: startData.jobId }, { holder });
      data = inspected.data as typeof data;
      if (data?.status.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(data?.status.status).toBe("completed");
    // Before the fix, explicit-service dispatch always recorded taskType: ""
    // and svc.model, ignoring hints entirely.
    expect(data?.result?.decision.taskType).toBe("plan");
    expect(data?.result?.decision.model).toBe("explicit-override");
    expect(data?.result?.decision.capabilityScore).toBeCloseTo(0.4, 10);
    rmSync(startData.jobDir, { recursive: true, force: true });
  });

  it("bounds a huge dispatcher error in status/result JSON but keeps the full text in stderr.log", async () => {
    const hugeError = "X".repeat(200_000);
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      {
        a: new FakeDispatcher("a", {
          output: "",
          service: "a",
          success: false,
          error: hugeError,
        }),
      },
    );

    const started = await invokeTool(
      "job",
      { action: "start", prompt: "hi", service: "a", workingDir: "/some/project" },
      { holder },
    );
    const startData = started.data as { jobId: string; jobDir: string };

    let data: { status: { status: string; error?: string } } | null = null;
    for (let i = 0; i < 100; i += 1) {
      const inspected = await invokeTool("job", { action: "get", jobId: startData.jobId }, { holder });
      data = inspected.data as typeof data;
      if (data?.status.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(data?.status.status).toBe("failed");
    expect(data?.status.error?.length).toBeLessThan(hugeError.length);
    expect(data?.status.error).toContain("truncated");

    const stderrLog = readFileSync(path.join(startData.jobDir, "output", "stderr.log"), "utf8");
    expect(stderrLog).toBe(hugeError);
    rmSync(startData.jobDir, { recursive: true, force: true });
  });
});
