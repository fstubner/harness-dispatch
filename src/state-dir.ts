/**
 * One root for everything harness-dispatch persists.
 *
 * Four env vars used to resolve four defaults INDEPENDENTLY of one another:
 * HARNESS_DISPATCH_STATE_DIR governed breaker/quota/leaderboard/workspace-lock
 * state, while jobs (HARNESS_DISPATCH_JOBS_DIR), logs
 * (HARNESS_DISPATCH_LOG_DIR) and the HTTP token (HARNESS_DISPATCH_HOME) each
 * fell back straight to ~/.harness-dispatch — so setting STATE_DIR relocated
 * only PART of the state, and `doctor`'s state-dir check reasoned about jobs
 * that lived under a root it did not govern.
 *
 * The rule now: the specific override wins when set; otherwise everything
 * derives from HARNESS_DISPATCH_STATE_DIR; otherwise ~/.harness-dispatch.
 * With no env vars set nothing moves, so existing installs are untouched.
 */

import { homedir } from "node:os";
import path from "node:path";

export function stateRoot(): string {
  // `??` alone treated an EMPTY variable as a real value, so
  // `HARNESS_DISPATCH_STATE_DIR=""` — which is what a launcher or shell
  // produces when it forwards an unset variable — made the state root the
  // empty string. Every path built on it then resolved relative to the
  // process's current directory: config, jobs, breaker state, quota counters
  // and logs all landed wherever the server happened to start, which is the
  // cwd-dependent config bug this module's own comment says was fixed.
  // `path.resolve` for the same reason in the other direction: a relative
  // value was never anchored, so a job runner spawned with a different
  // working directory read a different state root than the server that
  // spawned it.
  const configured = process.env.HARNESS_DISPATCH_STATE_DIR;
  if (configured !== undefined && configured.trim() !== "") return path.resolve(configured);
  return path.join(homedir(), ".harness-dispatch");
}

/**
 * Where `configure` writes and the last place config lookup looks: the tool's
 * own state directory, so a global install has one config no matter which
 * directory a command is run from. `configure` used to write `./config.yaml`
 * wherever the user happened to be, and lookup stopped at the current
 * directory, so a config written from `~` was invisible to `doctor` run inside
 * a project — while the MCP client, given the absolute path, saw it fine. The
 * cold-install walk in acceptance/0.8.0.md is where that was seen.
 */
export function userConfigPath(): string {
  return path.join(stateRoot(), "config.yaml");
}
