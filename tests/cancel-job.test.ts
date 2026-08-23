/**
 * Stopping work you already started.
 *
 * Until this existed the product could start a 60-minute detached run and
 * offer no way to stop it: the surface was dispatch/job_status/usage, so a
 * misdirected agent kept spending subscription quota and editing a workspace
 * until it finished or timed out.
 *
 * Cancellation is cooperative rather than a signal, and that is forced by the
 * architecture: jobs run inside POOLED supervisors, so the only pid recorded
 * against a job belongs to a process running other jobs too. These tests pin
 * the behaviour that matters to a caller — a queued job stops outright, a
 * finished one is a harmless no-op, a stranger is an error, and a cancelled
 * run is NOT recorded as a route failure.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelJob } from "../src/jobs.js";

let jobsDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-cancel-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true });
});

/** Plant a job on disk in a given state, the way a real run leaves one. */
async function plantJob(
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(jobsDir, jobId);
  await fs.mkdir(path.join(dir, "output"), { recursive: true });
  await fs.writeFile(path.join(dir, "prompt.md"), "do a thing", "utf8");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ jobId, createdAt: new Date().toISOString(), workingDir: dir, promptPath: path.join(dir, "prompt.md"), files: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({
      jobId,
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobDir: dir,
      ...extra,
    }),
    "utf8",
  );
  return dir;
}

describe("cancelJob", () => {
  it("stops a queued job outright — it never started, so there is nothing to tear down", async () => {
    const dir = await plantJob("job-1700000000001-aaaaaaaa", "queued", { slotQueued: true });

    const out = await cancelJob("job-1700000000001-aaaaaaaa", "sent to the wrong directory");

    expect(out.outcome).toBe("cancelled");
    expect(out.status).toBe("cancelled");
    const status = JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8")) as {
      status: string;
      error: string;
    };
    expect(status.status).toBe("cancelled");
    // The reason is recorded so a later reader knows it was deliberate rather
    // than that the job mysteriously died.
    expect(status.error).toContain("sent to the wrong directory");
  });

  it("requests teardown for a running job and says it is not instant", async () => {
    await plantJob("job-1700000000002-bbbbbbbb", "running");

    const out = await cancelJob("job-1700000000002-bbbbbbbb");

    expect(out.outcome).toBe("cancelling");
    // The marker is what a live runner polls for.
    const marker = path.join(jobsDir, "job-1700000000002-bbbbbbbb", "cancel.json");
    expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(true);
    // A caller who assumes "cancelled" would be wrong twice over, so the
    // message has to say both things.
    expect(out.message).toMatch(/poll/i);
    expect(out.message).toMatch(/NOT reverted/);
  });

  it.each(["completed", "failed", "orphaned"])(
    "is a harmless no-op on an already-%s job",
    async (state) => {
      await plantJob(`job-1700000000003-cccccccc`, state);
      const out = await cancelJob("job-1700000000003-cccccccc");
      expect(out.outcome).toBe("already_finished");
      expect(out.status).toBe(state);
      // No marker written — nothing is going to read it, and leaving one
      // behind would make a finished job look cancellable forever.
      const marker = path.join(jobsDir, "job-1700000000003-cccccccc", "cancel.json");
      expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(false);
    },
  );

  it("reports a job that never existed the same way job_status does", async () => {
    await expect(cancelJob("job-1700000000009-deadbeef")).rejects.toThrow(/No such job/);
  });

  it("rejects a malformed jobId as malformed, not as missing", async () => {
    await expect(cancelJob("../../etc/passwd")).rejects.toThrow(/Invalid jobId/);
  });

  it("does not write a result payload, so the route is never charged a failure", async () => {
    // A cancellation says nothing about whether the route works. If it were
    // recorded as a failure it would count toward the circuit breaker and
    // toward `usage`, so a caller changing their mind five times would trip a
    // healthy route out of rotation.
    const dir = await plantJob("job-1700000000004-dddddddd", "queued");
    await cancelJob("job-1700000000004-dddddddd");
    const resultExists = await fs
      .stat(path.join(dir, "output", "result.json"))
      .then(() => true)
      .catch(() => false);
    expect(resultExists).toBe(false);
  });
});

