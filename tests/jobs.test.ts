import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, listAsyncJobs, startAsyncJobTracked, type JobDeps } from "../src/jobs.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-jobs-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeDeps(): JobDeps {
  const holder = {
    state: {
      router: {
        stream: async function* () {
          throw new Error("boom");
        },
        streamTo: async function* () {
          throw new Error("boom");
        },
      },
    },
  } as unknown as RuntimeHolder;
  return { holder };
}

describe("startAsyncJob file permissions", () => {
  it.skipIf(process.platform === "win32")(
    "creates job dirs and files as owner-only (0700/0600), not world-readable",
    async () => {
      // Tracked variant: await the background run before afterEach removes
      // tmpDir — the fire-and-forget form races cleanup (ENOTEMPTY on the
      // slower macOS CI runners; caught by the first cross-platform run).
      const { status, completion } = await startAsyncJobTracked(fakeDeps(), {
        prompt: "hello",
        workingDir: tmpDir,
      });
      await completion;

      const jobDir = status.jobDir;
      const dirMode = (await fs.stat(jobDir)).mode & 0o777;
      const contextMode = (await fs.stat(path.join(jobDir, "context"))).mode & 0o777;
      const outputMode = (await fs.stat(path.join(jobDir, "output"))).mode & 0o777;
      const promptMode = (await fs.stat(path.join(jobDir, "prompt.md"))).mode & 0o777;

      expect(dirMode).toBe(0o700);
      expect(contextMode).toBe(0o700);
      expect(outputMode).toBe(0o700);
      expect(promptMode).toBe(0o600);
    },
  );
});

describe("orphaned job detection", () => {
  it("reports a running job with a stale heartbeat as orphaned, not running forever", async () => {
    // Simulate the real incident: a server process died mid-run, leaving a
    // status.json frozen at "running" with no result and no further
    // heartbeats. Readers must stop telling callers to keep polling.
    // Realistic id shape on purpose: getAsyncJob validates jobId against the
    // format jobs.ts generates before touching the filesystem, so a
    // human-readable placeholder like "job-0-orphaned" is now rejected as
    // malformed and never reaches the orphan logic under test.
    const jobId = "job-1786977300000-0f0aaaaa";
    const jobDir = path.join(tmpDir, jobId);
    await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const status = {
      jobId,
      status: "running",
      createdAt: stale,
      updatedAt: stale,
      jobDir,
    };
    await fs.writeFile(path.join(jobDir, "status.json"), JSON.stringify(status));
    await fs.writeFile(
      path.join(jobDir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: stale, workingDir: tmpDir, promptPath: "", files: [] }),
    );

    const job = await getAsyncJob(jobId);
    expect(job.status.status).toBe("orphaned");
    expect(job.status.success).toBe(false);
    expect(job.status.error).toMatch(/exited before the run finished/);
    // Terminal: no poll guidance for a job that will never complete.
    expect(job.status.instructions).toBeUndefined();

    const listed = await listAsyncJobs();
    expect(listed.find((j) => j.jobId === jobId)?.status).toBe("orphaned");
  });

  it("hands back the progress an orphaned job saved, instead of nothing", async () => {
    // PRODUCT.md's success criterion, verbatim: a dispatch must never die
    // returning nothing - "at worst it fails and hands back its latest
    // progress... a wasted attempt with no trail is the defining failure."
    // Orphaning is precisely the case it was written for: the supervisor died,
    // so there is no result.json and stdout.partial.log is all that survived.
    //
    // The orphan branch returned ABOVE the partial-output read, so an
    // acceptance pass measured eight chunks of progress on disk and an empty
    // response.
    const jobId = "job-1786977300001-0f0bbbbb";
    const jobDir = path.join(tmpDir, jobId);
    await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "running", createdAt: stale, updatedAt: stale, jobDir }),
    );
    await fs.writeFile(
      path.join(jobDir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: stale, workingDir: tmpDir, promptPath: "", files: [] }),
    );
    await fs.writeFile(
      path.join(jobDir, "output", "stdout.partial.log"),
      ["step 1 done", "step 2 done", "halfway through step 3"].join("|"),
      "utf8",
    );

    const job = await getAsyncJob(jobId);
    expect(job.status.status).toBe("orphaned");
    expect(job.partialOutput, "the trail was on disk and was not returned").toContain(
      "halfway through step 3",
    );
    // Still terminal: salvage does not mean "keep polling".
    expect(job.status.instructions).toBeUndefined();
    expect(job.status.nextPollSeconds).toBeUndefined();
  });

  it("an orphaned job with no partial log still reports cleanly", async () => {
    // The salvage path must not invent a field when there is nothing to
    // salvage - absence of progress is not an error.
    const jobId = "job-1786977300002-0f0ccccc";
    const jobDir = path.join(tmpDir, jobId);
    await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "running", createdAt: stale, updatedAt: stale, jobDir }),
    );
    await fs.writeFile(
      path.join(jobDir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: stale, workingDir: tmpDir, promptPath: "", files: [] }),
    );

    const job = await getAsyncJob(jobId);
    expect(job.status.status).toBe("orphaned");
    expect(job.partialOutput).toBeUndefined();
  });

  it("keeps a freshly-heartbeated running job as running", async () => {
    const jobId = "job-1786977300001-0f0bbbbb";
    const jobDir = path.join(tmpDir, jobId);
    await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "running", createdAt: now, updatedAt: now, jobDir }),
    );
    await fs.writeFile(
      path.join(jobDir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: now, workingDir: tmpDir, promptPath: "", files: [] }),
    );

    const job = await getAsyncJob(jobId);
    expect(job.status.status).toBe("running");
    expect(job.status.instructions).toMatch(/job_status/);
  });
});
