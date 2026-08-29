/**
 * A job stranded in the slot queue by a dead server must be REPORTED, not run.
 *
 * Two failures bracket this. Before: slot-queued jobs are exempt from orphan
 * detection (nothing heartbeats for them), and the only things that drained
 * the queue were a runner exiting and a new dispatch arriving — so a server
 * that died with jobs queued left them reading `queued` forever, while a
 * RUNNING job in the same situation is reported orphaned within 90 seconds.
 *
 * The first fix drained the queue at server start, and an acceptance pass
 * demonstrated why that was worse: kill a server with a job queued, restart,
 * and the job runs to completion in its original workingDir at whatever safety
 * profile the manifest recorded — up to full_auto, unattended, bounded only by
 * the 7-day retention window. Starting an editor should not run yesterday's
 * abandoned agent job against your repository.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, orphanStrandedSlotQueue } from "../src/jobs.js";

let jobsDir: string;

async function plantJob(jobId: string, status: Record<string, unknown>): Promise<string> {
  const dir = path.join(jobsDir, jobId);
  await fs.mkdir(path.join(dir, "output"), { recursive: true });
  await fs.writeFile(path.join(dir, "prompt.md"), "probe", "utf8");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      jobId,
      createdAt: new Date().toISOString(),
      workingDir: jobsDir,
      promptPath: path.join(dir, "prompt.md"),
      files: [],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ jobId, createdAt: new Date().toISOString(), jobDir: dir, ...status }),
    "utf8",
  );
  return dir;
}

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-stranded-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("orphanStrandedSlotQueue", () => {
  it("reports a stranded queued job instead of leaving it queued forever", async () => {
    await plantJob("job-1700000000000-aaaaaaaa", {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });

    expect(await orphanStrandedSlotQueue()).toBe(1);

    const job = await getAsyncJob("job-1700000000000-aaaaaaaa");
    expect(job.status.status).toBe("orphaned");
    expect(job.status.success).toBe(false);
    // The message has to say it will NOT be resumed, and what to do instead —
    // the caller's real question is "is this ever going to run?".
    expect(job.status.error).toMatch(/retry_job/);
    expect(job.status.error).toMatch(/not resumed automatically/i);
  });

  it("does not touch a job that is merely running, queued or finished", async () => {
    // Only the slot-queue flag means "stranded". A running job has its own
    // orphan rule, computed on read and never written back, because its owner
    // might still be alive.
    await plantJob("job-1700000000001-bbbbbbbb", {
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    await plantJob("job-1700000000002-cccccccc", {
      status: "completed",
      updatedAt: new Date().toISOString(),
      success: true,
    });

    expect(await orphanStrandedSlotQueue()).toBe(0);
    expect((await getAsyncJob("job-1700000000001-bbbbbbbb")).status.status).toBe("running");
    expect((await getAsyncJob("job-1700000000002-cccccccc")).status.status).toBe("completed");
  });

  it("is idempotent — a second server start finds nothing left to report", async () => {
    await plantJob("job-1700000000003-dddddddd", {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });
    expect(await orphanStrandedSlotQueue()).toBe(1);
    expect(await orphanStrandedSlotQueue()).toBe(0);
  });
});
