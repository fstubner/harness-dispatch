/**
 * Starting supervisors: what happens when it fails, and what it leaves behind.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainSlotQueue, resolveRunnerPath } from "../src/jobs.js";
import { countLiveSupervisorsForTest } from "../src/jobs/supervisor.js";

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-sup-launch-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

async function plantSlotQueued(): Promise<string> {
  const jobId = "job-1700000000077-aaaaaaaa";
  const jobDir = path.join(jobsDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(jobDir, "status.json"),
    JSON.stringify({ jobId, status: "queued", createdAt: now, updatedAt: now, jobDir, slotQueued: true }),
    "utf8",
  );
  return jobDir;
}

describe.skipIf(resolveRunnerPath() === undefined)("a supervisor that cannot be started", () => {
  it("is reported in its log instead of crashing the server", async () => {
    // `spawn` had no 'error' listener, so a failed spawn (EAGAIN, EMFILE, the
    // node binary gone after an upgrade) was an unhandled 'error' event that
    // killed the whole server — leaving the job released with nothing to run
    // it and a heartbeat for a supervisor that never existed. The `%` keeps
    // the Windows launch off WMI, which cmd.exe could not quote, so this
    // reaches the plain spawn on every platform.
    await plantSlotQueued();
    const realExecPath = process.execPath;
    process.execPath = path.join(jobsDir, "gone%", "node");
    try {
      await drainSlotQueue(undefined, undefined);
    } finally {
      process.execPath = realExecPath;
    }
    const dir = path.join(jobsDir, ".supervisors");
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith(".txt")), "a heartbeat for a supervisor that never ran").toEqual([]);
    const log = files.find((f) => f.startsWith("spawn-"));
    expect(log).toBeDefined();
    expect(await fs.readFile(path.join(dir, log!), "utf8")).toMatch(/could not start a supervisor/);
  });
});

describe("spawn logs", () => {
  it("are pruned once older than the job retention window, even when they explain a crash", async () => {
    // Kept forever before: a non-empty log was skipped by every sweep, so a
    // year of supervisor crashes accumulated in a directory every drain reads.
    vi.stubEnv("HARNESS_DISPATCH_JOB_MAX_AGE_MS", String(200_000));
    const dir = path.join(jobsDir, ".supervisors");
    await fs.mkdir(dir, { recursive: true });
    const old = path.join(dir, "spawn-1-aaaaaaaa.log");
    const recent = path.join(dir, "spawn-2-bbbbbbbb.log");
    await fs.writeFile(old, "fatal: bad config\n", "utf8");
    await fs.writeFile(recent, "fatal: bad config\n", "utf8");
    const pastRetention = new Date(Date.now() - 300_000);
    await fs.utimes(old, pastRetention, pastRetention);
    const insideRetention = new Date(Date.now() - 120_000);
    await fs.utimes(recent, insideRetention, insideRetention);

    await countLiveSupervisorsForTest();

    expect(existsSync(old), "a log older than retention was kept").toBe(false);
    expect(existsSync(recent), "a crash log inside retention was deleted").toBe(true);
  });
});
