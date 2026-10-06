/**
 * Windows' own programs, and the environment a delegate is started in there.
 *
 * Windows looks for a program named by a bare name in the current directory
 * before PATH, in three places harness-dispatch does not resolve itself:
 *
 *   - cmd.exe, running a hand-written `.cmd` route, for every bare command the
 *     script names. A `helper.cmd` planted in the working directory ran
 *     instead of the `helper` on PATH.
 *   - Node's spawn of the `cmd.exe` that cross-spawn names when COMSPEC is
 *     unset: a `cmd.exe` planted in the working directory ran instead.
 *   - Any bare `taskkill` / `powershell.exe` taken from PATH, which also lets
 *     a same-named program earlier on PATH stand in for Windows' own.
 *
 * `NoDefaultCurrentDirectoryInExePath` (any value; only its presence counts)
 * turns the first off for the process whose environment holds it, cmd.exe
 * included. Claude Code sets it for its own children; a delegate started here
 * gets the same. The other two are closed by naming the program by its
 * absolute path under the Windows directory.
 */

import path from "node:path";

import { mergeEnv } from "./env-names.js";

/** The Windows directory, as the environment names it. */
export function windowsDir(): string {
  return process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
}

/** The absolute path of a program in System32. */
export function system32(...parts: string[]): string {
  return path.join(windowsDir(), "System32", ...parts);
}

/** Windows PowerShell, by absolute path. */
export function windowsPowerShell(): string {
  return system32("WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Make sure COMSPEC names cmd.exe by an absolute path, before a spawn that
 * cross-spawn may route through cmd.exe.
 *
 * cross-spawn reads `process.env.comspec` (falling back to a bare `cmd.exe`)
 * from THIS process, not from the child's `env` option, so the fix has to be
 * made here. An absolute COMSPEC that is already set is left alone; unset or
 * relative means the default Windows itself would have set.
 */
export function ensureAbsoluteComspec(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const current = process.env["ComSpec"];
  if (current !== undefined && current !== "" && path.win32.isAbsolute(current)) return;
  process.env["ComSpec"] = system32("cmd.exe");
}

/**
 * The environment a delegate process is started with: this process's own,
 * with `overrides` applied, and on win32 the current-directory search turned
 * off. That last one is applied after `overrides`, so nothing can undo it.
 */
export function delegateEnv(
  overrides: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const merged = mergeEnv(process.env, overrides, platform);
  if (platform !== "win32") return merged;
  return mergeEnv(merged, { NoDefaultCurrentDirectoryInExePath: "1" }, platform);
}
