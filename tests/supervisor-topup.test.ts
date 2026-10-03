/**
 * A released job with no supervisor to run it.
 *
 * The drain only started supervisors for jobs it released on that same call.
 * A job released earlier whose supervisor never came up (a failed launch, or
 * one killed between release and claim) therefore waited for the next RELEASE
 * — and with nothing else queued there never was one.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launched: Array<{ args: string[] }> = [];
vi.mock("../src/jobs/detach.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/detach.js")>()),
  launchDetached: async (spec: { args: string[] }) => {
    launched.push(spec);
    return { ok: true, method: "spawn" };
  },
}));

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-topup-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  launched.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("the slot drain", () => {
  it("starts a supervisor for released work nobody has claimed, even when it releases nothing", async () => {
    const { drainSlotQueue, resolveRunnerPath } = await import("../src/jobs.js");
    if (resolveRunnerPath() === undefined) return;
    const jobId = "job-1700000000099-aaaaaaaa";
    const jobDir = path.join(jobsDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "queued", createdAt: now, updatedAt: now, jobDir }),
      "utf8",
    );

    await drainSlotQueue(undefined, undefined);

    expect(launched, "no supervisor for a released, unclaimed job").toHaveLength(1);
    expect(launched[0]!.args).toContain("--supervisor");
  });
});
