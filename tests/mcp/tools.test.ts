import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { invokeTool, TOOL_NAMES } from "../../src/mcp/tools.js";
import { z } from "zod";
import { publicHintsSchema } from "../../src/mcp/tool-schemas.js";
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
  lastOpts: { modelOverride?: string; timeoutMs?: number } | undefined;
  lastPrompt: string | undefined;
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
  async *stream(
    prompt?: string,
    _files?: string[],
    _workingDir?: string,
    opts?: { modelOverride?: string; timeoutMs?: number },
  ): AsyncIterable<DispatcherEvent> {
    this.lastPrompt = prompt;
    this.lastOpts = opts;
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

/**
 * A real directory to dispatch against.
 *
 * These tests used the literal workDir, which never existed on any
 * machine — fine while workingDir was unvalidated, and fictional the moment it
 * was. A caller passes a directory that exists; the fixture should too.
 */
let workDir: string;

beforeEach(() => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "harness-dispatch-jobs-"));
  workDir = mkdtempSync(path.join(tmpdir(), "harness-dispatch-work-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
});

describe("MCP tools — public surface", () => {
  it("exports the public dispatch, job_status, cancel_job, retry_job, workspace and usage tools", () => {
    // cancel_job joined the surface once the product could start a 60-minute
    // detached run with no way to stop it.
    expect(TOOL_NAMES).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
  });
});

