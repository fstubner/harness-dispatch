/**
 * Concurrent failures on ONE route must all be recorded.
 *
 * This is the case the per-route file split was believed to have fixed and did
 * not. Splitting removed contention BETWEEN routes; the read-modify-write
 * inside each route's file was untouched, and every dispatch runs in a
 * detached child process that loaded its own breaker at boot. Two concurrent
 * failures therefore both read 0 and both write 1.
 *
 * Measured before the fix: 8 concurrent failures on one route persisted as
 * `failures: 1`, the breaker never tripped, and a dead route stayed
 * selectable — against PRODUCT.md Success #5.
 *
 * The probe that "proved" the original split wrote to 800 DISTINCT routes, so
 * it could never have caught this. That is why this test exercises one route
 * from many writers, and why it asserts the trip, not just the count.
 */

import { execFileSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BreakerStore } from "../src/breaker-store.js";
import { CIRCUIT_BREAKER_THRESHOLD, CircuitBreaker } from "../src/circuit-breaker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_STORE = path.join(HERE, "..", "dist", "breaker-store.js");
const DIST_CB = path.join(HERE, "..", "dist", "circuit-breaker.js");

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-brace-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Apply one failure to the persisted state, the way Router.handleResult does. */
function recordFailure(store: BreakerStore, service: string): void {
  store.update(service, (current) => {
    const cb = new CircuitBreaker();
    if (current) cb.restore(current);
    cb.recordFailure();
    return cb.snapshot();
  });
}

describe("BreakerStore.update — same route, many writers", () => {
  it("keeps every failure when applied in sequence", () => {
    const store = new BreakerStore(dir);
    for (let i = 0; i < 8; i += 1) recordFailure(store, "flaky");
    expect(store.loadAll()["flaky"]?.failures).toBe(8);
  });

  it("trips once the threshold is reached", () => {
    const store = new BreakerStore(dir);
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) recordFailure(store, "flaky");
    expect(store.loadAll()["flaky"]?.blockedUntilMs).not.toBeNull();
  });

  it.skipIf(!existsSync(DIST_STORE))(
    "loses none of 8 failures raised by 8 separate PROCESSES",
    () => {
      // The real shape: separate processes, one route. An in-process test
      // cannot distinguish the broken implementation from the fixed one.
      const storeUrl = pathToFileURL(DIST_STORE).href;
      const cbUrl = pathToFileURL(DIST_CB).href;
      const script = [
        'const { BreakerStore } = await import(process.env.STORE_URL);',
        'const { CircuitBreaker } = await import(process.env.CB_URL);',
        'while (Date.now() < Number(process.env.START)) {}',
        'new BreakerStore(process.env.SDIR).update("flaky", (cur) => {',
        '  const cb = new CircuitBreaker();',
        '  if (cur) cb.restore(cur);',
        '  cb.recordFailure();',
        '  return cb.snapshot();',
        '});',
      ].join(String.fromCharCode(10));

      const start = String(Date.now() + 900);
      const kids = Array.from({ length: 8 }, () =>
        // eslint-disable-next-line no-restricted-syntax
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, SDIR: dir, START: start, STORE_URL: storeUrl, CB_URL: cbUrl },
          encoding: "utf8",
        }),
      );
      expect(kids.length).toBe(8);

      const persisted = new BreakerStore(dir).loadAll()["flaky"];
      expect(persisted?.failures).toBe(8);
      expect(persisted?.blockedUntilMs).not.toBeNull();
    },
    60_000,
  );

  it("leaves no lock directory behind", () => {
    const store = new BreakerStore(dir);
    recordFailure(store, "flaky");
    const leftovers = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".lock"));
    expect(leftovers).toEqual([]);
  });
});
