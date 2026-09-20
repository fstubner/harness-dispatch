/**
 * The patch must outlive the workspace.
 *
 * An isolated workspace lives under the OS temp directory. Linux clears that
 * on reboot; WSL clears it whenever its VM idles out. A Linux acceptance pass
 * measured exactly that — an unapplied `git_worktree` workspace vanished
 * between two commands minutes apart, far inside the 24-hour retention window,
 * with nothing able to tell the user why.
 *
 * The recovery was supposed to exist already. The missing-workspace error told
 * the reader "the full patch is written to the job directory at dispatch
 * time", and `cachedPatch()` was written to read it back. Neither was true:
 * the patch appeared only when someone called `diff` or `apply`, and nothing
 * anywhere called `cachedPatch`. So the one sentence a user saw after losing
 * their work pointed at a file that had never been created.
 *
 * This file pins the job layer — that a finished isolated run leaves a patch
 * behind before anybody asks for one. The recovery behaviour built on it
 * (diff and apply serving the saved patch) is pinned in
 * workspace-resolve.test.ts.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let jobsDir: string;
let workDir: string;

beforeEach(async () => {
  jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-wspatch-"));
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-wspatch-proj-")));
  await fs.writeFile(path.join(workDir, "app.js"), "const a = 1;\n", "utf8");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3 });
});

/** A route whose "agent" edits a file in whatever directory it is given. */
async function buildDeps() {
  const { RuntimeHolder } = await import("../src/mcp/config-hot-reload.js");
  const { Router } = await import("../src/router.js");
  const { QuotaCache } = await import("../src/quota.js");
  const { LeaderboardCache } = await import("../src/leaderboard.js");

  const svc = {
    name: "editor", enabled: true, type: "cli" as const, harness: "editor", command: "editor",
    tier: 1, weight: 1, cliCapability: 1, capabilities: { execute: 1, plan: 1, review: 1 },
    escalateOn: [], maxOutputTokens: 1000, maxInputTokens: 1000,
    provider: "local" as const, surface: "local_endpoint" as const,
    authSource: "local_network" as const, billingKind: "local_compute" as const,
    paidUsagePossible: false, billingConfidence: "documented" as const,
  };
  const dispatcher = {
    id: "editor",
    async dispatch(_p: string, _f: string[], cwd: string) {
      await fs.writeFile(path.join(cwd, "app.js"), "const a = 2;\n", "utf8");
      return { output: "edited", service: "editor", success: true };
    },
    async *stream(_p: string, _f: string[], cwd: string) {
      await fs.writeFile(path.join(cwd, "app.js"), "const a = 2;\n", "utf8");
      await fs.writeFile(path.join(cwd, "added.js"), "export const b = 3;\n", "utf8");
      yield { type: "completion" as const, result: { output: "edited", service: "editor", success: true } };
    },
    async checkQuota() { return { service: "editor", source: "unknown" as const }; },
    isAvailable: () => true,
  };
  const config = { services: { editor: svc } };
  const dispatchers = { editor: dispatcher } as never;
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-wspatch:" });
  const leaderboard = new LeaderboardCache();
  const router = new Router(config as never, quota, dispatchers, leaderboard);
  return {
    holder: new RuntimeHolder({ config, dispatchers, quota, router, leaderboard, mtimeMs: 0 } as never),
  };
}

async function settle(jobId: string): Promise<void> {
  const { getAsyncJob } = await import("../src/jobs.js");
  for (let i = 0; i < 200; i += 1) {
    const job = await getAsyncJob(jobId).catch(() => undefined);
    const st = job?.status.status;
    if (st && ["completed", "failed", "orphaned", "cancelled"].includes(st)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("a finished isolated run leaves its patch beside the job", () => {
  it("writes workspace.patch before anyone asks for a diff", async () => {
    const { startAsyncJob } = await import("../src/jobs.js");
    const deps = await buildDeps();

    const started = await startAsyncJob(deps as never, {
      prompt: "edit the file",
      files: [],
      workingDir: workDir,
      workspacePolicy: "copy",
      hints: { taskType: "execute", safetyProfile: "full_auto" },
    } as never);
    await settle(started.jobId);

    // No diff, no apply — nothing has asked for a patch at any point.
    const patchPath = path.join(jobsDir, started.jobId, "output", "workspace.patch");
    expect(existsSync(patchPath), "no patch was saved when the run finished").toBe(true);

    const patch = await fs.readFile(patchPath, "utf8");
    expect(patch).toMatch(/app\.js/);
    expect(patch).toMatch(/added\.js/);
    expect(patch).toMatch(/const a = 2;/);

    // And the project itself is still untouched: saving a patch is not applying
    // one, and a save that leaked into the project would be far worse than the
    // gap it closes.
    expect(await fs.readFile(path.join(workDir, "app.js"), "utf8")).toBe("const a = 1;\n");
    expect(existsSync(path.join(workDir, "added.js"))).toBe(false);
  }, 60_000);
});
