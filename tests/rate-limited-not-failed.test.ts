/**
 * A rate-limited call is UNAVAILABILITY, not failure.
 *
 * The difference is not cosmetic. `usage` is what an orchestrating agent is
 * told to consult before delegating, and these counts persist to
 * quota_state.json across restarts. Filing a busy route under `failed` leaves
 * a standing record that it is unreliable, so the agent routes away from a
 * route that was never broken.
 *
 * That loop is documented from a sibling system's post-mortem: a tool whose
 * dependency was merely unavailable recorded generic failures, its own
 * reflection read the tally, and it stopped being called at all — 0 uses in
 * 4.4 days against a 37% "error" rate that was really downtime.
 *
 * The circuit breaker already handles the ROUTING consequence of a rate limit
 * correctly and separately. This is only about what the numbers say.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaCache } from "../src/quota.js";
import type { DispatchResult } from "../src/types.js";

/** Minimal dispatcher map: QuotaCache keys its status off this. */
const stubDispatchers = { codex_cli: { isAvailable: () => true } } as never;
const cache = (): QuotaCache => new QuotaCache(stubDispatchers);

async function counts(q: QuotaCache) {
  return (await q.fullStatus())["codex_cli"]!;
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-rlcount-"));
  vi.stubEnv("HARNESS_DISPATCH_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const ok = (): DispatchResult => ({ output: "done", success: true }) as DispatchResult;
const busy = (): DispatchResult =>
  ({ output: "", success: false, rateLimited: true, error: "429 rate limit" }) as DispatchResult;
const broken = (): DispatchResult =>
  ({ output: "", success: false, error: "ENOENT" }) as DispatchResult;

describe("rate-limited results are counted apart from failures", () => {
  it("does not count a rate-limited call as a failure", async () => {
    const q = cache();
    q.recordResult("codex_cli", busy());
    const s = await counts(q);
    expect(s.localFailureCount).toBe(0);
    expect(s.localRateLimitedCount).toBe(1);
  });

  it("still counts it as a call, since it did happen", async () => {
    const q = cache();
    q.recordResult("codex_cli", busy());
    expect((await counts(q)).localCallCount).toBe(1);
    expect((await counts(q)).localSuccessCount).toBe(0);
  });

  it("still counts a genuine failure as a failure", async () => {
    // The distinction must not swallow real breakage.
    const q = cache();
    q.recordResult("codex_cli", broken());
    const s = await counts(q);
    expect(s.localFailureCount).toBe(1);
    expect(s.localRateLimitedCount).toBe(0);
  });

  it("keeps a heavily rate-limited route's failure tally at zero", async () => {
    // The shape of the post-mortem: a route that is busy a lot must not end up
    // looking broken to whatever reads these numbers.
    const q = cache();
    for (let i = 0; i < 20; i += 1) q.recordResult("codex_cli", busy());
    for (let i = 0; i < 5; i += 1) q.recordResult("codex_cli", ok());
    const s = await counts(q);
    expect(s.localFailureCount).toBe(0);
    expect(s.localRateLimitedCount).toBe(20);
    expect(s.localSuccessCount).toBe(5);
    expect(s.localCallCount).toBe(25);
  });

  it("persists the distinction across restarts", async () => {
    // These counts outlive the process, so a conflated tally would be a
    // permanent misjudgement rather than a transient one.
    const first = cache();
    first.recordResult("codex_cli", busy());
    first.recordResult("codex_cli", broken());

    const second = cache();
    const s = await counts(second);
    expect(s.localRateLimitedCount).toBe(1);
    expect(s.localFailureCount).toBe(1);
  });

  it("reads state written before this field existed without inventing counts", async () => {
    await fs.writeFile(
      path.join(stateDir, "quota_state.json"),
      JSON.stringify({ codex_cli: { local_calls: 9, local_success: 4, local_failure: 5 } }),
      "utf8",
    );
    const s = await counts(cache());
    // Old failures stay failures — they cannot be re-classified retroactively,
    // and guessing would rewrite history.
    expect(s.localFailureCount).toBe(5);
    expect(s.localRateLimitedCount).toBe(0);
  });
});