describe("cancelJob — end to end against a real run", () => {
  /**
   * The claim that actually matters: a RUNNING job stops. Everything above
   * verifies bookkeeping; this drives a dispatch through the real job path
   * with a dispatcher that would otherwise stream for a long time, cancels
   * it, and waits for the job to reach a terminal state on disk.
   *
   * It also covers the case a for-await loop could not: the stream is SILENT
   * while cancellation arrives. That is precisely the run most worth
   * cancelling — an agent that has gone quiet — and it is why runJob drives
   * an explicit iterator raced against a poll rather than a for-await.
   */
  it("stops a running job that is producing no output", async () => {
    const { startAsyncJobTracked, getAsyncJob } = await import("../src/jobs.js");
    const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");

    let aborted = false;
    // A dispatcher that yields nothing and never finishes on its own — the
    // run most worth cancelling. It watches the ABORT SIGNAL, because that is
    // what actually stops a real child: a real dispatcher hands the signal to
    // streamSubprocess (killTree) or to fetch. Asserting on iterator.return()
    // instead would pass against code that cannot stop a silent agent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stuckDispatcher: any = {
      id: "stuck",
      async dispatch() {
        throw new Error("not used");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream(_p: string, _f: string[], _w: string, opts?: { signal?: AbortSignal }): AsyncIterable<any> {
        opts?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => undefined), // never resolves
            return: async () => ({ value: undefined, done: true as const }),
          }),
        };
      },
      async checkQuota() {
        return { service: "stuck", source: "unknown" as const };
      },
      isAvailable: () => true,
    };

    const svc = {
      name: "stuck", enabled: true, type: "cli" as const, harness: "stuck", command: "stuck",
      tier: 1, weight: 1, cliCapability: 1, capabilities: { execute: 1, plan: 1, review: 1 },
      escalateOn: [], leaderboardModel: "stuck-model", maxOutputTokens: 1000, maxInputTokens: 1000,
      provider: "local" as const, surface: "local_endpoint" as const, authSource: "local_network" as const,
      billingKind: "local_compute" as const, paidUsagePossible: false, billingConfidence: "documented" as const,
    };
    const { Router } = await import("../src/router.js");
    const { QuotaCache } = await import("../src/quota.js");
    const { LeaderboardCache } = await import("../src/leaderboard.js");
    const config = { services: { stuck: svc } };
    const dispatchers = { stuck: stuckDispatcher } as never;
    const quota = new QuotaCache(dispatchers, { stateFile: ":memory-cancel:" });
    const leaderboard = new LeaderboardCache();
    const router = new Router(config as never, quota, dispatchers, leaderboard);
    const holder = new RuntimeHolder({
      config, dispatchers, quota, router, leaderboard, mtimeMs: 0,
    } as never);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-cancel-work-"));
    try {
      const { status, completion } = await startAsyncJobTracked(
        { holder } as never,
        { prompt: "run forever", service: "stuck", workingDir: workDir },
      );

      // Let it reach "running" before cancelling.
      await new Promise((r) => setTimeout(r, 150));
      const out = await cancelJob(status.jobId, "test");
      expect(out.outcome).toBe("cancelling");

      await completion;

      const job = await getAsyncJob(status.jobId);
      expect(job.status.status).toBe("cancelled");
      expect(job.status.error).toContain("test");
      // The abort reached the dispatcher — this is the signal a real
      // dispatcher forwards to killTree (CLI routes) or fetch (endpoints).
      expect(aborted, "the dispatcher never saw the abort signal").toBe(true);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a cancelled job is terminal", () => {
  /**
   * `completed` is the field the tool descriptions tell an agent to branch on.
   * jobCompleted() listed completed/failed/orphaned and NOT `cancelled`, so a
   * caller that cancelled a job and then polled it was answered
   * `completed: false`, `nextPollSeconds: 300`, and "check again until status
   * is completed or failed" — forever, for a job that had already stopped at
   * its own request.
   */
  it("reports completed: true so an orchestrator stops polling", async () => {
    await plantJob("job-1700000000009-99999999", "cancelled", {
      error: "Cancelled: terminal-state probe",
    });
    const { invokeTool } = await import("../src/mcp/tools.js");

    const invoked = await invokeTool(
      "job_status",
      { jobId: "job-1700000000009-99999999" },
      {} as never,
    );
    const res = (invoked as { data: unknown }).data as {
      completed: boolean;
      status: { status: string };
      instructions?: string;
    };

    expect(res.status.status).toBe("cancelled");
    expect(res.completed, "a cancelled job told the caller to keep polling").toBe(true);
    expect(res.instructions ?? "").not.toMatch(/check again/i);
  });
});
