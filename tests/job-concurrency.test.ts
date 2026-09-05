/**
 * Concurrency bound on detached job runners.
 *
 * These tests deliberately opt OUT of HARNESS_DISPATCH_INPROC_JOBS (set
 * globally in setup-env.ts) because the gate lives on the detached path only
 * — an in-process job never spawns a runner and so never consumes a slot.
 * Testing this against the in-process path would assert nothing.
 *
 * Field incident being pinned (2026-08-03): 20 dispatches to one route, 13
 * running at once, 10 failures, one Rust OOM inside Codex. Nothing anywhere
 * counted concurrent runs.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, startAsyncJobTracked, type JobDeps } from "../src/jobs.js";
import { loadConfig } from "../src/config.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "job-runner.js",
);

let tmpDir: string;
let jobsDir: string;
let configPath: string;

/** A route that is just `node -e "<sleep then print>"` — no external CLI needed. */
async function writeConfig(maxConcurrentRuns: number, sleepMs: number): Promise<string> {
  const file = path.join(tmpDir, "config.yaml");
  const script = `setTimeout(() => console.log('done ' + process.argv[1]), ${sleepMs})`;
  await fs.writeFile(
    file,
    [
      `max_concurrent_runs: ${maxConcurrentRuns}`,
      "clis:",
      "  - name: slow_node",
      "    harness: generic",
      "    command: node",
      "    tier: 3",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    protocol:",
      `      args: ["-e", ${JSON.stringify(script)}, "{{prompt}}"]`,
      "      output: { mode: text }",
    ].join("\n"),
    "utf8",
  );
  return file;
}

async function deps(): Promise<JobDeps> {
  const config = await loadConfig(configPath);
  const holder = { state: { config, configPath } } as unknown as RuntimeHolder;
  return { holder };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-slots-"));
  jobsDir = path.join(tmpDir, "jobs");
  await fs.mkdir(jobsDir, { recursive: true });
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
});

/**
 * Wait until no supervisor process is still alive in this test's jobs root.
 *
 * A supervisor OUTLIVES the jobs it runs — that is the point of pooling it —
 * so awaiting `completion` says nothing about whether the process is gone. It
 * stays up until it has been idle for SUPERVISOR_IDLE_EXIT_MS, holding an open
 * stdio handle on `<jobs>/.supervisors/spawn-<id>.log` the whole time. Deleting
 * the tree under it raced that: on Windows an open handle blocks the delete and
 * the rmdir fails with ENOTEMPTY, surfacing as a failure of whichever test
 * happened to run last. Seen on the windows-latest CI runner, which is slow
 * enough to widen the window; the race exists on every platform.
 *
 * Liveness is read from the `<id>.txt` heartbeats, which a supervisor rewrites
 * several times a second and deletes on its way out. The `spawn-*.log` files
 * are deliberately NOT counted: nothing ever removes them, so waiting for the
 * directory to be empty would wait forever — which is how the first attempt at
 * this fix timed out instead of fixing anything.
 *
 * A heartbeat that has stopped advancing means the process died without
 * cleaning up. That is counted as gone rather than waited on, so a crashed
 * supervisor cannot hang teardown. The ceiling bounds the pathological case and
 * falls through to the retrying rm below rather than failing an innocent test.
 */
const BEAT_STALE_MS = 3_000;

async function waitForSupervisorsToExit(ceilingMs = 30_000): Promise<void> {
  const beatDir = path.join(jobsDir, ".supervisors");
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    let live = 0;
    try {
      for (const name of await fs.readdir(beatDir)) {
        if (!name.endsWith(".txt")) continue; // spawn-*.log is never cleaned up
        const st = await fs.stat(path.join(beatDir, name)).catch(() => null);
        if (st !== null && Date.now() - st.mtimeMs < BEAT_STALE_MS) live += 1;
      }
    } catch {
      return; // never created, or already cleaned up
    }
    if (live === 0 || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await waitForSupervisorsToExit();
  // maxRetries matches every other suite here: covers the brief lag between a
  // process exiting and Windows releasing its handles, which no amount of
  // waiting on our own bookkeeping can observe.
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
}, 60_000);

