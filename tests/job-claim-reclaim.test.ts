/**
 * Reclaiming a stale job claim must pick exactly ONE winner.
 *
 * The first claim of a job uses `wx`, which is atomic — but the RECLAIM path
 * (taking over a claim whose supervisor crashed) used to rewrite claim.json
 * without `wx`, so two supervisors deciding "stale" in the same window both
 * succeeded and the job ran twice: a duplicate CLI execution, billed twice.
 * Against that code, this test's two concurrent reclaims BOTH return true.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimJobDir } from "../src/jobs.js";

type Status = Parameters<typeof claimJobDir>[1];

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-claim-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function staleStatus(): Status {
  // Heartbeat far beyond ORPHAN_THRESHOLD_MS (90s), so the claim is reclaimable.
  return { updatedAt: new Date(Date.now() - 600_000).toISOString() } as Status;
}

describe("claimJobDir — stale-claim reclaim", () => {
  it("grants exactly one of two concurrent reclaims", async () => {
    const jobDir = path.join(dir, "job-1700000000000-deadbeef");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(
      path.join(jobDir, "claim.json"),
      JSON.stringify({ pid: 999_999, at: "2026-01-01T00:00:00Z" }),
      "utf8",
    );

    const results = await Promise.all([
      claimJobDir(jobDir, staleStatus()),
      claimJobDir(jobDir, staleStatus()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    // And the winner's claim is in place for the next orphan check to see.
    const claim = JSON.parse(await fs.readFile(path.join(jobDir, "claim.json"), "utf8")) as {
      pid: number;
    };
    expect(claim.pid).toBe(process.pid);
  });

  it("does not reclaim a claim whose job heartbeat is fresh", async () => {
    const jobDir = path.join(dir, "job-1700000000000-cafecafe");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "claim.json"), JSON.stringify({ pid: 1 }), "utf8");

    const fresh = { updatedAt: new Date().toISOString() } as Status;
    expect(await claimJobDir(jobDir, fresh)).toBe(false);
  });

  it("leaves no tombstones behind after a reclaim", async () => {
    const jobDir = path.join(dir, "job-1700000000000-beefbeef");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "claim.json"), JSON.stringify({ pid: 1 }), "utf8");

    expect(await claimJobDir(jobDir, staleStatus())).toBe(true);
    const leftovers = (await fs.readdir(jobDir)).filter((f) => f.startsWith("claim.stale-"));
    expect(leftovers).toEqual([]);
  });
});
