import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import which from "which";

/**
 * Is a command on PATH, and where.
 *
 * `which` stats every candidate in every PATH directory, one command at a time
 * and synchronously; on a long Windows PATH that was 0.17-0.47 s per name with
 * the event loop blocked, and it ran on every routing decision, every `status`,
 * and at the start of every process that auto-detects four harnesses. This reads
 * each PATH directory once per window and matches names in memory.
 *
 * Same answer as `which`: a name found in a PATH directory (the working
 * directory first on Windows), extended with PATHEXT on Windows, that is an
 * executable file. Only a hit is stat-ed. A command with a path separator is
 * not a PATH lookup and goes to `which`, which handles it.
 *
 * Memoised for a few seconds rather than for the life of the process: a server
 * runs for hours, and a harness installed meanwhile must be found without a
 * restart. Listings are kept per directory, results per command.
 */

const TTL_MS = 5_000;

const IS_WINDOWS = process.platform === "win32";

interface Listing {
  at: number;
  /** Lower-cased on Windows, where lookups are case-insensitive -> the real name. */
  names: Map<string, string>;
}

const listings = new Map<string, Listing>();
const results = new Map<string, { at: number; found: string | undefined }>();

function listDir(dir: string, now: number): Map<string, string> {
  const hit = listings.get(dir);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.names;
  const names = new Map<string, string>();
  try {
    for (const entry of readdirSync(dir)) names.set(IS_WINDOWS ? entry.toLowerCase() : entry, entry);
  } catch {
    // Not there, or not readable: it contributes nothing, as for `which`.
  }
  listings.set(dir, { at: now, names });
  return names;
}

function pathDirs(): string[] {
  const dirs = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .map((d) => d.replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "");
  return IS_WINDOWS ? [process.cwd(), ...dirs] : dirs;
}

function extensions(command: string): string[] {
  if (!IS_WINDOWS) return [""];
  const exts = (process.env["PATHEXT"] || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((e) => e !== "")
    .map((e) => e.toLowerCase());
  // `which` also tries the bare name when it already carries an extension.
  return command.includes(".") ? ["", ...exts] : exts;
}

function isExecutableFile(file: string): boolean {
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    // Windows has no exec bit: the extension (PATHEXT, applied by the caller) is
    // what makes a file runnable.
    return IS_WINDOWS || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function lookup(command: string, now: number): string | undefined {
  const exts = extensions(command);
  const want = IS_WINDOWS ? command.toLowerCase() : command;
  for (const dir of pathDirs()) {
    const names = listDir(dir, now);
    for (const ext of exts) {
      const actual = names.get(want + ext);
      if (actual === undefined) continue;
      const file = path.join(dir, actual);
      if (isExecutableFile(file)) return file;
    }
  }
  return undefined;
}

/**
 * The full path of `command` on PATH, or undefined. Never throws; an unusable
 * resolver answers "not found", which skips the route with a clear reason
 * rather than selecting it and failing the dispatch.
 *
 * `now` is injectable so a test can step past the memo window without waiting.
 */
export function findOnPath(command: string, now: number = Date.now()): string | undefined {
  if (command === "") return undefined;
  if (command.includes("/") || (IS_WINDOWS && command.includes("\\"))) {
    // An explicit path, not a PATH search: `which` resolves it (and PATHEXT).
    try {
      return which.sync(command, { nothrow: true }) ?? undefined;
    } catch {
      return undefined;
    }
  }
  const memo = results.get(command);
  if (memo !== undefined && now - memo.at < TTL_MS) return memo.found;
  const found = lookup(command, now);
  results.set(command, { at: now, found });
  return found;
}

export function commandAvailable(command: string): boolean {
  return findOnPath(command) !== undefined;
}

/** Forget what was read, for tests that change PATH. */
export function resetPathCache(): void {
  listings.clear();
  results.clear();
}
