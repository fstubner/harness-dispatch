/**
 * `workingDir` is effectively required on every dispatch entry point (MCP
 * tools, jobs, HTTP): when the caller omits it, the task runs in the router
 * server's own process cwd, almost never the project the caller means. That
 * silent wrong-directory execution was a review finding — this resolves the
 * value the same way everywhere and reports back whether it was defaulted so
 * callers can surface a visible warning instead of failing quietly.
 */

import { statSync } from "node:fs";
import path from "node:path";

export interface ResolvedWorkingDir {
  workingDir: string;
  defaulted: boolean;
}

/**
 * Reject a workingDir that cannot possibly work, at the boundary.
 *
 * Unvalidated, a bad path surfaced as the harness binary's own spawn failure —
 * `spawn claude.EXE ENOENT` — which names the wrong cause entirely: the CLI is
 * installed, the directory is not. The caller then debugs their PATH instead
 * of their path.
 *
 * Checked at the entry point rather than before spawn because by then the
 * route has been chosen, a workspace may have been prepared, and the error has
 * lost the context needed to explain itself.
 */
export function validateWorkingDir(input: string | undefined): string | undefined {
  if (input === undefined || input === "") return undefined;
  // A relative path is resolved against THIS process's cwd — the server's, not
  // the caller's — which is the silent wrong-directory execution described
  // above, only harder to spot: `../..` exists, so every check passed and the
  // dispatch ran somewhere nobody chose. `defaulted` stays false in that case,
  // so even the warning for an omitted value does not fire. An acceptance pass
  // ran a real dispatch this way.
  //
  // The caller and the server are different processes with different working
  // directories — a caller cannot know what a relative path will mean here, so
  // there is no correct relative value to accept.
  if (!path.isAbsolute(input)) {
    return (
      `workingDir must be an absolute path, got ${input} — a relative path resolves ` +
      `against the server's own directory, not yours, so it would run somewhere ` +
      `neither of us chose.`
    );
  }
  let stats: import("node:fs").Stats;
  try {
    stats = statSync(input);
  } catch {
    return `workingDir does not exist: ${input}`;
  }
  if (!stats.isDirectory()) return `workingDir is not a directory: ${input}`;
  return undefined;
}

export function resolveWorkingDir(input: string | undefined): ResolvedWorkingDir {
  if (input !== undefined && input !== "") {
    return { workingDir: input, defaulted: false };
  }
  return { workingDir: process.cwd(), defaulted: true };
}

export function workingDirWarning(resolved: ResolvedWorkingDir): string | undefined {
  if (!resolved.defaulted) return undefined;
  return (
    `workingDir was not provided — ran in the router server's own directory ` +
    `(${resolved.workingDir}), which is almost certainly not the intended project. ` +
    `Pass an absolute workingDir on the next call.`
  );
}
