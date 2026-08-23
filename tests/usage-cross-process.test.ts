/**
 * `usage` must report work done by detached children of THIS process.
 *
 * Dispatches run in detached child processes. Each child records its result
 * and persists the counters, but the server's own QuotaCache loaded them at
 * boot and never looked again — so `usage` inside the process that started the
 * work reported calls=0 while the disk held calls=3. The numbers only appeared
 * to a LATER process.
 *
 * That is the opposite of useful: ux-walkthrough Flow 4 step 2 tells a user to
 * run `usage` when spend looks unexpected, and on the primary surface it
 * answered zero.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaCache } from "../src/quota.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-usagex-"));
  vi.stubEnv("HARNESS_DISPATCH_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const dispatchers = { fake: { isAvailable: () => true } } as never;

/** Stand in for a detached child: write counters straight to the state file. */
async function writeCountsAsAnotherProcess(counts: {
  calls: number;
  success: number;
  failure?: number;
  rateLimited?: number;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  await fs.writeFile(
    path.join(stateDir, "quota_state.json"),
    JSON.stringify({
      fake: {
        local_calls: counts.calls,
        local_success: counts.success,
        local_failure: counts.failure ?? 0,
        local_rate_limited: counts.rateLimited ?? 0,
        local_input_tokens: counts.inputTokens ?? 0,
        local_output_tokens: counts.outputTokens ?? 0,
      },
    }),
    "utf8",
  );
}

describe("QuotaCache reports counts written by other processes", () => {
  it("picks up work recorded after this cache was constructed", async () => {
    const quota = new QuotaCache(dispatchers); // boots with nothing on disk
    await writeCountsAsAnotherProcess({ calls: 3, success: 3 });

    const status = (await quota.fullStatus())["fake"]!;
    expect(status.localCallCount).toBe(3);
    expect(status.localSuccessCount).toBe(3);
  });

  it("picks up TOKEN totals written by other processes, not just call counts", async () => {
    // The refresh re-read four counters and left the two token totals behind,
    // so a long-lived server answered inputTokens: 0 while the state file held
    // 45,345 from a dispatch it had itself started. Only a freshly started
    // process showed the truth — the exact shape the refresh exists to fix,
    // fixed for four fields out of six. This file asserting nothing about
    // tokens is why that shipped.
    const quota = new QuotaCache(dispatchers);
    await writeCountsAsAnotherProcess({
      calls: 1,
      success: 1,
      inputTokens: 45_345,
      outputTokens: 5,
    });

    const status = (await quota.fullStatus())["fake"]!;
    expect(status.localInputTokens).toBe(45_345);
    expect(status.localOutputTokens).toBe(5);
  });

  it("keeps failure and rate-limited counts distinct across processes", async () => {
    const quota = new QuotaCache(dispatchers);
    await writeCountsAsAnotherProcess({ calls: 9, success: 4, failure: 2, rateLimited: 3 });

    const status = (await quota.fullStatus())["fake"]!;
    expect(status.localFailureCount).toBe(2);
    expect(status.localRateLimitedCount).toBe(3);
  });

  it("never reports fewer calls than this process itself recorded", async () => {
    // Persisting is a documented read-modify-write race, so a concurrent
    // writer can clobber. Taking the larger value means a lost write shows a
    // stale count rather than losing one this process definitely made.
    const quota = new QuotaCache(dispatchers);
    quota.recordResult("fake", { output: "", success: true } as never);
    quota.recordResult("fake", { output: "", success: true } as never);
    await writeCountsAsAnotherProcess({ calls: 1, success: 1 });

    const status = (await quota.fullStatus())["fake"]!;
    expect(status.localCallCount).toBeGreaterThanOrEqual(2);
  });
});