describe.skipIf(!existsSync(RUNNER))("detached run concurrency bound", () => {
  it("holds a dispatch past the limit in slotQueued instead of spawning a runner", async () => {
    configPath = await writeConfig(1, 3_000);
    const d = await deps();

    const first = await startAsyncJobTracked(d, { prompt: "one", workingDir: tmpDir, service: "slow_node" });
    const second = await startAsyncJobTracked(d, { prompt: "two", workingDir: tmpDir, service: "slow_node" });

    // First got the only slot; second is explicitly waiting for one.
    expect(first.status.slotQueued).toBeUndefined();
    expect(second.status.slotQueued).toBe(true);
    expect(second.status.status).toBe("queued");

    // The caller still has a usable jobId — the API contract is unchanged,
    // only the start time moved.
    expect(second.status.jobId).toMatch(/^job-\d+-[0-9a-f]{8}$/);

    // No runner was spawned for it: a spawned runner writes output/runner.log.
    expect(existsSync(path.join(second.status.jobDir, "output", "runner.log"))).toBe(false);

    await Promise.allSettled([first.completion, second.completion]);
  }, 60_000);

  it("runs uncapped jobs through the pool rather than a runner process each", async () => {
    // `max_concurrent_runs: 0` means "no cap", and it used to mean "no pool"
    // as well: every job got its own detached runner at ~76 MB, which is the
    // per-job wrapper cost the pool exists to remove — on the memory-bound
    // machine the cap exists for in the first place. Measured under load
    // before this was fixed: 8 concurrent dispatches, 8 runner processes.
    //
    // A spawned per-job runner writes output/runner.log; a pooled supervisor
    // does not. That file is the tell, and it is what the sibling test above
    // uses to prove the opposite case.
    configPath = await writeConfig(0, 500);
    const d = await deps();

    const jobs = await Promise.all(
      ["a", "b", "c"].map((p) =>
        startAsyncJobTracked(d, { prompt: p, workingDir: tmpDir, service: "slow_node" }),
      ),
    );

    // Uncapped: nothing waits for a slot.
    for (const job of jobs) {
      expect(job.status.slotQueued, "an uncapped dispatch was made to wait").toBeUndefined();
    }

    await Promise.allSettled(jobs.map((j) => j.completion));

    for (const job of jobs) {
      expect(
        existsSync(path.join(job.status.jobDir, "output", "runner.log")),
        "an uncapped job spawned its own runner instead of going through the pool",
      ).toBe(false);
    }
  }, 60_000);

  it("a waiting job is reported as queued, never as orphaned", async () => {
    // The staleness rule flags a `queued` job whose heartbeat is >90s old as
    // orphaned. Nothing heartbeats for a slot-queued job by design, so
    // without the slotQueued exemption this reports a job that is merely
    // waiting its turn as dead. Backdate to prove the exemption, rather than
    // sleeping 90s.
    configPath = await writeConfig(1, 3_000);
    const d = await deps();

    const first = await startAsyncJobTracked(d, { prompt: "one", workingDir: tmpDir, service: "slow_node" });
    const second = await startAsyncJobTracked(d, { prompt: "two", workingDir: tmpDir, service: "slow_node" });

    const statusFile = path.join(second.status.jobDir, "status.json");
    const raw = JSON.parse(await fs.readFile(statusFile, "utf8")) as Record<string, unknown>;
    raw["updatedAt"] = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await fs.writeFile(statusFile, JSON.stringify(raw), "utf8");

    const seen = await getAsyncJob(second.status.jobId);
    expect(seen.status.status).toBe("queued");
    expect(seen.status.status).not.toBe("orphaned");

    await Promise.allSettled([first.completion, second.completion]);
  }, 60_000);

  it("the queued job starts and completes once the running one frees its slot", async () => {
    configPath = await writeConfig(1, 500);
    const d = await deps();

    const first = await startAsyncJobTracked(d, { prompt: "one", workingDir: tmpDir, service: "slow_node" });
    const second = await startAsyncJobTracked(d, { prompt: "two", workingDir: tmpDir, service: "slow_node" });
    expect(second.status.slotQueued).toBe(true);

    // Nothing else touches the queue here — the drain happens inside the
    // first runner as it exits, which is the mechanism under test.
    await Promise.all([first.completion, second.completion]);

    const done = await getAsyncJob(second.status.jobId);
    expect(done.status.status).toBe("completed");
    expect(done.result?.result.success).toBe(true);
    expect(done.result?.result.output).toContain("done two");
  }, 90_000);

  it("max_concurrent_runs: 0 disables the bound entirely", async () => {
    configPath = await writeConfig(0, 200);
    const d = await deps();

    const jobs = await Promise.all(
      ["a", "b", "c"].map((p) => startAsyncJobTracked(d, { prompt: p, workingDir: tmpDir, service: "slow_node" })),
    );
    for (const job of jobs) expect(job.status.slotQueued).toBeUndefined();

    await Promise.allSettled(jobs.map((j) => j.completion));
  }, 60_000);
});

