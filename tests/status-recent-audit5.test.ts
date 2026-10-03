/**
 * What status and usage say about a route's RECENT record, since when its
 * counters run, which config a log row came from, and cleaning up saved state
 * for routes a config does not name.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/bin.js";
import { BreakerStore } from "../src/breaker-store.js";
import { loadConfig } from "../src/config.js";
import { dispatchLogPath, logDispatch, recentOutcomes } from "../src/dispatch-log.js";
import { QuotaCache } from "../src/quota.js";
import { Router } from "../src/router.js";
import { buildStatus, buildUsage, renderStatusText, renderUsageText } from "../src/status.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type { DispatcherEvent, DispatchResult, QuotaInfo, ServiceConfig } from "../src/types.js";

let dir: string;
let prevLog: string | undefined;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hr-a5-status-"));
  prevLog = process.env.HARNESS_DISPATCH_LOG_DIR;
  prevState = process.env.HARNESS_DISPATCH_STATE_DIR;
  prevConfig = process.env.HARNESS_DISPATCH_CONFIG;
  process.env.HARNESS_DISPATCH_LOG_DIR = path.join(dir, "logs");
  process.env.HARNESS_DISPATCH_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  for (const [k, v] of [
    ["HARNESS_DISPATCH_LOG_DIR", prevLog],
    ["HARNESS_DISPATCH_STATE_DIR", prevState],
    ["HARNESS_DISPATCH_CONFIG", prevConfig],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const ok = (id: string): DispatchResult => ({ output: "ok", service: id, success: true });
const fail = (id: string): DispatchResult => ({ output: "", service: id, success: false, error: "boom" });
const limited = (id: string): DispatchResult => ({
  output: "", service: id, success: false, rateLimited: true,
});

function svc(name: string): ServiceConfig {
  return {
    name, enabled: true, type: "cli", harness: name, command: name,
    tier: 1, weight: 1, cliCapability: 1,
    capabilities: { execute: 1, plan: 1, review: 1 }, escalateOn: [],
    provider: "local", surface: "local_endpoint", authSource: "local_network",
    billingKind: "local_compute", paidUsagePossible: false, billingConfidence: "documented",
  };
}

class Fake implements Dispatcher {
  readonly id: string;
  constructor(id: string, private readonly result: DispatchResult) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.result;
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: this.result };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

function logRows(route: string, results: DispatchResult[]): void {
  for (const r of results) logDispatch(route, r);
}

describe("recentOutcomes — the dispatch log over the last 7 days", () => {
  it("counts attempts, successes and rate limits, and ignores old and refused rows", () => {
    logRows("r", [ok("r"), ok("r"), ok("r"), fail("r"), limited("r"), limited("r")]);
    logDispatch("r", { ...fail("r"), inputRejected: true });
    // A row from 10 days ago, written as the log would have.
    appendFileSync(
      dispatchLogPath(),
      JSON.stringify({ ts: new Date(Date.now() - 10 * 86_400_000).toISOString(), route: "r", success: true }) + "\n",
    );
    expect(recentOutcomes()["r"]).toEqual({ attempts: 6, successes: 3, rateLimited: 2 });
  });

  it("is an empty answer when there is no log", () => {
    expect(recentOutcomes()).toEqual({});
  });

  it("reads the archive too, when the live file does not reach back far enough", () => {
    const file = dispatchLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(`${file}.1`, JSON.stringify({ ts: now, route: "r", success: true }) + "\n");
    logRows("r", [fail("r")]); // live file starts inside the window
    expect(recentOutcomes()["r"]).toEqual({ attempts: 2, successes: 1, rateLimited: 0 });
  });
});

describe("status and usage show the recent record", () => {
  it("per route, as numbers and as one line", async () => {
    logRows("r", [ok("r"), ok("r"), ok("r"), fail("r"), limited("r"), limited("r")]);
    const dispatchers = { r: new Fake("r", ok("r")) };
    const quota = new QuotaCache(dispatchers, { stateFile: path.join(dir, "q.json") });
    const config = { services: { r: svc("r") } };
    const router = new Router(config, quota, dispatchers, new BreakerStore(path.join(dir, "b")));
    const status = await buildStatus(config, dispatchers, quota, router);
    expect(status.routes[0]!.recent).toEqual({
      days: 7, attempts: 6, successes: 3, rateLimited: 2, successRatePercent: 50,
    });
    const usage = buildUsage(status);
    expect(usage.routes[0]!.recent?.successRatePercent).toBe(50);
    expect(renderUsageText(usage)).toContain("last 7d: 3/6 succeeded (50%), 2 rate-limited");
    expect(renderStatusText(status)).toContain("last 7d: 3/6 succeeded (50%), 2 rate-limited");
  });

  it("says nothing for a route that was not tried", async () => {
    const dispatchers = { r: new Fake("r", ok("r")) };
    const quota = new QuotaCache(dispatchers, { stateFile: path.join(dir, "q.json") });
    const config = { services: { r: svc("r") } };
    const router = new Router(config, quota, dispatchers, new BreakerStore(path.join(dir, "b")));
    const status = await buildStatus(config, dispatchers, quota, router);
    expect(status.routes[0]!.recent).toBeUndefined();
    expect(renderUsageText(buildUsage(status))).not.toContain("last 7d");
  });
});

describe("usage counters say since when", () => {
  it("stamps counters at their first write, and never invents a start for older ones", async () => {
    const stateFile = path.join(dir, "quota_state.json");
    const dispatchers = { fresh: new Fake("fresh", ok("fresh")), old: new Fake("old", ok("old")) };
    // `old` has counts from before the stamp existed.
    writeFileSync(stateFile, JSON.stringify({ old: { local_calls: 40, local_success: 30 } }));
    const quota = new QuotaCache(dispatchers, { stateFile });
    const before = Date.now();
    quota.recordResult("fresh", ok("fresh"));
    quota.recordResult("old", ok("old"));

    const status = await quota.fullStatus();
    expect(Date.parse(status["fresh"]!.localSince!)).toBeGreaterThanOrEqual(before - 1000);
    expect(status["old"]!.localSince, "an unknown start was given today's date").toBeUndefined();
    expect(status["old"]!.localCallCount).toBe(41);
  });

  it("is shown in usage text", async () => {
    const stateFile = path.join(dir, "q.json");
    const dispatchers = { r: new Fake("r", ok("r")) };
    const quota = new QuotaCache(dispatchers, { stateFile });
    quota.recordResult("r", ok("r"));
    const config = { services: { r: svc("r") } };
    const router = new Router(config, quota, dispatchers, new BreakerStore(path.join(dir, "b")));
    const text = renderUsageText(buildUsage(await buildStatus(config, dispatchers, quota, router)));
    expect(text).toMatch(/calls=1 success=1 failed=0 since=\d{4}-\d{2}-\d{2}/);
  });
});

describe("a log row records which config was in use", () => {
  it("carries the config path, so a demo run can be told from real use", async () => {
    const file = path.join(dir, "demo.yaml");
    writeFileSync(file, "clis: []\n");
    const loaded = await loadConfig(file, { whichFn: async () => null });
    expect(loaded.configPath).toBe(path.resolve(file));

    const dispatchers = { r: new Fake("r", ok("r")) };
    const config = { services: { r: svc("r") }, configPath: path.resolve(file) };
    const router = new Router(config, new QuotaCache(dispatchers, { stateFile: path.join(dir, "q.json") }), dispatchers, new BreakerStore(path.join(dir, "b")));
    await router.routeTo("r", "go", [], "/tmp");
    const rows = readFileSync(dispatchLogPath(), "utf8").trim().split("\n");
    expect(JSON.parse(rows[rows.length - 1]!).config).toBe(path.resolve(file));
  });

  it("is absent when no config file was loaded", async () => {
    const dispatchers = { r: new Fake("r", ok("r")) };
    const config = { services: { r: svc("r") } };
    const router = new Router(config, new QuotaCache(dispatchers, { stateFile: path.join(dir, "q.json") }), dispatchers, new BreakerStore(path.join(dir, "b")));
    await router.routeTo("r", "go", [], "/tmp");
    const rows = readFileSync(dispatchLogPath(), "utf8").trim().split("\n");
    expect(JSON.parse(rows[rows.length - 1]!)).not.toHaveProperty("config");
  });
});

describe("saved state for routes a config does not name", () => {
  it("is reported by doctor, and removed only with --prune-state", async () => {
    const cfg = path.join(dir, "config.yaml");
    writeFileSync(cfg, "clis:\n  - name: mine\n    harness: codex\n");
    // Leftovers of a demo config, plus the real route's own state.
    const breakers = new BreakerStore();
    const trip = () => ({ failures: 5, blockedUntilMs: Date.now() + 60_000, lastFailureAtMs: Date.now() });
    breakers.update("demo_route", trip);
    breakers.update("mine", trip);
    const stateFile = path.join(dir, "state", "quota_state.json");
    writeFileSync(stateFile, JSON.stringify({ demo_route: { local_calls: 3 }, mine: { local_calls: 2 } }));

    const doctor = async (...flags: string[]) => {
      const chunks: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: unknown }).write = (c: string) => {
        chunks.push(String(c));
        return true;
      };
      try {
        await main(["doctor", "--json", "--config", cfg, ...flags]);
      } finally {
        (process.stdout as unknown as { write: unknown }).write = orig;
      }
      const payload = JSON.parse(chunks.join("")) as { checks: Array<{ name: string; detail: string }> };
      return payload.checks.find((c) => c.name === "saved-routes")!.detail;
    };

    const reported = await doctor();
    expect(reported).toContain("demo_route");
    expect(reported).not.toMatch(/\bmine\b/);
    expect(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")))).toContain("demo_route");

    const pruned = await doctor("--prune-state");
    expect(pruned).toContain("removed saved state");
    expect(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")))).toEqual(["mine"]);
    expect(Object.keys(new BreakerStore().loadAll())).toEqual(["mine"]);
  });
});
