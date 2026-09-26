/**
 * The orphan sweep acts on a job list read before it writes, and another
 * server can release a queued job in between: its dispatch marks the job
 * `slotQueued` and its drain releases it moments later. Writing back the
 * earlier copy marked that released job orphaned, and it never ran. Found in
 * an audit.
 *
 * The list is mocked to be the earlier copy, because the real window is the
 * few milliseconds between two servers' reads and writes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobStatus } from "../src/jobs/types.js";

const stale: JobStatus[] = [];
vi.mock("../src/jobs/read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/read.js")>()),
  listAsyncJobs: async () => stale,
}));

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-stale-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  stale.length = 0;
  await fs.rm(jobsDir, { recursive: true, force: true });
});

describe("the orphan sweep and a job released since it listed", () => {
  it("leaves a job another server has just released", async () => {
    const jobId = "job-1700000000041-aaaaaaaa";
    const jobDir = path.join(jobsDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const now = new Date().toISOString();
    const queued: JobStatus = { jobId, status: "queued", createdAt: now, updatedAt: now, jobDir, slotQueued: true };
    stale.push(queued);
    // On disk it has already been released: no longer waiting for a slot.
    const { slotQueued: _released, ...released } = queued;
    await fs.writeFile(path.join(jobDir, "status.json"), JSON.stringify(released), "utf8");

    const { orphanStrandedSlotQueue } = await import("../src/jobs/supervisor.js");
    await orphanStrandedSlotQueue();

    const after = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8")) as JobStatus;
    expect(after.status, "a released job was marked orphaned from a stale list").toBe("queued");
  });

  it("still orphans a job that really is stranded", async () => {
    const jobId = "job-1700000000042-bbbbbbbb";
    const jobDir = path.join(jobsDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const now = new Date().toISOString();
    const queued: JobStatus = { jobId, status: "queued", createdAt: now, updatedAt: now, jobDir, slotQueued: true };
    stale.push(queued);
    await fs.writeFile(path.join(jobDir, "status.json"), JSON.stringify(queued), "utf8");

    const { orphanStrandedSlotQueue } = await import("../src/jobs/supervisor.js");
    expect(await orphanStrandedSlotQueue()).toBe(1);
    const after = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8")) as JobStatus;
    expect(after.status).toBe("orphaned");
  });
});
