/**
 * Running a finished job's task again.
 *
 * The last verb missing from the job lifecycle. You could start work, watch
 * it, stop it and resolve its workspace — but reproducing a failed run meant
 * reconstructing the prompt, files, working directory and hints by hand from
 * a record that already held all four. The machinery existed internally
 * (executeJobDir) and simply was not reachable.
 *
 * The retargeting case is the one that matters most in practice: the task was
 * fine and the ROUTE was not (a usage limit, a harness that wedged), so a
 * retry that could only use the original route would be useless exactly when
 * it is needed.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, retryJob } from "../src/jobs.js";

/**
 * Wait for a started job to reach a terminal state.
 *
 * A retry starts a REAL run, and these tests use in-process job mode, so
 * ending the test while it is still writing races teardown against the
 * runner — ENOTEMPTY on the jobs directory. Same shape as the teardown race
 * an earlier parity test hit by abandoning a dispatch mid-write.
 */
async function settle(jobId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const job = await getAsyncJob(jobId).catch(() => undefined);
    const st = job?.status.status;
    if (st && ["completed", "failed", "orphaned", "cancelled"].includes(st)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

let jobsDir: string;
let workDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-retry-"));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-retry-work-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
  await fs.rm(workDir, { recursive: true, force: true });
});

/** A holder with two routes so retargeting has somewhere to go. */
async function buildDeps() {
  const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");
  const { Router } = await import("../src/router.js");
  const { QuotaCache } = await import("../src/quota.js");
  const { LeaderboardCache } = await import("../src/leaderboard.js");
  const svc = (name: string) => ({
    name, enabled: true, type: "cli" as const, harness: name, command: name,
    tier: 1, weight: 1, cliCapability: 1, capabilities: { execute: 1, plan: 1, review: 1 },
    escalateOn: [], leaderboardModel: `${name}-m`, maxOutputTokens: 1000, maxInputTokens: 1000,
    provider: "local" as const, surface: "local_endpoint" as const,
    authSource: "local_network" as const, billingKind: "local_compute" as const,
    paidUsagePossible: false, billingConfidence: "documented" as const,
  });
  const makeDispatcher = (id: string) => ({
    id,
    async dispatch() { return { output: `from ${id}`, service: id, success: true }; },
    async *stream() {
      yield { type: "completion" as const, result: { output: `from ${id}`, service: id, success: true } };
    },
    async checkQuota() { return { service: id, source: "unknown" as const }; },
    isAvailable: () => true,
  });
  const config = { services: { alpha: svc("alpha"), beta: svc("beta") } };
  const dispatchers = { alpha: makeDispatcher("alpha"), beta: makeDispatcher("beta") } as never;
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-retry:" });
  const leaderboard = new LeaderboardCache();
  const router = new Router(config as never, quota, dispatchers, leaderboard);
  return {
    holder: new RuntimeHolder({ config, dispatchers, quota, router, leaderboard, mtimeMs: 0 } as never),
  };
}

/** Plant a finished job with a real manifest and prompt on disk. */
async function plantFinished(jobId: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(jobsDir, jobId);
  await fs.mkdir(path.join(dir, "output"), { recursive: true });
  const promptPath = path.join(dir, "prompt.md");
  await fs.writeFile(promptPath, "## Context from earlier work\n\nfix the parser", "utf8");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      jobId,
      createdAt: new Date().toISOString(),
      workingDir: workDir,
      promptPath,
      files: [],
      service: "alpha",
      hints: { taskType: "execute" },
      ...over,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({
      jobId, status: "failed", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), jobDir: dir, success: false,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "output", "result.json"),
    JSON.stringify({ jobId, result: { output: "", service: "alpha", success: false }, decision: null }),
    "utf8",
  );
}

describe("retryJob", () => {
  it("reuses the prompt the DELEGATE saw, not the one the caller typed", async () => {
    // prompt.md is the frozen prompt, context preamble included. Reusing the
    // caller's original text instead would silently drop the chained context
    // a retry is supposed to reproduce.
    await plantFinished("job-1700000000001-aaaaaaaa");
    const out = await retryJob("job-1700000000001-aaaaaaaa", await buildDeps());
    await settle(out.jobId);

    const manifest = JSON.parse(
      await fs.readFile(path.join(jobsDir, out.jobId, "manifest.json"), "utf8"),
    ) as { promptPath: string; retryOf: string };
    const prompt = await fs.readFile(manifest.promptPath, "utf8");
    expect(prompt).toContain("Context from earlier work");
    expect(prompt).toContain("fix the parser");
    expect(manifest.retryOf).toBe("job-1700000000001-aaaaaaaa");
  });

  it("retargets to another route, which is the usual reason to retry", async () => {
    await plantFinished("job-1700000000002-bbbbbbbb");
    const out = await retryJob("job-1700000000002-bbbbbbbb", await buildDeps(), { service: "beta" });
    await settle(out.jobId);
    expect(out.service).toBe("beta");
    expect(out.message).toContain("beta");
  });

  it("reuses the original route when none is given", async () => {
    await plantFinished("job-1700000000003-cccccccc");
    const out = await retryJob("job-1700000000003-cccccccc", await buildDeps());
    await settle(out.jobId);
    expect(out.service).toBe("alpha");
  });

  it("refuses an unknown retarget by name rather than failing at dispatch", async () => {
    await plantFinished("job-1700000000004-dddddddd");
    await expect(
      retryJob("job-1700000000004-dddddddd", await buildDeps(), { service: "ghost" }),
    ).rejects.toThrow(/Unknown service: ghost/);
  });

  it("refuses to retry a job that is still running", async () => {
    // Two attempts racing on one working directory is the failure this
    // prevents — the original is still editing files.
    await plantFinished("job-1700000000005-eeeeeeee");
    const statusPath = path.join(jobsDir, "job-1700000000005-eeeeeeee", "status.json");
    const st = JSON.parse(await fs.readFile(statusPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(statusPath, JSON.stringify({ ...st, status: "running" }), "utf8");

    await expect(retryJob("job-1700000000005-eeeeeeee", await buildDeps())).rejects.toThrow(
      /still running/,
    );
  });

  it("leaves the original job untouched", async () => {
    await plantFinished("job-1700000000006-ffffffff");
    const before = await fs.readFile(
      path.join(jobsDir, "job-1700000000006-ffffffff", "status.json"), "utf8",
    );
    const retried = await retryJob("job-1700000000006-ffffffff", await buildDeps());
    await settle(retried.jobId);
    const after = await fs.readFile(
      path.join(jobsDir, "job-1700000000006-ffffffff", "status.json"), "utf8",
    );
    expect(after).toBe(before);
  });

  it("reports a stranger the same way job_status does", async () => {
    await expect(retryJob("job-1700000000009-99999999", await buildDeps())).rejects.toThrow(
      /No such job/,
    );
  });
});
