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

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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