describe("MCP tools — dispatch", () => {
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

    const r = await invokeTool("dispatch", { prompt: "hi", hints: { taskType: "plan" } }, { holder });
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
      "dispatch",
      { prompt: "hi", hints: { model: "preferred-model", taskType: "plan" } },
      { holder },
    );
    const data = r.data as { route: string; model?: string; routing?: { modelHintMatched?: boolean } };
    expect(data.route).toBe("b");
    expect(data.model).toBe("preferred-model");
    expect(data.routing?.modelHintMatched).toBe(true);
  });

  it("surfaces modelHintMatched: false when the requested model matches no configured route", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }) },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", hints: { model: "totally-unrecognized-model", taskType: "plan" } },
      { holder },
    );
    const data = r.data as { route: string; model?: string; routing?: { modelHintMatched?: boolean } };
    expect(data.route).toBe("a");
    // Forwarded blind, not silently dropped — matches the router.ts fix.
    expect(data.model).toBe("totally-unrecognized-model");
    expect(data.routing?.modelHintMatched).toBe(false);
  });

  it("surfaces modelHintDropped on the RESPONSE, not just the routing decision", async () => {
    // The whole point of the drop is that the route ran a DIFFERENT model
    // than the caller asked for. 0.7.8 computed it correctly in router.ts and
    // never copied it into the response builder, so no caller could ever see
    // it — while the tool schema had just been changed to promise the field.
    // The router-level test passed throughout, because it asserts one layer
    // below the one that was broken.
    //
    // Worse than absent: the field that WAS present, modelHintMatched: false,
    // is documented as "forwarded blind, treat with suspicion". It was not
    // forwarded at all.
    const holder = buildHolder(
      { a: makeService("a", { model: "a-real-model" }) },
      { a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }) },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", hints: { model: "a", taskType: "plan" } },
      { holder },
    );
    const data = r.data as {
      model?: string;
      routing?: { modelHintDropped?: boolean; modelHintMatched?: boolean };
    };
    expect(data.routing?.modelHintDropped, "the drop never reached the caller").toBe(true);
    expect(data.model, "the response must report the model that actually ran").toBe("a-real-model");
  });

  it("does not drop a model on the explicit `service` path, and says so either way", async () => {
    // The public `service` param takes a third code path (streamTo/routeTo,
    // reason: "explicit") that never had the route-id rule at all. It
    // forwarded a route id straight through as --model — the exact failure
    // the forced path was fixed for — and reported neither field, so the
    // schema text was true on one path and false on the parameter the docs
    // are written about.
    const holder = buildHolder(
      { a: makeService("a", { model: "a-real-model" }), b: makeService("b") },
      {
        a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
      },
    );

    // Names its own route: dropped, and reported.
    const selfNamed = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", hints: { model: "a", taskType: "plan" } },
      { holder },
    );
    const dropped = selfNamed.data as {
      model?: string;
      routing?: { reason?: string; modelHintDropped?: boolean };
    };
    expect(dropped.routing?.reason).toBe("explicit");
    expect(dropped.model, "a route id was sent to the harness as --model").toBe("a-real-model");
    expect(dropped.routing?.modelHintDropped).toBe(true);

    // Collides with a DIFFERENT route's id: still a real model request.
    const collides = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", hints: { model: "b", taskType: "plan" } },
      { holder },
    );
    const forwarded = collides.data as {
      model?: string;
      routing?: { modelHintDropped?: boolean };
    };
    expect(forwarded.model, "an explicitly requested model was swapped for the default").toBe("b");
    expect(forwarded.routing?.modelHintDropped).toBeFalsy();
  });

  it("rejects an empty hints.model instead of silently unsetting the route's own", async () => {
    // `??` does not catch "", so the empty string won against the configured
    // model: the route ran with no --model flag and reported model: "".
    // Nothing in the response said the request had been discarded.
    const holder = buildHolder(
      { a: makeService("a", { model: "a-real-model" }) },
      { a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }) },
    );

    await expect(
      invokeTool("dispatch", { prompt: "hi", hints: { model: "" } }, { holder }),
    ).rejects.toThrow(/must not be empty/i);

    // Whitespace does the same thing AND reaches the harness as a real
    // argument, so it cannot be waved through as "close enough to empty".
    await expect(
      invokeTool("dispatch", { prompt: "hi", hints: { model: "   " } }, { holder }),
    ).rejects.toThrow(/must not be empty/i);
  });

  it("rejects a whitespace-only prompt, like the HTTP surface always has", async () => {
    // parse.ts's header requires anything rejected there to be rejected the
    // same way here, and it answers 400 on `!prompt.trim()`. This passed
    // .min(1) and spent a real route call producing nothing — the exact waste
    // .min(1) was added to prevent, on the one required field.
    const holder = buildHolder(
      { a: makeService("a") },
      { a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }) },
    );
    await expect(
      invokeTool("dispatch", { prompt: "   ", workingDir: process.cwd() }, { holder }),
    ).rejects.toThrow(/prompt must not be empty/i);
  });

  it("still ADVERTISES the non-empty model rule, not just enforces it", () => {
    // A .refine alone emits a bare {"type":"string"}: enforcement gets
    // stronger while the advertised JSON Schema gets weaker, so a
    // schema-validating client stops catching "" locally and spends a round
    // trip on a -32602. Same "an agent following the schema burns a call"
    // cost as the phantom hints.service below, one layer down.
    const json = z.toJSONSchema(publicHintsSchema, { io: "input" }) as {
      properties?: { model?: { minLength?: number } };
    };
    expect(json.properties?.model?.minLength).toBe(1);
  });

  it("does not advertise a hints.service the strict schema rejects", () => {
    // The 0.7.8 correction to this description invented one: "when you ALSO
    // name a route (top-level `service`, or hints.service)". publicHintsSchema
    // has no such key and is .strict(), so an agent following the description
    // burns a call on a validation error. Same class as the field that was
    // promised but never serialized — a schema describing a surface it does
    // not have — just cheap instead of silent.
    const described = JSON.stringify(publicHintsSchema.shape.model.description ?? "");
    expect(described).not.toMatch(/hints\.service/);
    expect(() =>
      publicHintsSchema.parse({ service: "a" } as unknown as Record<string, unknown>),
    ).toThrow(/[Uu]nrecognized key/);
  });

  it("reports what the picked route beat, on the response and not just internally", async () => {
    // `reason` counted the candidates and never named them, so the one
    // question a caller has about an automatic choice — why that one — had no
    // answer. Measured over a month of real dispatches: 85% named a route
    // outright and the scoring ran on about one in seven. An unauditable
    // chooser does not get used.
    //
    // Asserted on the RESPONSE, not the decision, because the last field added
    // to this shape was computed correctly in the router and never copied
    // here, so no caller could see it.
    const holder = buildHolder(
      { a: makeService("a", { tier: 1 }), b: makeService("b", { tier: 1 }) },
      {
        a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
        b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
      },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", workingDir: process.cwd(), hints: { taskType: "execute" } },
      { holder },
    );
    const data = r.data as {
      route: string;
      routing?: { candidates?: Array<{ route: string; score: number }> };
    };
    const candidates = data.routing?.candidates;
    expect(candidates, "the comparison never reached the caller").toBeDefined();
    expect(candidates!.length).toBeGreaterThan(1);
    // Winner first, and it IS the route that ran.
    expect(candidates![0]!.route).toBe(data.route);
    // Sorted best-first, so "what it beat" reads top to bottom.
    for (let i = 1; i < candidates!.length; i += 1) {
      expect(candidates![i]!.score).toBeLessThanOrEqual(candidates![i - 1]!.score);
    }
  });

  it("omits the comparison when nothing was compared", async () => {
    // A forced route was not chosen over anything. Reporting a one-entry
    // "comparison" there would imply a decision that never happened.
    const holder = buildHolder(
      { a: makeService("a") },
      { a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }) },
    );
    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", workingDir: process.cwd(), service: "a" },
      { holder },
    );
    const data = r.data as { routing?: { reason?: string; candidates?: unknown } };
    expect(data.routing?.reason).toBe("explicit");
    expect(data.routing?.candidates).toBeUndefined();
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

    const r = await invokeTool("dispatch", { prompt: "hi", hints: { taskType: "plan" } }, { holder });
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
      "dispatch",
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
      "dispatch",
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
      "dispatch",
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

  it("rejects an unknown forced service at the boundary, without creating a job", async () => {
    // Fanout rejects unknown `models` by name; single mode let the same
    // mistake through, burned a job directory, and returned a success-shaped
    // completed:true / success:false the caller had to dig into.
    const holder = buildHolder(
      { a: makeService("a") },
      { a: new FakeDispatcher("a", { output: "A", service: "a", success: true }) },
    );
    const jobsDir = process.env.HARNESS_DISPATCH_JOBS_DIR!;

    await expect(
      invokeTool("dispatch", { prompt: "hi", service: "ghost", workingDir: workDir }, { holder }),
    ).rejects.toThrow(/Unknown service: ghost.*Valid route ids: a/s);

    const jobDirs = readdirSync(jobsDir).filter((e) => e.startsWith("job-"));
    expect(jobDirs).toEqual([]);
  });

  it("forwards contextJobs to every fanout arm", async () => {
    // Fanout used to drop contextJobs silently, so a chained fanout ("get two
    // opinions building on job A") ran every arm without the context and
    // never said so — the exact incomplete-picture failure contextJobs exists
    // to avoid. Single mode forwarded it; the arms must too.
    const jobsDir = process.env.HARNESS_DISPATCH_JOBS_DIR!;
    const prior = "job-1786977300001-0f0aaaaa";
    mkdirSync(path.join(jobsDir, prior, "output"), { recursive: true });
    writeFileSync(path.join(jobsDir, prior, "prompt.md"), "Design the schema", "utf8");
    writeFileSync(
      path.join(jobsDir, prior, "output", "result.json"),
      JSON.stringify({
        jobId: prior,
        result: { output: "CREATE TABLE users", success: true },
        decision: null,
      }),
      "utf8",
    );

    const fakeA = new FakeDispatcher("a", { output: "A", service: "a", success: true });
    const fakeB = new FakeDispatcher("b", { output: "B", service: "b", success: true });
    const holder = buildHolder(
      { a: makeService("a"), b: makeService("b") },
      { a: fakeA, b: fakeB },
    );

    await invokeTool(
      "dispatch",
      { mode: "fanout", prompt: "step 2", contextJobs: [prior], hints: { taskType: "plan" } },
      { holder },
    );

    expect(fakeA.lastPrompt).toContain("CREATE TABLE users");
    expect(fakeB.lastPrompt).toContain("CREATE TABLE users");
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

    // An error, not a completed:true with empty results — a refusal that
    // looks like success is exactly what an agent skimming for `completed`
    // misreads. The HTTP surface 400s the same input.
    await expect(
      invokeTool(
        "dispatch",
        {
          mode: "fanout",
          prompt: "edit files",
          hints: { safetyProfile: "workspace_edit" },
        },
        { holder },
      ),
    ).rejects.toThrow(/workspacePolicy=copy or workspacePolicy=git_worktree/);
  });

  it("allows explicit write-capable fanout with copy-isolated workspaces", async () => {
    const workingDir = mkdtempSync(path.join(tmpdir(), "harness-dispatch-fanout-copy-"));
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
      "dispatch",
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

    const r = await invokeTool("dispatch", { mode: "fanout", prompt: "hi" }, { holder });
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
      "dispatch",
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

    const r = await invokeTool("dispatch", { mode: "fanout", prompt: "hi", models: ["b-model"] }, { holder });
    const data = r.data as { results: Array<{ route: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.route).toBe("b");
  });

  it("ignores hints.model entirely in fanout mode — only top-level models: narrows candidates", async () => {
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

    // hints.model targets route "b" specifically, but no top-level `models`
    // is given — fanout must still hit every eligible route, not just "b".
    const r = await invokeTool(
      "dispatch",
      { mode: "fanout", prompt: "hi", hints: { model: "b-model" } },
      { holder },
    );
    const data = r.data as { results: Array<{ route: string }> };
    expect(data.results.map((item) => item.route).sort()).toEqual(["a", "b"]);
  });

  it("returns a full inline result with its jobId when the run beats the grace window", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "fast A", service: "a", success: true }) },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", workingDir: workDir },
      { holder },
    );
    const data = r.data as {
      mode: string;
      jobId: string;
      completed: boolean;
      success: boolean;
      output: string;
    };
    expect(data.mode).toBe("single");
    expect(data.completed).toBe(true);
    // Inline results still come from a real background job — the jobId keeps
    // pointing at the on-disk artifacts even after the inline reply.
    expect(data.jobId).toMatch(/^job-/);
    expect(data.success).toBe(true);
    expect(data.output).toBe("fast A");
  });

  it("returns a pollable jobId with graceSeconds: 0 and completes via polling", async () => {
    // A dispatcher slow enough to genuinely outlive a zero grace window —
    // an instant fake can finish before the post-grace disk read, in which
    // case dispatch correctly reports completed: true even at grace 0.
    const slow: Dispatcher = {
      id: "a",
      async dispatch(): Promise<DispatchResult> {
        return { output: "async A", service: "a", success: true };
      },
      async *stream(): AsyncIterable<DispatcherEvent> {
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield { type: "completion", result: { output: "async A", service: "a", success: true } };
      },
      async checkQuota(): Promise<QuotaInfo> {
        return { service: "a", source: "unknown" };
      },
      isAvailable: () => true,
    };
    const holder = buildHolder(
      {
        a: makeService("a", { leaderboardModel: "a-model" }),
      },
      { a: slow },
    );

    const started = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", graceSeconds: 0, workingDir: workDir },
      { holder },
    );
    const startData = started.data as {
      mode: string;
      jobId: string;
      completed: boolean;
      nextPollSeconds?: number;
      instructions?: string;
      warning?: string;
    };
    expect(startData.completed).toBe(false);
    expect(startData.jobId).toMatch(/^job-/);
    expect(startData.nextPollSeconds).toBeGreaterThan(0);
    expect(startData.instructions).toMatch(/job_status/);
    // workingDir was provided explicitly, so no defaulted-cwd warning.
    expect(startData.warning).toBeUndefined();

    let data: {
      completed: boolean;
      status: { status: string; jobDir: string };
      result?: { output: string };
    } | null = null;
    for (let i = 0; i < 100; i += 1) {
      const inspected = await invokeTool("job_status", { jobId: startData.jobId }, { holder });
      data = inspected.data as typeof data;
      // completed flips true as soon as result.json lands; the status file's
      // final "completed" write follows one step later — poll for the
      // terminal status too, or a slow runner observes the in-between state.
      if (data?.completed && data.status.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(data?.completed).toBe(true);
    expect(data?.status.status).toBe("completed");
    expect(data?.result?.output).toBe("async A");
    rmSync(data!.status.jobDir, { recursive: true, force: true });
  });

  it("rejects an incomplete dispatch call", async () => {
    const holder = buildHolder(
      { a: makeService("a") },
      { a: new FakeDispatcher("a") },
    );

    await expect(invokeTool("dispatch", {}, { holder })).rejects.toThrow(/prompt/);
    await expect(
      invokeTool("dispatch", { prompt: "hi", mode: "fanout", service: "a" }, { holder }),
    ).rejects.toThrow(/incompatible/);
  });

  it("gives every dispatch a 60-minute background timeout by default, not the dispatcher's short one", async () => {
    const dispatcher = new FakeDispatcher("a", { output: "async A", service: "a", success: true });
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: dispatcher },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", workingDir: workDir },
      { holder },
    );
    expect((r.data as { completed: boolean }).completed).toBe(true);
    expect(dispatcher.lastOpts?.timeoutMs).toBe(60 * 60 * 1000);
  });

  it("lets hints.timeoutMs override the 60-minute background default", async () => {
    const dispatcher = new FakeDispatcher("a", { output: "async A", service: "a", success: true });
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: dispatcher },
    );

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", workingDir: workDir, hints: { timeoutMs: 5_400_000 } },
      { holder },
    );
    expect((r.data as { completed: boolean }).completed).toBe(true);
    expect(dispatcher.lastOpts?.timeoutMs).toBe(5_400_000);
  });

  it("prunes job directories older than the retention window before starting a new one", async () => {
    const jobsDir = process.env.HARNESS_DISPATCH_JOBS_DIR!;
    const staleJobDir = path.join(jobsDir, "job-stale-0000000-aaaaaaaa");
    mkdirSync(staleJobDir, { recursive: true });
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(staleJobDir, staleTime, staleTime);

    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    vi.stubEnv("HARNESS_DISPATCH_JOB_MAX_AGE_MS", String(7 * 24 * 60 * 60 * 1000));
    try {
      // Default grace: the dispatch returns only after the background run
      // has fully landed, so nothing keeps writing after the test moves on.
      const r = await invokeTool(
        "dispatch",
        { prompt: "hi", service: "a", workingDir: workDir },
        { holder },
      );
      expect((r.data as { completed: boolean }).completed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
    }

    expect(existsSync(staleJobDir)).toBe(false);
  });

  it("treats a retention of 0 as keep-forever, not prune-everything", async () => {
    // The same config file establishes max_concurrent_runs: 0 as "disable the
    // bound"; reading retention 0 as "prune immediately" deleted RUNNING jobs
    // out from under their runners (a job dir's mtime only moves on a 15s
    // heartbeat, so at age 0 every beat gap was fatal).
    const jobsDir = process.env.HARNESS_DISPATCH_JOBS_DIR!;
    const oldJobDir = path.join(jobsDir, "job-old-0000000-bbbbbbbb");
    mkdirSync(oldJobDir, { recursive: true });
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldJobDir, staleTime, staleTime);

    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    vi.stubEnv("HARNESS_DISPATCH_JOB_MAX_AGE_MS", "0");
    try {
      await invokeTool("dispatch", { prompt: "hi", service: "a", workingDir: workDir }, { holder });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
    }

    expect(existsSync(oldJobDir)).toBe(true);
  });

  it("never prunes a running job with a fresh heartbeat, whatever retention says", async () => {
    const jobsDir = process.env.HARNESS_DISPATCH_JOBS_DIR!;
    const runningJobDir = path.join(jobsDir, "job-live-0000000-cccccccc");
    mkdirSync(runningJobDir, { recursive: true });
    writeFileSync(
      path.join(runningJobDir, "status.json"),
      JSON.stringify({
        jobId: "job-live-0000000-cccccccc",
        status: "running",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    // Age the DIRECTORY past any plausible retention; the fresh heartbeat in
    // status.json is what must save it.
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(runningJobDir, staleTime, staleTime);

    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    vi.stubEnv("HARNESS_DISPATCH_JOB_MAX_AGE_MS", "1000");
    try {
      await invokeTool("dispatch", { prompt: "hi", service: "a", workingDir: workDir }, { holder });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
    }

    expect(existsSync(runningJobDir)).toBe(true);
  });

  it("warns when workingDir is omitted and defaults to the router's own cwd", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "hi", service: "a", success: true }) },
    );

    const withoutWorkingDir = await invokeTool("dispatch", { prompt: "hi" }, { holder });
    const withoutData = withoutWorkingDir.data as { warning?: string };
    expect(withoutData.warning).toMatch(/workingDir was not provided/);

    const withWorkingDir = await invokeTool(
      "dispatch",
      { prompt: "hi", workingDir: workDir },
      { holder },
    );
    const withData = withWorkingDir.data as { warning?: string };
    expect(withData.warning).toBeUndefined();
  });

  it("plumbs hints.taskType and hints.model through to an explicit-service dispatch", async () => {
    const holder = buildHolder(
      {
        a: makeService("a", {
          leaderboardModel: "a-model",
          capabilities: { execute: 1.0, plan: 0.4, review: 1.0 },
        }),
      },
      { a: new FakeDispatcher("a", { output: "async A", service: "a", success: true }) },
    );

    const r = await invokeTool(
      "dispatch",
      {
        prompt: "hi",
        service: "a",
        workingDir: workDir,
        hints: { taskType: "plan", model: "explicit-override" },
      },
      { holder },
    );
    const data = r.data as {
      completed: boolean;
      model?: string;
      routing?: { taskType: string; capabilityScore: number };
    };
    expect(data.completed).toBe(true);
    // Before the fix, explicit-service dispatch always recorded taskType: ""
    // and svc.model, ignoring hints entirely.
    expect(data.routing?.taskType).toBe("plan");
    expect(data.model).toBe("explicit-override");
    expect(data.routing?.capabilityScore).toBeCloseTo(0.4, 10);
  });

  it("bounds a huge dispatcher error in the inline result but keeps the full text in stderr.log", async () => {
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

    const r = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", workingDir: workDir },
      { holder },
    );
    const data = r.data as { jobId: string; completed: boolean; success: boolean; error?: string };
    expect(data.completed).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error?.length).toBeLessThan(hugeError.length);
    expect(data.error).toContain("truncated");

    // The jobId from the inline reply still points at the full artifacts.
    const polled = await invokeTool("job_status", { jobId: data.jobId }, { holder });
    const polledData = polled.data as { status: { jobDir: string } };
    const stderrLog = readFileSync(
      path.join(polledData.status.jobDir, "output", "stderr.log"),
      "utf8",
    );
    expect(stderrLog).toBe(hugeError);
    rmSync(polledData.status.jobDir, { recursive: true, force: true });
  });
});

