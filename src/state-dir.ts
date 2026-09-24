/**
 * One root for everything harness-dispatch persists.
 *
 * The rule: a specific override (jobs dir, log dir, HTTP token home) wins when
 * set; otherwise everything derives from HARNESS_DISPATCH_STATE_DIR; otherwise
 * ~/.harness-dispatch. Resolving each default independently would let
 * STATE_DIR relocate only PART of the state, leaving `doctor`'s state-dir
 * check reasoning about jobs under a root it does not govern.
 */

import { homedir } from "node:os";
import path from "node:path";

/**
 * A directory from an environment variable, or a fallback.
 *
 * One rule, applied at one seam: a plain `??` per call site leaves each one
 * free to mishandle an empty variable, which is what a launcher or shell
 * produces when it forwards something unset — `HARNESS_DISPATCH_JOBS_DIR=""`
 * then puts the jobs tree in the process's current directory, and
 * `HARNESS_DISPATCH_LOG_DIR=""` writes `dispatches.jsonl` wherever the server
 * started.
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
  // Via dirFromEnv so an empty `HARNESS_DISPATCH_STATE_DIR` means "not set"
  // rather than an empty path: every path built on it would otherwise resolve
  // relative to the process's current directory, scattering config, jobs,
  // breaker state, quota counters and logs wherever the server started.
  return dirFromEnv("HARNESS_DISPATCH_STATE_DIR", () =>
    path.join(homedir(), ".harness-dispatch"),
  );
}

/**
 * Where `configure` writes and the last place config lookup looks: the tool's
 * own state directory, so a global install has one config no matter which
 * directory a command is run from. A config written relative to the current
 * directory would be invisible to `doctor` run inside a project.
 */
export function userConfigPath(): string {
  return path.join(stateRoot(), "config.yaml");
}
