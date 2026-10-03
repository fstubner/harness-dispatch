/**
 * The processes a job starts, and stopping them when its supervisor is gone.
 *
 * Only the supervisor's own pid was recorded (claim.json), so when it died the
 * job read orphaned while its agent CLI could go on running — and `cancel_job`
 * on the orphan marked it cancelled and killed nothing. Observed in the field:
 * an Antigravity child outliving its cancelled job.
 *
 * Also here: a cancelled run reaches the dispatch log. A cancel bypasses the
 * router so the breaker is not charged, and that kept it out of the log too.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelJob, startAsyncJobTracked } from "../src/jobs.js";
import { dispatchLogPath } from "../src/dispatch-log.js";
import { processAlive } from "../src/jobs/store.js";
import { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let jobsDir: string;
const strays: ChildProcess[] = [];

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-children-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of strays.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
});

function sleeper(ms: number): ChildProcess {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], {
    stdio: "ignore",
    windowsHide: true,
  });
  strays.push(child);
  return child;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

function readStatus(jobDir: string): { status: string; children?: Array<{ pid: number; command: string }> } {
  return JSON.parse(readFileSync(path.join(jobDir, "status.json"), "utf8"));
}

describe("a running job", () => {
  it("records the processes it started while they run, and drops them when they exit", async () => {
    let childPid: number | undefined;
    const router = {
      stream: async function* () {
        const child = sleeper(1_500);
        await new Promise((r) => child.once("spawn", r));
        childPid = child.pid;
        yield { event: { type: "stdout", chunk: "started" }, decision: null };
        await new Promise((r) => child.once("exit", r));
        yield {
          event: { type: "completion", result: { output: "done", service: "fake", success: true } },
          decision: null,
        };
      },
    };
    const holder = new RuntimeHolder({ config: { services: {} }, router } as never);
    const { status, completion } = await startAsyncJobTracked({ holder }, { prompt: "p", workingDir: jobsDir });

    const recorded = await waitFor(
      () => childPid !== undefined && (readStatus(status.jobDir).children ?? []).some((c) => c.pid === childPid),
      5_000,
    );
    expect(recorded, "the running job's status never named the process it started").toBe(true);
    await completion;
    expect(readStatus(status.jobDir).children).toBeUndefined();
  }, 20_000);
});

describe("cancelling an orphaned job", () => {
  async function plantOrphan(children: unknown[]): Promise<string> {
    const jobId = "job-1700000000301-aaaaaaaa";
    const dir = path.join(jobsDir, jobId);
    await fs.mkdir(path.join(dir, "output"), { recursive: true });
    const old = new Date(Date.now() - 600_000).toISOString();
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ jobId, createdAt: old, workingDir: dir, promptPath: "", files: [], caller: { client: "probe-client", session: "s-1" } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "status.json"),
      JSON.stringify({ jobId, status: "running", createdAt: old, updatedAt: old, jobDir: dir, route: "fake_cli", children }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "claim.json"), JSON.stringify({ pid: 0x7ffffffe, at: old }), "utf8");
    return jobId;
  }

  it("stops the agent process its dead supervisor left running", async () => {
    const child = sleeper(60_000);
    await new Promise((r) => child.once("spawn", r));
    const jobId = await plantOrphan([{ pid: child.pid, command: "node", startedAt: new Date().toISOString() }]);

    const out = await cancelJob(jobId);

    expect(out.outcome).toBe("cancelled");
    expect(out.message).toContain(String(child.pid));
    expect(await waitFor(() => !processAlive(child.pid!), 5_000), "the orphan's process is still running").toBe(true);
  }, 30_000);

  it("spares a process whose pid was reused since it was recorded", async () => {
    // A pid is a number the OS hands out again. A live process whose start
    // time does not match the recorded one is someone else's.
    const child = sleeper(60_000);
    await new Promise((r) => child.once("spawn", r));
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const jobId = await plantOrphan([{ pid: child.pid, command: "node", startedAt: anHourAgo }]);

    await cancelJob(jobId);

    await new Promise((r) => setTimeout(r, 500));
    expect(processAlive(child.pid!), "an unrelated process with a reused pid was killed").toBe(true);
  }, 30_000);

  it("logs the cancelled run with who asked for it", async () => {
    const jobId = await plantOrphan([]);
    await cancelJob(jobId, "gave up");
    const rows = readFileSync(dispatchLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const row = rows.find((r) => r.jobId === jobId);
    expect(row, "a cancelled run left no dispatch-log line").toBeDefined();
    expect(row).toMatchObject({ route: "fake_cli", success: false, reason: "cancelled", client: "probe-client", session: "s-1" });
  });
});

describe("cancelling a running job", () => {
  it("logs it, with the job and the reason", async () => {
    const router = {
      stream: async function* (_p: unknown, _f: unknown, _w: unknown, opts?: { signal?: AbortSignal }) {
        yield { event: { type: "stdout", chunk: "working" }, decision: null };
        await new Promise((r) => opts?.signal?.addEventListener("abort", r));
      },
    };
    const holder = new RuntimeHolder({ config: { services: {} }, router } as never);
    const { status, completion } = await startAsyncJobTracked(
      { holder },
      { prompt: "p", workingDir: jobsDir, caller: { client: "probe-client" } },
    );
    await waitFor(() => readStatus(status.jobDir).status === "running", 5_000);
    await cancelJob(status.jobId, "changed my mind");
    await completion;
    const rows = readFileSync(dispatchLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const row = rows.find((r) => r.jobId === status.jobId);
    expect(row, "a cancelled run left no dispatch-log line").toBeDefined();
    expect(row).toMatchObject({ success: false, reason: "cancelled", client: "probe-client" });
    expect(String(row!.error)).toContain("changed my mind");
  }, 20_000);
});
