/**
 * Run-wide setup: test the CURRENT source, and keep the whole run out of the
 * user's real state.
 *
 * BUILD. About twenty tests spawn the built artifact (dist/bin.js,
 * dist/job-runner.js). Only `npm test` used to build first; `npm run
 * test:unit`, `test:watch`, `test:parity` and a bare `vitest` ran against
 * whatever dist/ happened to be there — a stale one passed old code under new
 * tests, a missing one skipped the tests that needed it and reported green.
 * This builds when dist/ is missing or older than src/ and does nothing when
 * it is fresh.
 *
 * STATE. setup-env.ts sandboxes the log, state and jobs directories per test
 * FILE, but only inside the worker that loads it. Everything else in a run —
 * a process a test spawns with an environment of its own, a detached runner,
 * a resolver nobody thought to sandbox (the workspaces directory, the HTTP
 * token home) — fell back to `~/.harness-dispatch`. The maintainer's real
 * dispatch log carries 183 entries from routes only tests and scratch runs
 * ever defined (`slow_node`, `sleeper`, `fake_cli`, `echo_node`, …), and that
 * log is what `usage` history and every measurement of real use is read from.
 *
 * So the run as a whole gets one throwaway root, set here in the main process
 * before any worker exists, so every worker and every process spawned with an
 * inherited environment sees it:
 *
 *   - HOME / USERPROFILE point at a scratch home, so the LAST fallback —
 *     `os.homedir()/.harness-dispatch`, and the MCP client files `doctor`
 *     reads — is never the user's.
 *   - every harness-dispatch directory variable points inside the root, so
 *     nothing depends on the home fallback being reached at all.
 *
 * A test that needs its own directories still sets them; this is only the
 * default. tests/test-isolation.test.ts fails when any of it is not in place.
 * The full suite passed with HOME redirected before this was made the default
 * (measured 2026-10-08: 1,708 passed, 10 skipped).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every directory variable the product reads. Kept in step with src/ by test-isolation.test.ts. */
export const ISOLATED_DIR_VARS = {
  HARNESS_DISPATCH_STATE_DIR: "state",
  HARNESS_DISPATCH_LOG_DIR: "logs",
  HARNESS_DISPATCH_JOBS_DIR: "jobs",
  HARNESS_DISPATCH_WORKSPACES_DIR: "workspaces",
  HARNESS_DISPATCH_HOME: "auth",
} as const;

export default function setup(): () => void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--if-stale"], {
    cwd: root,
    stdio: "inherit",
  });

  const run = mkdtempSync(path.join(os.tmpdir(), "hd-test-run-"));
  const home = path.join(run, "home");
  mkdirSync(home);
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  for (const [name, dir] of Object.entries(ISOLATED_DIR_VARS)) {
    const full = path.join(run, dir);
    mkdirSync(full);
    process.env[name] = full;
  }

  return () => {
    // force + retries: a detached runner can still hold a handle on Windows.
    // Cleanup must never fail a green run.
    try {
      rmSync(run, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Left for the OS.
    }
  };
}
