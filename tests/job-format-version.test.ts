/**
 * Job records carry a format version, and this build refuses one it is too
 * old to understand.
 *
 * status.json and manifest.json had no version: compatibility was tolerant
 * parsing alone, so a record written by a newer build was read — and run —
 * by an older one as if every field meant what it used to.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainSlotQueue, getAsyncJob, resolveRunnerPath, startAsyncJobTracked } from "../src/jobs.js";
import { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-format-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

async function plantNewer(): Promise<{ jobId: string; jobDir: string }> {
  const jobId = "job-1700000000401-aaaaaaaa";
  const jobDir = path.join(jobsDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(jobDir, "manifest.json"),
    JSON.stringify({ v: 2, jobId, createdAt: now, workingDir: jobsDir, promptPath: "", files: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({ v: 2, jobId, status: "queued", createdAt: now, updatedAt: now, jobDir, slotQueued: true }),
    "utf8",
  );
  return { jobId, jobDir };
}

describe("job format version", () => {
  it("is written into a new job's status and manifest", async () => {
    const router = {
      stream: async function* () {
        yield { event: { type: "completion", result: { output: "ok", service: "fake", success: true } }, decision: null };
      },
    };
    const holder = new RuntimeHolder({ config: { services: {} }, router } as never);
    const { status, completion } = await startAsyncJobTracked({ holder }, { prompt: "p", workingDir: jobsDir });
    await completion;
    const read = async (f: string) => JSON.parse(await fs.readFile(path.join(status.jobDir, f), "utf8"));
    expect((await read("status.json")).v).toBe(1);
    expect((await read("manifest.json")).v).toBe(1);
  });

  it("refuses to read a job a newer build wrote, and says to upgrade", async () => {
    const { jobId } = await plantNewer();
    await expect(getAsyncJob(jobId)).rejects.toThrow(/newer harness-dispatch .*Upgrade/);
  });

  it("does not release a newer build's queued job", async () => {
    if (resolveRunnerPath() === undefined) return;
    vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
    const { jobDir } = await plantNewer();
    await drainSlotQueue(undefined, undefined);
    const raw = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8"));
    expect(raw.slotQueued, "an older build released (and rewrote) a newer build's job").toBe(true);
    expect(raw.v).toBe(2);
  });
});
