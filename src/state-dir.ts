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

/**
 * A directory from an environment variable, or a fallback.
 *
 * One rule, applied at one seam, because the alternative was tried and the
 * usual thing happened. `stateRoot` was fixed for an EMPTY variable — the
 * value a launcher or shell produces when it forwards something unset — and
 * gained a careful comment explaining why. Its five siblings kept `??` and
 * kept the bug: `HARNESS_DISPATCH_JOBS_DIR=""` put the jobs tree at the
 * process's current directory, and `HARNESS_DISPATCH_LOG_DIR=""` wrote
 * `dispatches.jsonl` into whatever directory the server started in. Both
 * measured. An upgrade audit found two of them; there were five.
 *
 * Two rules in one:
 *   - An empty or whitespace-only value means "not set", not "use the empty
 *     string as a path".
 *   - A relative value is resolved once, here. A detached job runner starts
 *     with a different working directory than the server that spawned it, so
 *     an unanchored relative path meant the two disagreed about where state
 *     lived.
 */
export function dirFromEnv(name: string, fallback: () => string): string {
  const configured = process.env[name];
  if (configured !== undefined && configured.trim() !== "") return path.resolve(configured);
  return fallback();
}

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
  return dirFromEnv("HARNESS_DISPATCH_STATE_DIR", () =>
    path.join(homedir(), ".harness-dispatch"),
  );
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
