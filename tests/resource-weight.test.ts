/**
 * The concurrency bound counts CAPACITY, not jobs.
 *
 * `max_concurrent_runs` counted jobs, which priced an HTTP call to a local
 * endpoint the same as a whole Claude Code process. Four cheap endpoint calls
 * could therefore lock out a real dispatch, and raising the bound to allow
 * them also allowed four heavyweight CLIs — the thing the bound exists to
 * prevent, since a measured burst of 13 concurrent CLIs exhausted memory.
 *
 * These tests are about the ARITHMETIC of admission. The end-to-end queueing
 * behaviour is covered by job-concurrency.test.ts, which still passes with
 * every weight at its default.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-weight-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function routeFrom(body: string, name: string) {
  const file = path.join(dir, `${name}.yaml`);
  await fs.writeFile(file, body, "utf8");
  const cfg = await loadConfig(file, { whichFn: async () => null });
  return cfg;
}

describe("resource_weight config", () => {
  it("is honoured on a clis: entry", async () => {
    const cfg = await routeFrom(
      "clis:\n  - name: probe\n    harness: codex\n    resource_weight: 2.5\n",
      "cli",
    );
    expect(cfg.services.probe!.resourceWeight).toBe(2.5);
  });

  it("is honoured on an endpoints: entry", async () => {
    // The whole point of the shared route-field table: a setting added once
    // works on every shape. A weight read for CLIs and dropped for endpoints
    // would silently price every endpoint as heavy.
    const cfg = await routeFrom(
      "endpoints:\n  - name: probe\n    base_url: https://x.test/v1\n    model: m\n    resource_weight: 0.25\n",
      "ep",
    );
    expect(cfg.services.probe!.resourceWeight).toBe(0.25);
  });

  it("does not warn as an unrecognised key", async () => {
    // A key the parser reads but validation does not know about produces a
    // scary "IGNORED, and NOT in effect" warning for a setting that is very
    // much in effect.
    const cfg = await routeFrom(
      "clis:\n  - name: probe\n    harness: codex\n    resource_weight: 1\n",
      "warn",
    );
    const unknown = (cfg.configWarnings ?? []).filter((w) => w.includes("unknown key"));
    expect(unknown).toEqual([]);
  });

  it("is absent when not configured, so defaults apply at admission", async () => {
    const cfg = await routeFrom("clis:\n  - name: probe\n    harness: codex\n", "none");
    expect(cfg.services.probe!.resourceWeight).toBeUndefined();
  });
});

describe("admission arithmetic", () => {
  const cfg = {
    services: {
      heavy: { name: "heavy", type: "cli" },
      endpoint: { name: "endpoint", type: "openai_compatible" },
      pinned: { name: "pinned", type: "cli", resourceWeight: 0.5 },
    },
  } as unknown as import("../src/types.js").RouterConfig;

  const job = (over: Record<string, unknown> = {}) =>
    ({
      status: {
        jobId: "job-1700000000001-aaaaaaaa",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        jobDir: "/tmp/x",
        ...over,
      },
    }) as unknown as { status: import("../src/jobs/types.js").JobStatus };

  it("prices a CLI route as a whole process and an endpoint as a fraction", async () => {
    const { resourceWeightFor } = await import("../src/jobs.js");
    expect(resourceWeightFor(job({ route: "heavy" }).status, cfg)).toBe(1.0);
    expect(resourceWeightFor(job({ route: "endpoint" }).status, cfg)).toBe(0.1);
  });

  it("lets an explicit weight override the default", async () => {
    const { resourceWeightFor } = await import("../src/jobs.js");
    expect(resourceWeightFor(job({ route: "pinned" }).status, cfg)).toBe(0.5);
  });

  it("treats an unrouted job as heavy, not free", async () => {
    // A job with no forced service has no weight to look up yet. This bound
    // exists because 13 concurrent CLIs exhausted memory, so "might be
    // anything" has to cost as much as "might be a Claude Code process".
    // Guessing cheap here would let a burst through the guard.
    const { resourceWeightFor } = await import("../src/jobs.js");
    expect(resourceWeightFor(job().status, cfg)).toBe(1.0);
    expect(resourceWeightFor(job({ route: "not-in-config" }).status, cfg)).toBe(1.0);
  });

  it("sums capacity, so ten endpoint calls cost one CLI", async () => {
    const { activeCapacity } = await import("../src/jobs.js");
    const ten = Array.from({ length: 10 }, () => job({ route: "endpoint" }));
    expect(activeCapacity(ten, cfg)).toBeCloseTo(1.0, 5);
    expect(activeCapacity([job({ route: "heavy" })], cfg)).toBe(1.0);
  });

  it("is identical to the old job count when every weight is 1.0", async () => {
    // Backward compatibility is the point: an existing max_concurrent_runs
    // must keep meaning exactly what it meant before.
    const { activeCapacity } = await import("../src/jobs.js");
    const three = [job({ route: "heavy" }), job({ route: "heavy" }), job({ route: "heavy" })];
    expect(activeCapacity(three, cfg)).toBe(3);
  });

  it("ignores slot-queued and orphaned jobs, as the count did", async () => {
    const { activeCapacity } = await import("../src/jobs.js");
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(
      activeCapacity(
        [
          job({ route: "heavy", slotQueued: true }),
          job({ route: "heavy", updatedAt: stale }),
          job({ route: "heavy", status: "completed" }),
        ],
        cfg,
      ),
    ).toBe(0);
  });
});
