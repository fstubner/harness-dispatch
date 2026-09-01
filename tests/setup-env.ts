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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Config too — the side channel that costs MONEY rather than tidiness.
 *
 * The three above sandbox where the suite WRITES. This one sandboxes what it
 * DISCOVERS. A test that loads config without stubbing `whichFn` and without
 * naming a file gets the shipped defaults filtered by which harness CLIs are
 * on PATH — so on a maintainer's machine it silently acquires claude_code_cli,
 * codex_cli, cursor_cli and antigravity_cli, and a dispatch from there spends
 * real subscription quota.
 *
 * That is not hypothetical. One boundary test dispatched to the real Claude
 * Code on every `npm test` and every CI run, measured at 6.4s and 47k input
 * tokens, under a comment asserting it could not reach a route. Making a
 * route-defining config authoritative fixed that test; it did not close the
 * class, because a config that names no routes still auto-detects — by design,
 * and correctly.
 *
 * `detect: false` is the explicit "no routes at all" setting, so any
 * un-stubbed load lands on an empty route table instead of the real fleet. A
 * test that wants routes passes its own config path, which still wins: this is
 * the LAST rung of the precedence ladder, below an explicit --config.
 *
 * Deliberately a guard rather than a check. The natural evidence for this
 * failure is the dispatch log, which line 29 redirects — so an unnoticed
 * regression here cannot be spotted by looking, only by instrumenting PATH.
 * Making it impossible costs three lines; noticing it costs a bespoke run
 * nobody remembers to do.
 */
const configSandbox = sandbox("hr-test-config-");
const isolatedConfig = path.join(configSandbox, "config.yaml");
writeFileSync(isolatedConfig, "detect: false\n", "utf8");
process.env.HARNESS_DISPATCH_CONFIG = isolatedConfig;

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
