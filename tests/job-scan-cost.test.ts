/**
 * The slot drain and the claim loop skip their scan when nothing is waiting.
 *
 * Both read every retained job's status.json, and they ran on every dispatch
 * and twice on every supervisor pass (four times a second) — with seven days
 * of retention that is hundreds to thousands of files per pass for an HTTP or
 * CI user (measured: 2,000 retained jobs, ~0.7 s per drain). The pending index
 * lets them see "nothing waiting" without reading any.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let statusReads = 0;
vi.mock("../src/jobs/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/jobs/store.js")>();
  return {
    ...real,
    readJson: async <T,>(file: string): Promise<T> => {
      if (file.endsWith("status.json")) statusReads += 1;
      return real.readJson<T>(file);
    },
  };
});

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-scan-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  statusReads = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("with nothing waiting", () => {
  it("a drain reads no job's status", async () => {
    const { drainSlotQueue, resolveRunnerPath } = await import("../src/jobs.js");
    if (resolveRunnerPath() === undefined) return;
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i += 1) {
      const jobId = `job-17000000001${String(i).padStart(2, "0")}-aaaaaaaa`;
      const jobDir = path.join(jobsDir, jobId);
      await fs.mkdir(jobDir, { recursive: true });
      await fs.writeFile(
        path.join(jobDir, "status.json"),
        JSON.stringify({ jobId, status: "completed", createdAt: now, updatedAt: now, jobDir }),
        "utf8",
      );
    }
    // The index exists (a build that maintains it has run) and is empty.
    await fs.mkdir(path.join(jobsDir, ".pending"), { recursive: true });

    await drainSlotQueue(undefined, undefined);

    expect(statusReads, "the drain scanned every job with nothing waiting").toBe(0);
  });
});
