/**
 * Job retention must not delete directories this tool never created.
 *
 * The third instance of one defect in a single release. Workspace reclamation
 * shipped it twice — first with no ownership check at all, then with a name
 * shape (`-[0-9a-f]{8}$`) that every `<name>-<YYYYMMDD>` satisfied — and an
 * acceptance pass then found the same shape here, untouched: `pruneStaleJobs`
 * removed every stale directory under the jobs root, recursively, with no
 * check of any kind. Pointed at a directory holding `backup-20260401` and
 * `my-notes`, it destroyed both.
 *
 * The jobs root is relocatable (HARNESS_DISPATCH_JOBS_DIR, and
 * HARNESS_DISPATCH_STATE_DIR which moves it too), so "it is our directory" is
 * an assumption, not a fact.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pruneStaleJobs, setJobRetentionDays } from "../src/jobs/store.js";

let root: string;
const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function plant(name: string, child: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, child), "precious", "utf8");
  await fs.utimes(dir, stale, stale);
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hd-jobprune-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", root);
  setJobRetentionDays(1);
});

afterEach(async () => {
  setJobRetentionDays(undefined);
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("pruneStaleJobs ownership", () => {
  it("deletes its own stale job directories", async () => {
    // The behaviour retention exists for: without it, job bundles accumulate
    // without bound.
    const ours = await plant("job-1700000000000-abcdef12", "manifest.json");
    await pruneStaleJobs();
    await expect(fs.stat(ours), "a real stale job survived retention").rejects.toThrow();
  });

  it.each([
    ["a dated backup directory", "backup-20260401", "data.bin"],
    ["an ordinary directory", "my-notes", "n.txt"],
    ["a near-miss name", "job-notanumber-abcdef12", "x.txt"],
    ["a short suffix", "job-1700000000000-abcd", "x.txt"],
  ])("leaves %s alone", async (_label, name, child) => {
    const foreign = await plant(name, child);
    await pruneStaleJobs();
    await expect(
      fs.stat(path.join(foreign, child)),
      "a directory harness-dispatch never created was deleted",
    ).resolves.toBeDefined();
  });
});

/**
 * A status write into a job directory that no longer exists must not throw.
 *
 * Retention prunes bundles, and users delete them, while a runner is still
 * alive. A status write is a RECORD of the run, not the run itself — throwing
 * took the runner down with an unhandled rejection over a file nobody was
 * going to read, from the 15-second heartbeat, so any long job could hit it.
 * It broke CI on Windows exactly this way: every test passing, the suite
 * failing on a rename into a directory the test had already cleaned up.
 */
describe("updateStatus against a vanished job directory", () => {
  it("gives up quietly when the directory is gone", async () => {
    const { updateStatus } = await import("../src/jobs/store.js");
    const gone = path.join(root, "job-1700000000009-feedface");
    await expect(
      updateStatus(gone, {
        jobId: "job-1700000000009-feedface",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        jobDir: gone,
      }),
    ).resolves.toBeUndefined();
  });

  it("still reports a failure when the directory DOES exist", async () => {
    // The narrowness matters: a full disk or a permission fault means the
    // record is being lost while somewhere to put it still exists, and that
    // must not be swallowed. A directory where the status FILE must go is the
    // closest reproducible stand-in for an unwritable target.
    const { updateStatus } = await import("../src/jobs/store.js");
    const jobDir = path.join(root, "job-1700000000010-c0ffee11");
    await fs.mkdir(path.join(jobDir, "status.json"), { recursive: true });
    await expect(
      updateStatus(jobDir, {
        jobId: "job-1700000000010-c0ffee11",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        jobDir,
      }),
    ).rejects.toThrow();
  });
});
