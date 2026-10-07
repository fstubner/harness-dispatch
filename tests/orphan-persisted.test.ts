/**
 * A job found dead is recorded as orphaned in status.json, once, and a job that
 * might be alive is never rewritten.
 *
 * `job_status` reported a run whose heartbeat stopped and whose process is gone
 * as `orphaned`, but only in its answer: status.json went on saying `running`,
 * so anything reading the file directly (two real jobs from 2026-10-01 were
 * still "running" six days later) saw a live run that was not there.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, listAsyncJobs } from "../src/jobs.js";
import { checkOrphan } from "../src/jobs/store.js";

let tmpDir: string;
let seq = 0;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-orphan-persist-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

/** A job directory whose status.json is `fields` over a running record. */
async function plant(
  fields: Record<string, unknown>,
  claim?: { pid: number },
): Promise<{ jobId: string; jobDir: string; statusPath: string }> {
  seq += 1;
  const jobId = `job-17000000010${String(seq).padStart(2, "0")}-aaaaaaaa`;
  const jobDir = path.join(tmpDir, jobId);
  await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
  const created = minutesAgo(30);
  await fs.writeFile(
    path.join(jobDir, "manifest.json"),
    JSON.stringify({ jobId, createdAt: created, workingDir: tmpDir, promptPath: "", files: [] }),
    "utf8",
  );
  const statusPath = path.join(jobDir, "status.json");
  await fs.writeFile(
    statusPath,
    JSON.stringify({ jobId, status: "running", createdAt: created, updatedAt: minutesAgo(10), jobDir, ...fields }),
    "utf8",
  );
  if (claim !== undefined) {
    await fs.writeFile(path.join(jobDir, "claim.json"), JSON.stringify({ ...claim, at: created }), "utf8");
  }
  return { jobId, jobDir, statusPath };
}

const read = async (statusPath: string): Promise<{ status: string; [k: string]: unknown }> =>
  JSON.parse(await fs.readFile(statusPath, "utf8"));

// A pid no process has.
const DEAD_PID = 0x7ffffffe;

describe("a dead running job", () => {
  it("is written as orphaned when job_status first reads it, children kept", async () => {
    const children = [{ pid: DEAD_PID, command: "node", startedAt: minutesAgo(20) }];
    const { jobId, statusPath } = await plant({ children, route: "fake_cli" }, { pid: DEAD_PID });
    expect((await read(statusPath)).status).toBe("running");

    expect((await getAsyncJob(jobId)).status.status).toBe("orphaned");

    const onDisk = await read(statusPath);
    expect(onDisk.status).toBe("orphaned");
    expect(onDisk.success).toBe(false);
    expect(String(onDisk.error)).toMatch(/stopped reporting progress/);
    expect(onDisk.children, "cancel_job needs these to stop what the dead run left").toEqual(children);
  });

  it("is written as orphaned when the job list first reads it", async () => {
    const { jobId, statusPath } = await plant({});
    expect((await listAsyncJobs()).find((j) => j.jobId === jobId)?.status).toBe("orphaned");
    expect((await read(statusPath)).status).toBe("orphaned");
  });
});

describe("a job that may be alive is never rewritten", () => {
  async function untouched(statusPath: string, read_: () => Promise<unknown>): Promise<void> {
    const before = await fs.readFile(statusPath, "utf8");
    await read_();
    expect(await fs.readFile(statusPath, "utf8")).toBe(before);
  }

  it("a running job with a fresh heartbeat", async () => {
    const { jobId, statusPath } = await plant({ updatedAt: new Date().toISOString() });
    await untouched(statusPath, async () => {
      expect((await getAsyncJob(jobId)).status.status).toBe("running");
      await listAsyncJobs();
    });
  });

  it("a stale heartbeat whose claiming process is still alive", async () => {
    // A laptop that slept, or a stalled event loop: not a death.
    const { jobId, statusPath } = await plant({}, { pid: process.pid });
    await untouched(statusPath, async () => {
      expect((await getAsyncJob(jobId)).status.status).toBe("running");
      await listAsyncJobs();
    });
  });

  it("a released job whose claimant died, which claimNextJob will reclaim and run", async () => {
    const { jobId, statusPath } = await plant({ status: "queued" }, { pid: DEAD_PID });
    await untouched(statusPath, async () => {
      expect((await getAsyncJob(jobId, { recover: false })).status.status).toBe("orphaned");
      await listAsyncJobs();
    });
  });

  it("a job whose runner beat after the verdict was computed", async () => {
    // The verdict came from a stale read; by the time it would be written the
    // runner has heartbeated. The file must keep the runner's record.
    const { jobDir, statusPath } = await plant({ updatedAt: new Date().toISOString() });
    const staleRead = { jobId: "x", status: "running", createdAt: minutesAgo(30), updatedAt: minutesAgo(10), jobDir };
    await untouched(statusPath, async () => {
      expect((await checkOrphan(jobDir, staleRead as never)).status).toBe("orphaned");
    });
  });
});
