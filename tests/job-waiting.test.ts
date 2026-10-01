/**
 * A job that is waiting: what it says, and what moves it.
 *
 * A queued job said only "queued" and "wait ~5 minutes", whether it was next
 * in line or stuck behind two runs that had gone silent (reproduced in a
 * reliability audit). And once every supervisor had died, a waiting job sat
 * until some unrelated dispatch drained the queue, while its own polls kept
 * telling the caller to wait.
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
let seq = 0;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-waiting-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
  launched.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

async function plant(
  status: "queued" | "running",
  opts: { slotQueued?: boolean; claimPid?: number } = {},
): Promise<string> {
  seq += 1;
  const jobId = `job-17000000002${String(seq).padStart(2, "0")}-aaaaaaaa`;
  const jobDir = path.join(jobsDir, jobId);
  await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({
      jobId,
      status,
      createdAt: now,
      updatedAt: now,
      jobDir,
      ...(opts.slotQueued ? { slotQueued: true } : {}),
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(jobDir, "manifest.json"),
    JSON.stringify({ jobId, createdAt: now, workingDir: jobsDir, promptPath: "", files: [] }),
    "utf8",
  );
  if (opts.claimPid !== undefined) {
    await fs.writeFile(path.join(jobDir, "claim.json"), JSON.stringify({ pid: opts.claimPid, at: now }), "utf8");
  }
  return jobId;
}

describe("a job waiting for a slot", () => {
  it("says where it is in the queue and which runs it waits on", async () => {
    const { getAsyncJob } = await import("../src/jobs.js");
    const a = await plant("running", { claimPid: process.pid });
    const b = await plant("running", { claimPid: process.pid });
    const first = await plant("queued", { slotQueued: true });
    const second = await plant("queued", { slotQueued: true });

    const job = await getAsyncJob(second, { recover: false });
    expect(job.status.queuePosition).toBe(2);
    expect(job.status.waitingOn).toEqual([a, b]);
    expect(job.status.instructions).toMatch(/1 job\(s\) ahead of it, 2 running/);
    expect((await getAsyncJob(first, { recover: false })).status.queuePosition).toBe(1);
  });

  it("gets a supervisor started when polled and nothing alive would run it", async () => {
    const { getAsyncJob, resolveRunnerPath } = await import("../src/jobs.js");
    if (resolveRunnerPath() === undefined) return;
    const jobId = await plant("queued", { slotQueued: true });
    await getAsyncJob(jobId);
    expect(launched, "a poll of a stranded job started nothing").toHaveLength(1);
    expect(launched[0]!.args).toContain("--supervisor");
  });
});

describe("a cancelled job", () => {
  it("carries no poll instructions", async () => {
    // It told the caller to "check again until status is completed".
    const { cancelJob, getAsyncJob } = await import("../src/jobs.js");
    const jobId = await plant("queued", { slotQueued: true });
    await cancelJob(jobId);
    const job = await getAsyncJob(jobId, { recover: false });
    expect(job.status.status).toBe("cancelled");
    expect(job.status.instructions).toBeUndefined();
    expect(job.status.nextPollSeconds).toBeUndefined();
    const raw = JSON.parse(await fs.readFile(path.join(jobsDir, jobId, "status.json"), "utf8"));
    expect(raw.instructions, "the cancelled status on disk kept them").toBeUndefined();
  });
});

describe("watching a released job nobody claims", () => {
  it("starts a supervisor rather than waiting forever", async () => {
    // A released job used to read orphaned after 90 s, which ended the watch
    // an HTTP request was blocked on. It now reads as waiting, so the watch
    // has to see to it that something will run it.
    const { watchUntilTerminal } = await import("../src/jobs/run.js");
    const jobId = await plant("queued");
    const signal = AbortSignal.timeout(12_000);
    let nudged = 0;
    await watchUntilTerminal(path.join(jobsDir, jobId), {
      signal,
      onWaiting: async () => {
        nudged += 1;
      },
    });
    expect(nudged).toBeGreaterThan(0);
  }, 20_000);
});
