/**
 * Global test setup: sandbox all filesystem side channels away from the
 * user's real ~/.harness-dispatch. Without this, router tests with stub
 * dispatchers append their fake routes to the REAL dispatch log (observed:
 * 17 junk entries from one suite run) and QuotaCache's default state file
 * (observed: hundreds of fake "claude_code"/"typo_cli" counts accumulating
 * in quota_state.json across runs before HARNESS_DISPATCH_STATE_DIR existed).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HARNESS_DISPATCH_LOG_DIR = mkdtempSync(
  path.join(os.tmpdir(), "hr-test-logs-"),
);
process.env.HARNESS_DISPATCH_STATE_DIR = mkdtempSync(
  path.join(os.tmpdir(), "hr-test-state-"),
);
// Jobs too: suites that exercise startAsyncJob without their own stub (the
// http/mcp server tests) were writing REAL job dirs into the user's
// ~/.harness-dispatch/jobs, which then polluted every job_status list in
// live sessions (observed: a dozen junk "route: a" entries).
process.env.HARNESS_DISPATCH_JOBS_DIR = mkdtempSync(
  path.join(os.tmpdir(), "hr-test-jobs-"),
);
