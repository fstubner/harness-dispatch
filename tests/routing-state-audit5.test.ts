/**
 * Routing-state defects from the fourth audit's A4 verification (A4-1..A4-12),
 * still open at the fifth. Real Router / BreakerStore / QuotaCache, no mocks;
 * a second instance on the same directory stands for another process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { BreakerStore } from "../src/breaker-store.js";
import { QuotaCache } from "../src/quota.js";
import { Router } from "../src/router.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type {
  DispatcherEvent,
  DispatchResult,
  QuotaInfo,
  ServiceConfig,
} from "../src/types.js";

class Fake implements Dispatcher {
  readonly id: string;
  calls = 0;
  lastTimeoutMs: number | undefined;
  constructor(
    id: string,
    public result: DispatchResult,
    private readonly delayMs = 0,
  ) {
    this.id = id;
  }
  private async run(opts?: { timeoutMs?: number }): Promise<DispatchResult> {
    this.calls += 1;
    this.lastTimeoutMs = opts?.timeoutMs;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.result;
  }
  async dispatch(_p: string, _f: string[], _w: string, opts?: { timeoutMs?: number }): Promise<DispatchResult> {
    return this.run(opts);
  }
  async *stream(_p: string, _f: string[], _w: string, opts?: { timeoutMs?: number }): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: await this.run(opts) };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

const ok = (id: string): DispatchResult => ({ output: "ok", service: id, success: true });
const fail = (id: string): DispatchResult => ({ output: "", service: id, success: false, error: "boom" });

function svc(name: string, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name, enabled: true, type: "cli", harness: name, command: name,
    tier: 1, weight: 1, cliCapability: 1,
    capabilities: { execute: 1, plan: 1, review: 1 }, escalateOn: [],
    provider: "local", surface: "local_endpoint", authSource: "local_network",
    billingKind: "local_compute", paidUsagePossible: false, billingConfidence: "documented",
    ...over,
  };
}

let dir: string;
let breakerDir: string;
let quotaFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hr-a5-routing-"));
  breakerDir = path.join(dir, "breaker_state");
  quotaFile = path.join(dir, "quota_state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function build(
  services: Record<string, ServiceConfig>,
  dispatchers: Record<string, Dispatcher>,
  store: BreakerStore = new BreakerStore(breakerDir),
): Router {
  return new Router(
    { services },
    new QuotaCache(dispatchers, { stateFile: quotaFile }),
    dispatchers,
    store,
  );
}

describe("A4-2: an explicit service reads other processes' breaker state", () => {
  it("runs a route another process healed", async () => {
    const d = { flaky: new Fake("flaky", ok("flaky")) };
    const services = { flaky: svc("flaky") };
    const server = build(services, d);
    // Another process trips it; this one learns of it.
    new BreakerStore(breakerDir).update("flaky", () => ({
      failures: 5, blockedUntilMs: Date.now() + 300_000, lastFailureAtMs: Date.now(),
    }));
    expect((await server.routeTo("flaky", "go", [], "/tmp")).result.error).toMatch(/circuit-broken/);
    // ...and another process heals it.
    new BreakerStore(breakerDir).update("flaky", () => ({ failures: 0, blockedUntilMs: null, lastFailureAtMs: null }));
    const { result } = await server.routeTo("flaky", "go", [], "/tmp");
    expect(result.success, result.error).toBe(true);
  });

  it("refuses a route another process tripped since this one last looked", async () => {
    const d = { flaky: new Fake("flaky", ok("flaky")) };
    const server = build({ flaky: svc("flaky") }, d);
    new BreakerStore(breakerDir).update("flaky", () => ({
      failures: 5, blockedUntilMs: Date.now() + 300_000, lastFailureAtMs: Date.now(),
    }));
    const { result } = await server.routeTo("flaky", "go", [], "/tmp");
    expect(result.error).toMatch(/circuit-broken/);
    expect(d.flaky.calls).toBe(0);
  });
});

describe("A4-3: never_succeeded does not outlive a success in another process", () => {
  it("scores a route again once another process has recorded a success", async () => {
    const d = { box: new Fake("box", ok("box")) };
    const services = { box: svc("box") };
    const router = build(services, d);
    const q = new QuotaCache(d, { stateFile: quotaFile });
    const dead: DispatchResult = fail("box");
    for (let i = 0; i < 6; i++) router["quota"].recordResult("box", dead);
    expect(await router.pickService({ hints: { taskType: "execute" } })).toBeNull();

    // Another runner's success lands on disk.
    q.recordResult("box", ok("box"));
    const decision = await router.pickService({ hints: { taskType: "execute" } });
    expect(decision?.service, "a repaired route stayed skipped as never_succeeded").toBe("box");
  });
});

describe("A4-4: a breaker write error clears once a write works again", () => {
  it("does not stay set after the directory is fixed and the route is healthy", async () => {
    const notADir = path.join(dir, "blocker");
    writeFileSync(notADir, "x");
    const store = new BreakerStore(path.join(notADir, "breaker_state"));
    const d = { a: new Fake("a", fail("a")) };
    const router = build({ a: svc("a") }, d, store);
    await router.routeTo("a", "go", [], "/tmp");
    expect(router.breakerWriteError()).toMatch(/cannot create/);

    // Fixed: the blocker is replaced by a directory, and the route recovers.
    rmSync(notADir);
    mkdirSync(notADir);
    d.a.result = ok("a");
    await router.routeTo("a", "go", [], "/tmp");
    await router.routeTo("a", "go", [], "/tmp");
    expect(router.breakerWriteError()).toBeUndefined();
  });
});

describe("A4-5: a fallback is not started on a spent whole-call budget", () => {
  async function completions(router: Router, budgetMs: number): Promise<DispatchResult[]> {
    const out: DispatchResult[] = [];
    for await (const { event } of router.stream("go", [], "/tmp", {
      hints: { taskType: "execute" },
      defaultTimeoutMs: budgetMs,
    })) {
      if (event.type === "completion") out.push(event.result);
    }
    return out;
  }

  it("makes no fallback attempt when under a second of the budget is left", async () => {
    const services = { first: svc("first"), second: svc("second", { tier: 2 }) };
    const d = { first: new Fake("first", fail("first"), 400), second: new Fake("second", ok("second")) };
    const results = await completions(build(services, d), 1_200); // ~800 ms left
    expect(results.map((r) => r.service)).toEqual(["first"]);
    expect(d.second.calls, "a fallback was started on a sliver of budget").toBe(0);
  });

  it("still falls back, with the remaining time, when there is enough", async () => {
    const services = { first: svc("first"), second: svc("second", { tier: 2 }) };
    const d = { first: new Fake("first", fail("first"), 50), second: new Fake("second", ok("second")) };
    const results = await completions(build(services, d), 5_000);
    expect(results.map((r) => r.service)).toEqual(["first", "second"]);
    expect(d.second.lastTimeoutMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe("A4-7: an unwritable state directory still trips the breaker", () => {
  it("trips after five failures in a row even though nothing can be saved", async () => {
    const notADir = path.join(dir, "blocker");
    writeFileSync(notADir, "x");
    const store = new BreakerStore(path.join(notADir, "breaker_state"));
    const d = { a: new Fake("a", fail("a")) };
    const router = build({ a: svc("a") }, d, store);
    for (let i = 0; i < 8; i++) await router.routeTo("a", "go", [], "/tmp");
    expect(router.getBreaker("a")!.status().tripped, "eight failures never tripped it").toBe(true);
    expect(d.a.calls).toBeLessThan(8);
  });
});

describe("A4-9: no 'model hint not sent' note when the hint was a route id", () => {
  it("leaves the fallback reason alone", async () => {
    const services = { flaky: svc("flaky"), backup: svc("backup", { tier: 2 }) };
    const d = { flaky: new Fake("flaky", fail("flaky")), backup: new Fake("backup", ok("backup")) };
    const router = build(services, d);
    const { decision } = await router.route("go", [], "/tmp", {
      hints: { taskType: "execute", model: "flaky" },
    });
    expect(decision?.service).toBe("backup");
    expect(decision?.reason).toContain("fallback #1");
    expect(decision?.reason).not.toContain("model hint not sent");
  });
});

describe("A4-10: a trip whose record went unreadable and was then deleted is re-closed", () => {
  it("heals when the record disappears after a torn read", async () => {
    const d = { x: new Fake("x", ok("x")), y: new Fake("y", ok("y")) };
    const services = { x: svc("x"), y: svc("y", { tier: 2 }) };
    const server = build(services, d);
    const store = new BreakerStore(breakerDir);
    store.update("x", () => ({ failures: 5, blockedUntilMs: Date.now() + 300_000, lastFailureAtMs: Date.now() }));
    expect((await server.pickService({ hints: { taskType: "execute" } }))?.service).toBe("y");

    const file = readdirSync(breakerDir).find((f) => f.startsWith("x"))!;
    writeFileSync(path.join(breakerDir, file), "{"); // torn
    expect((await server.pickService({ hints: { taskType: "execute" } }))?.service).toBe("y");
    rmSync(path.join(breakerDir, file));
    expect((await server.pickService({ hints: { taskType: "execute" } }))?.service).toBe("x");
  });
});

describe("A4-11: a damaged per-route entry does not stop usage counting", () => {
  it("counts the route and every other one", async () => {
    writeFileSync(quotaFile, JSON.stringify({ a: 12 }));
    const d = { a: new Fake("a", ok("a")), b: new Fake("b", ok("b")) };
    const router = build({ a: svc("a"), b: svc("b", { tier: 2 }) }, d);
    await router.routeTo("a", "go", [], "/tmp");
    await router.routeTo("b", "go", [], "/tmp");
    const onDisk = JSON.parse(readFileSync(quotaFile, "utf8")) as Record<string, { local_calls?: number }>;
    expect(onDisk["a"]?.local_calls).toBe(1);
    expect(onDisk["b"]?.local_calls).toBe(1);
  });
});

describe("A4-1: a healthy record that cannot be removed is reported", () => {
  it("sets the write error instead of swallowing it", () => {
    const store = new BreakerStore(breakerDir);
    store.update("x", () => ({ failures: 5, blockedUntilMs: Date.now() + 300_000, lastFailureAtMs: Date.now() }));
    const file = path.join(breakerDir, readdirSync(breakerDir).find((f) => f.startsWith("x"))!);
    // A directory where the record should be: rmSync(force) on it throws.
    rmSync(file);
    mkdirSync(file);
    writeFileSync(path.join(file, "keep"), "x");
    store.save("x", { failures: 0, blockedUntilMs: null, lastFailureAtMs: null });
    expect(store.lastWriteError()).toMatch(/cannot clear/);
  });
});

describe("A4-12: a dispatcher stream that throws does not leak its isolated workspace", () => {
  const execFile = promisify(execFileCb);
  const git = (cwd: string, args: string[]) => execFile("git", args, { cwd, windowsHide: true });

  class Throwing extends Fake {
    override async *stream(): AsyncIterable<DispatcherEvent> {
      yield { type: "stdout", chunk: "partial" };
      throw new Error("dispatcher exploded");
    }
  }

  it("removes the untouched git worktree", async () => {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    const wsHome = path.join(dir, "ws-home");
    const original = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = wsHome;
    try {
      const d = { t: new Throwing("t", ok("t")) };
      const router = build({ t: svc("t") }, d);
      await expect(
        (async () => {
          for await (const _ of router.streamTo("t", "go", [], repo, {
            safetyProfile: "workspace_edit",
            workspacePolicy: "git_worktree",
          })) {
            void _;
          }
        })(),
      ).rejects.toThrow("dispatcher exploded");
      const { stdout } = await git(repo, ["worktree", "list", "--porcelain"]);
      expect(
        String(stdout).split("\n").filter((l) => l.startsWith("worktree ")).length,
        "the isolated worktree was left registered",
      ).toBe(1);
    } finally {
      if (original === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = original;
    }
  });
});