describe("MCP tools — job_status", () => {
  it("lists known background dispatches when jobId is omitted", async () => {
    const holder = buildHolder(
      { a: makeService("a", { leaderboardModel: "a-model" }) },
      { a: new FakeDispatcher("a", { output: "A", service: "a", success: true }) },
    );

    const started = await invokeTool(
      "dispatch",
      { prompt: "hi", service: "a", workingDir: workDir },
      { holder },
    );
    const startData = started.data as { jobId: string };

    const listed = await invokeTool("job_status", {}, { holder });
    const listData = listed.data as { jobs: Array<{ jobId: string }> };
    expect(listData.jobs.map((j) => j.jobId)).toContain(startData.jobId);
  });

  it("errors on an unknown jobId rather than returning a blank status", async () => {
    const holder = buildHolder({ a: makeService("a") }, { a: new FakeDispatcher("a") });
    await expect(invokeTool("job_status", { jobId: "job-does-not-exist" }, { holder })).rejects.toThrow();
  });
});

describe("MCP tools — usage listModels", () => {
  it("returns a declared models: list verbatim, with source: declared, and skips the network entirely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const holder = buildHolder(
      {
        nvidia: makeService("nvidia", {
          type: "openai_compatible",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "fake-key",
          models: ["qwen/qwen3-coder-480b-a35b-instruct", "moonshotai/kimi-k2-instruct"],
        }),
      },
      { nvidia: new FakeDispatcher("nvidia") },
    );

    const r = await invokeTool("usage", { listModels: "nvidia" }, { holder });
    const data = r.data as {
      liveModels: { route: string; models?: string[]; source?: string; error?: string };
    };

    expect(data.liveModels).toEqual({
      route: "nvidia",
      models: ["qwen/qwen3-coder-480b-a35b-instruct", "moonshotai/kimi-k2-instruct"],
      source: "declared",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("falls back to a live GET /models fetch when no models: list is declared, tagged source: live", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200,
      }),
    );
    const holder = buildHolder(
      {
        groq: makeService("groq", {
          type: "openai_compatible",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "fake-key",
        }),
      },
      { groq: new FakeDispatcher("groq") },
    );

    const r = await invokeTool("usage", { listModels: "groq" }, { holder });
    const data = r.data as {
      liveModels: { route: string; models?: string[]; source?: string; error?: string };
    };

    expect(data.liveModels).toEqual({
      route: "groq",
      models: ["model-a", "model-b"],
      source: "live",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer fake-key" } }),
    );
    fetchSpy.mockRestore();
  });

  it("errors cleanly for a CLI harness route (no models: declared, not an endpoint)", async () => {
    const holder = buildHolder(
      { claude: makeService("claude", { type: "cli" }) },
      { claude: new FakeDispatcher("claude") },
    );
    const r = await invokeTool("usage", { listModels: "claude" }, { holder });
    const data = r.data as { liveModels: { route: string; error?: string } };
    expect(data.liveModels.error).toMatch(/openai_compatible|models: list/);
  });

  it("errors cleanly for an unknown route id instead of throwing", async () => {
    const holder = buildHolder({}, {});
    const r = await invokeTool("usage", { listModels: "does_not_exist" }, { holder });
    const data = r.data as { liveModels: { route: string; error?: string } };
    expect(data.liveModels.error).toContain("unknown route");
  });

  it("appends /v1 before /models for a baseUrl that doesn't already end in /v1, matching the dispatcher", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 }),
    );
    const holder = buildHolder(
      {
        gateway: makeService("gateway", {
          type: "openai_compatible",
          baseUrl: "https://gateway.example.com",
          apiKey: "fake-key",
        }),
      },
      { gateway: new FakeDispatcher("gateway") },
    );

    await invokeTool("usage", { listModels: "gateway" }, { holder });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/models",
      expect.anything(),
    );
    fetchSpy.mockRestore();
  });
});
