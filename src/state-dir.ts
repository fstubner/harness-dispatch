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
  return process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
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
