/**
 * A supervisor running older code than is now installed.
 *
 * Supervisors outlive the server that started them and keep claiming while
 * work keeps arriving, so after an upgrade, jobs submitted by the new server
 * ran on the old code for as long as the old supervisor stayed busy —
 * observed on Linux while comparing two installs. An outdated supervisor now
 * claims nothing more and starts a replacement from the installed build.
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: unknown[][] = [];
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => {
    spawned.push(args);
    return { unref() {} };
  },
}));
vi.mock("../src/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/status.js")>()),
  staleCodeWarning: () => "this server is running older code than is now installed",
}));

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-outdated-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  spawned.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true });
});

describe("an outdated supervisor", () => {
  it("claims no new job and hands over to one started from the installed build", async () => {
    const jobId = "job-1700000000051-aaaaaaaa";
    const jobDir = path.join(jobsDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(jobDir, "status.json"),
      JSON.stringify({ jobId, status: "queued", createdAt: now, updatedAt: now, jobDir }),
      "utf8",
    );

    const { runSupervisor, resolveRunnerPath } = await import("../src/jobs.js");
    const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");
    const holder = new RuntimeHolder({ config: { services: {} } } as never);
    await runSupervisor({ holder }, "outdated-test");

    expect(existsSync(path.join(jobDir, "claim.json")), "the outdated supervisor claimed a job").toBe(false);
    if (resolveRunnerPath() !== undefined) {
      expect(spawned).toHaveLength(1);
      expect(spawned[0]![1]).toEqual([resolveRunnerPath(), "--supervisor", expect.any(String)]);
    }
  }, 20_000);
});
