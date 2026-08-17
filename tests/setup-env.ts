/**
 * Global test setup: sandbox all filesystem side channels away from the
 * user's real ~/.harness-dispatch. Without this, router tests with stub
 * dispatchers append their fake routes to the REAL dispatch log (observed:
 * 17 junk entries from one suite run) and QuotaCache's default state file
 * (observed: hundreds of fake "claude_code"/"typo_cli" counts accumulating
 * in quota_state.json across runs before HARNESS_DISPATCH_STATE_DIR existed).
 *
 * Each of these dirs is removed again in afterAll. Vitest runs this file once
 * per test FILE, not once per run, so a 33-file suite created 99 temp
 * directories and deleted none of them. Measured 2026-08-17 after a day of
 * repeated runs: 2,605 orphaned directories and a full disk (0 bytes free on
 * a 931 GB volume). Leaking scratch state is not a cosmetic problem when the
 * suite is run in a loop, which is exactly how it is run.
 */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];

function sandbox(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

process.env.HARNESS_DISPATCH_LOG_DIR = sandbox("hr-test-logs-");
process.env.HARNESS_DISPATCH_STATE_DIR = sandbox("hr-test-state-");
// Jobs too: suites that exercise startAsyncJob without their own stub (the
// http/mcp server tests) were writing REAL job dirs into the user's
// ~/.harness-dispatch/jobs, which then polluted every job_status list in
// live sessions (observed: a dozen junk "route: a" entries).
process.env.HARNESS_DISPATCH_JOBS_DIR = sandbox("hr-test-jobs-");
// Unit tests inject fake dispatchers through an in-memory RuntimeHolder — a
// detached runner process could never see those, so jobs run in-process
// here. The detached path gets its own end-to-end coverage in
// tests/job-runner.test.ts against the real dist/ build.
process.env.HARNESS_DISPATCH_INPROC_JOBS = "1";

afterAll(() => {
  for (const dir of sandboxes) {
    // force: a detached runner from the concurrency suite can still hold a
    // handle here on Windows. Best-effort cleanup must never fail a green run.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Leave it for the OS; one stale dir is better than a failed suite.
    }
  }
});