describe.skipIf(!existsSync(RUNNER))("a supervisor picks up config edits before claiming work", () => {
  it("stops running a route that has been removed from the config", async () => {
    // A pooled supervisor OUTLIVES the server that spawned it, by design. It
    // also outlived the server's CONFIG: restart with a route removed,
    // dispatch inside the ~5s idle window, and the old supervisor claimed the
    // job and ran the removed route, reporting plain success with nothing in
    // the response signalling the split. For those seconds `disabled:`,
    // `allow_paid_usage` and safety profiles were not the controls they appear
    // to be — against this product's own "never spend money silently".
    configPath = await writeConfig(1, 200);
    const d = await deps();

    // A first dispatch, so a supervisor exists and is alive.
    const first = await startAsyncJobTracked(d, {
      prompt: "one",
      workingDir: tmpDir,
      service: "slow_node",
    });
    await first.completion.catch(() => undefined);

    // Remove the route, exactly as an operator editing their config would.
    // The sleep is for mtime granularity, not for the reloader.
    await new Promise((r) => setTimeout(r, 1100));
    await fs.writeFile(configPath, ["max_concurrent_runs: 1", "clis: []", ""].join("\n"), "utf8");
    const after = await loadConfig(configPath);
    expect(Object.keys(after.services)).not.toContain("slow_node");

    // Give the still-live supervisor a poll or two to notice.
    await new Promise((r) => setTimeout(r, 1500));

    // A supervisor holding the OLD config would happily run this.
    const holder = { state: { config: after, configPath } } as unknown as RuntimeHolder;
    const second = await startAsyncJobTracked(
      { holder },
      { prompt: "two", workingDir: tmpDir, service: "slow_node" },
    );
    await second.completion.catch(() => undefined);
    const job = await getAsyncJob(second.status.jobId);
    const outcome = job.result?.result;

    expect(
      outcome?.success,
      `a route removed from the config still ran: ${JSON.stringify(outcome)}`,
    ).not.toBe(true);
  }, 90_000);
});

describe("concurrency bound — runner not built", () => {
  it("is skipped when dist/job-runner.js is absent, and says so", () => {
    // Guard against the F20 failure mode: a suite that silently reports green
    // because the artifact it needs was never built. If this ever runs
    // without dist/, the skip above hid the real tests — make that visible
    // rather than counting it as a pass.
    expect(
      existsSync(RUNNER) ||
        "dist/job-runner.js missing — concurrency tests did NOT run; `npm run build` first",
    ).toBe(true);
  });
});

describe("dead supervisor heartbeats are cleaned up", () => {
  /**
   * A supervisor that exits cleanly deletes its own heartbeat; one that is
   * KILLED cannot. Those files stopped being COUNTED but stayed on disk
   * forever, and the liveness check reads every file in the directory on
   * every drain — so each hard kill left a permanent cost paid by every
   * dispatch afterwards.
   *
   * The sweep is deliberately limited to `<id>.txt`. The same directory holds
   * `spawn-<id>.log`, the bootstrap output that exists to explain a
   * supervisor that DIED — i.e. the very supervisor whose heartbeat is
   * stale. A sweep over every file would delete the diagnostic for the
   * failure it was cleaning up after.
   */
  it("removes a stale heartbeat but keeps the crash log beside it", async () => {
    const { countLiveSupervisorsForTest } = await import("../src/jobs.js");
    const dir = path.join(jobsDir, ".supervisors");
    await fs.mkdir(dir, { recursive: true });

    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(path.join(dir, "9991.txt"), stale, "utf8");
    await fs.writeFile(path.join(dir, "spawn-9991.log"), "Error: bad config\n", "utf8");
    await fs.writeFile(path.join(dir, "9992.txt"), new Date().toISOString(), "utf8");

    const live = await countLiveSupervisorsForTest();
    expect(live).toBe(1);
    expect(existsSync(path.join(dir, "9991.txt"))).toBe(false);
    // The reason the dead one died must survive the cleanup.
    expect(existsSync(path.join(dir, "spawn-9991.log"))).toBe(true);
    expect(existsSync(path.join(dir, "9992.txt"))).toBe(true);
  });

  /**
   * The other half of that rule. Keeping a crash log is right because it
   * explains a death; keeping an EMPTY one explains nothing, and that is what
   * a supervisor which started and exited cleanly leaves behind.
   *
   * Measured before this existed: 129 spawn logs on the maintainer's machine
   * going back three weeks, zero live heartbeats, 780 bytes between them — six
   * bytes each. Two independent audits flagged the directory as growing
   * without bound, and the liveness check reads it on every drain, which is
   * the same permanent per-dispatch cost the heartbeat cleanup above removed.
   */
  it("drops an empty spawn log once it is stale, and keeps a fresh one", async () => {
    const { countLiveSupervisorsForTest } = await import("../src/jobs.js");
    const dir = path.join(jobsDir, ".supervisors");
    await fs.mkdir(dir, { recursive: true });

    const old = path.join(dir, "spawn-8881.log");
    await fs.writeFile(old, "", "utf8");
    const past = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(old, past, past);

    // Empty but recent: a live supervisor that has not written yet.
    await fs.writeFile(path.join(dir, "spawn-8882.log"), "", "utf8");
    // Stale but NOT empty: the diagnostic the sweep above exists to protect.
    const kept = path.join(dir, "spawn-8883.log");
    await fs.writeFile(kept, "Error: bad config\n", "utf8");
    await fs.utimes(kept, past, past);

    await countLiveSupervisorsForTest();

    expect(existsSync(old), "a stale empty log was kept").toBe(false);
    expect(existsSync(path.join(dir, "spawn-8882.log")), "a fresh log was deleted").toBe(true);
    expect(existsSync(kept), "a crash log with a reason in it was deleted").toBe(true);
  });
});
