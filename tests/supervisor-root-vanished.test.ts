/**
 * A supervisor whose jobs root is deleted while it is running a job.
 *
 * It stopped polling (right) by returning at once (wrong): the process then
 * exits, and on Windows that kills the agent CLI it was supervising halfway
 * through an edit. It now claims nothing more but lets in-flight runs finish.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/status.js")>()),
  // The dist/ on disk may be newer than this test process, which would make
  // the supervisor hand over instead of claiming.
  staleCodeWarning: () => undefined,
}));
vi.mock("../src/jobs/detach.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/detach.js")>()),
  launchDetached: async () => ({ ok: true, method: "spawn" }),
}));

let base: string;
let jobsDir: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "hd-root-gone-"));
  jobsDir = path.join(base, "jobs");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

describe("a supervisor whose jobs root vanishes", () => {
  it("lets the run it is supervising finish before it exits", async () => {
    const jobId = "job-1700000000088-aaaaaaaa";
    const jobDir = path.join(jobsDir, jobId);
    await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
    const now = new Date().toISOString();
    const promptPath = path.join(jobDir, "prompt.md");
    await fs.writeFile(promptPath, "p", "utf8");
    await fs.writeFile(
      path.join(jobDir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: now, workingDir: base, promptPath, files: [] }),
      "utf8",
    );
    // Released: queued, not slot-queued, unclaimed.
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "queued", createdAt: now, updatedAt: now, jobDir }),
      "utf8",
    );

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runFinished = false;
    const router = {
      stream: async function* () {
        yield { event: { type: "stdout", chunk: "working" }, decision: null };
        await gate;
        runFinished = true;
        yield {
          event: { type: "completion", result: { output: "done", service: "fake", success: true } },
          decision: null,
        };
      },
    };
    const { runSupervisor } = await import("../src/jobs.js");
    const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");
    const holder = new RuntimeHolder({ config: { services: {} }, router } as never);
    const supervisor = runSupervisor({ holder }, "root-gone-test");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8"));
      if (status.status === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 5 });
    setTimeout(release, 1_500);
    await supervisor;
    expect(runFinished, "the supervisor exited with a run still in flight").toBe(true);
  }, 30_000);
});
