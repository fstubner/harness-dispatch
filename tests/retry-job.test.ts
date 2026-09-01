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

  /**
   * A model name belongs to the route it was chosen for. Carrying one across
   * a retarget defeated the exact case retry exists for — observed end to
   * end: a Cursor run that died on `Cannot use this model` was retried onto
   * Claude and died on `unrecognized_model`, never reaching the task.
   */
  it("leaves behind a model the retarget route does not declare", async () => {
    await plantFinished("job-1700000000011-aaaabbbb", {
      hints: { taskType: "execute", model: "alpha-only-model" },
    });
    const out = await retryJob("job-1700000000011-aaaabbbb", await buildDeps(), {
      service: "beta",
    });
    await settle(out.jobId);

    expect(out.droppedModel).toBe("alpha-only-model");
    // Reported, not silent: a quietly changed model is the failure mode this
    // project keeps finding.
    expect(out.message).toContain("alpha-only-model");

    const manifest = JSON.parse(
      await fs.readFile(path.join(jobsDir, out.jobId, "manifest.json"), "utf8"),
    ) as { hints?: { model?: string; taskType?: string } };
    expect(manifest.hints?.model).toBeUndefined();
    // Only the model goes; the rest of the hints are the caller's intent.
    expect(manifest.hints?.taskType).toBe("execute");
  });

  it("keeps a model the retarget route DOES declare", async () => {
    await plantFinished("job-1700000000012-bbbbcccc", {
      hints: { taskType: "execute", model: "beta-m" },
    });
    const out = await retryJob("job-1700000000012-bbbbcccc", await buildDeps(), {
      service: "beta",
    });
    await settle(out.jobId);

    expect(out.droppedModel).toBeUndefined();
    const manifest = JSON.parse(
      await fs.readFile(path.join(jobsDir, out.jobId, "manifest.json"), "utf8"),
    ) as { hints?: { model?: string } };
    expect(manifest.hints?.model).toBe("beta-m");
  });

  it("keeps the model when the retry stays on the original route", async () => {
    // Not a retarget — this is a plain "try that again", and the model was
    // the caller's choice for this very route.
    await plantFinished("job-1700000000013-ccccdddd", {
      hints: { taskType: "execute", model: "some-alpha-model" },
    });
    const out = await retryJob("job-1700000000013-ccccdddd", await buildDeps(), {
      service: "alpha",
    });
    await settle(out.jobId);

    expect(out.droppedModel).toBeUndefined();
    const manifest = JSON.parse(
      await fs.readFile(path.join(jobsDir, out.jobId, "manifest.json"), "utf8"),
    ) as { hints?: { model?: string } };
    expect(manifest.hints?.model).toBe("some-alpha-model");
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

describe("retrying a derived orphan", () => {
  /**
   * `retryJob` refuses `running`/`queued` because "retrying a live run would
   * leave two attempts racing on the same working directory" — and produced
   * exactly that for a DERIVED orphan. The guard reads the derived status
   * (`orphaned`, so it passes), while `claimNextJob` filters on the raw status
   * file, which still says `queued`. So a supervisor could claim the original
   * while the retry ran.
   *
   * `cancelJob` was taught to tell the two kinds of orphan apart; retry was
   * not, so that fix stopped one square short. Marking the original cancelled
   * is what closes it — claimNextJob refuses a marked job.
   */
  it("marks the original cancelled so nothing can reclaim it", async () => {
    const jobId = "job-1700000000901-aaaaaaaa";
    const dir = path.join(jobsDir, jobId);
    await fs.mkdir(path.join(dir, "output"), { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), "do a thing", "utf8");
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        jobId, createdAt: new Date().toISOString(), workingDir: dir,
        promptPath: path.join(dir, "prompt.md"), files: [], service: "fake",
      }),
      "utf8",
    );
    // Raw status `queued`, heartbeat stale: derived orphan, still claimable.
    await fs.writeFile(
      path.join(dir, "status.json"),
      JSON.stringify({
        jobId, status: "queued", jobDir: dir,
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        updatedAt: new Date(Date.now() - 600_000).toISOString(),
      }),
      "utf8",
    );

    const { getAsyncJob } = await import("../src/jobs.js");
    expect((await getAsyncJob(jobId)).status.status).toBe("orphaned");

    await retryJob(jobId, await buildDeps());

    const raw = JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8"));
    expect(raw.status, "the original stayed claimable while a retry ran").toBe("cancelled");
  });
});
