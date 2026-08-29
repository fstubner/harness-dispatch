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
import { fixedJobId } from "./support/fixtures.js";

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
    await plantJob(fixedJobId(1), {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });

    expect(await orphanStrandedSlotQueue()).toBe(1);

    const job = await getAsyncJob(fixedJobId(1));
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
    await plantJob(fixedJobId(2), {
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    await plantJob(fixedJobId(3), {
      status: "completed",
      updatedAt: new Date().toISOString(),
      success: true,
    });

    expect(await orphanStrandedSlotQueue()).toBe(0);
    expect((await getAsyncJob(fixedJobId(2))).status.status).toBe("running");
    expect((await getAsyncJob(fixedJobId(3))).status.status).toBe("completed");
  });

  it("is idempotent — a second server start finds nothing left to report", async () => {
    await plantJob(fixedJobId(4), {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });
    expect(await orphanStrandedSlotQueue()).toBe(1);
    expect(await orphanStrandedSlotQueue()).toBe(0);
  });
});

describe("orphanStrandedSlotQueue liveness", () => {
  it("leaves a queued job alone while a supervisor is alive", async () => {
    // The configuration this product ships by default has SEVERAL servers on
    // one jobs root: `connect` registers with Claude Code and Cursor, and
    // `serve` is a third. The first version of this reasoned "a server is
    // starting, so anything queued belongs to a dead session" — and an
    // acceptance pass measured it killing a live server's queued job within
    // a second, then removing it from the drain queue by clearing
    // slotQueued. `notes/ux-walkthrough.md` promises a waiting job is never
    // reported as orphaned; this is that promise.
    await plantJob(fixedJobId(21), {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });

    const beats = path.join(jobsDir, ".supervisors");
    await fs.mkdir(beats, { recursive: true });
    await fs.writeFile(path.join(beats, "live.txt"), new Date().toISOString(), "utf8");

    expect(await orphanStrandedSlotQueue()).toBe(0);
    const job = await getAsyncJob(fixedJobId(21));
    expect(job.status.status).toBe("queued");
    expect(job.status.slotQueued).toBe(true);
  });

  it("reports it once every supervisor heartbeat has gone stale", async () => {
    await plantJob(fixedJobId(22), {
      status: "queued",
      updatedAt: new Date().toISOString(),
      slotQueued: true,
    });

    const beats = path.join(jobsDir, ".supervisors");
    await fs.mkdir(beats, { recursive: true });
    // Older than the orphan threshold: nothing is working the queue.
    await fs.writeFile(
      path.join(beats, "dead.txt"),
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      "utf8",
    );

    expect(await orphanStrandedSlotQueue()).toBe(1);
    expect((await getAsyncJob(fixedJobId(22))).status.status).toBe("orphaned");
  });
});
