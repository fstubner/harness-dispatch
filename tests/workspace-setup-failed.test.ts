/**
 * When an isolated workspace cannot be set up, `workspace` has to say so.
 *
 * A `git_worktree` dispatch whose setup failed (git refusing an over-long
 * workspaces path, a project that is not a repository) leaves a job with no
 * workspace record at all. `workspace` then answered "no isolated workspace
 * (workspace policy: shared)", naming a policy nobody asked for and not
 * mentioning the failure.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { throwawayQuotaStateFile } from "./support/fixtures.js";

let jobsDir: string;
let workDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-wsfail-jobs-"));
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-wsfail-work-")));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  vi.stubEnv("HARNESS_DISPATCH_WORKSPACES_DIR", path.join(jobsDir, "workspaces"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Run a job under `policy` in `workDir`, with a route that would succeed if it were ever started. */
async function runJobUnder(policy: string, gate?: Promise<void>): Promise<string> {
  const { startAsyncJobTracked } = await import("../src/jobs.js");
  const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");
  const { Router } = await import("../src/router.js");
  const { QuotaCache } = await import("../src/quota.js");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fine: any = {
    id: "fine",
    async dispatch() {
      throw new Error("not used");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream(): AsyncIterable<any> {
      return {
        [Symbol.asyncIterator]: () => {
          let done = false;
          return {
            next: async () => {
              await gate;
              if (done) return { value: undefined, done: true as const };
              done = true;
              return {
                value: { type: "completion", result: { output: "ok", service: "fine", success: true, durationMs: 1 } },
                done: false as const,
              };
            },
          };
        },
      };
    },
    async checkQuota() {
      return { service: "fine", source: "unknown" as const };
    },
    isAvailable: () => true,
  };
  const svc = {
    name: "fine", enabled: true, type: "cli" as const, harness: "fine", command: "fine",
    tier: 1, weight: 1, cliCapability: 1, capabilities: { execute: 1, plan: 1, review: 1 },
    escalateOn: [], maxOutputTokens: 1000, maxInputTokens: 1000,
    provider: "local" as const, surface: "local_endpoint" as const, authSource: "local_network" as const,
    billingKind: "local_compute" as const, paidUsagePossible: false, billingConfidence: "documented" as const,
  };
  const config = { services: { fine: svc } };
  const dispatchers = { fine } as never;
  const quota = new QuotaCache(dispatchers, { stateFile: throwawayQuotaStateFile() });
  const router = new Router(config as never, quota, dispatchers);
  const holder = new RuntimeHolder({ config, dispatchers, quota, router, mtimeMs: 0 } as never);

  const { status, completion } = await startAsyncJobTracked({ holder } as never, {
    prompt: "do it",
    service: "fine",
    workingDir: workDir,
    workspacePolicy: policy,
    hints: { safetyProfile: "full_auto" },
  } as never);
  if (gate === undefined) await completion;
  return status.jobId;
}

describe("a job whose isolated workspace could not be set up", () => {
  it("names the policy that was requested and says the run never got one", async () => {
    // workDir is not a git repository, so a git_worktree workspace cannot exist.
    const jobId = await runJobUnder("git_worktree");
    const { getAsyncJob } = await import("../src/jobs.js");
    const job = await getAsyncJob(jobId);
    expect(job.status.status, "the setup failure should have failed the job").toBe("failed");

    const { resolveJobWorkspace } = await import("../src/jobs/lifecycle.js");
    const err = await resolveJobWorkspace(jobId, "apply").then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("workspace policy 'git_worktree'");
    expect(err?.message).toContain("the run never got one");
    expect(err?.message).not.toMatch(/policy: shared/);
  }, 60_000);

  it("still describes a genuinely shared job as shared", async () => {
    const jobId = await runJobUnder("shared");
    const { resolveJobWorkspace } = await import("../src/jobs/lifecycle.js");
    const err = await resolveJobWorkspace(jobId, "apply").then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/workspace policy: shared\)/);
    expect(err?.message).not.toContain("the run never got one");
  }, 60_000);

  it("says a job that is still running has not finished, not that setup failed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobId = await runJobUnder("copy", gate);
    const { resolveJobWorkspace } = await import("../src/jobs/lifecycle.js");
    const { getAsyncJob } = await import("../src/jobs.js");
    try {
      // Wait until the run is under way, so the workspace exists but is not recorded yet.
      for (let i = 0; i < 100 && (await getAsyncJob(jobId)).status.status !== "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const err = await resolveJobWorkspace(jobId, "diff").then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain("has not finished");
      expect(err?.message).not.toContain("never got one");
    } finally {
      release();
    }
  }, 60_000);
});
