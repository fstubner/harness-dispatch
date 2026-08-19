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
