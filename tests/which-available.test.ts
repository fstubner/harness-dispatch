/**
 * PATH lookup: the same answer `which` gives, without walking PATH on every
 * call. These pin the two properties the replacement exists for — a hit is a
 * real executable file, and a repeat lookup does not touch the filesystem again
 * within the memo window — plus that the window ends, so a harness installed
 * while a server runs is found without a restart.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { commandAvailable, findOnPath, resetPathCache } from "../src/dispatchers/shared/which-available.js";

const IS_WINDOWS = process.platform === "win32";

let dir: string;
let prevPath: string | undefined;

/** A runnable file by the platform's own rule: a PATHEXT name on Windows, an exec bit elsewhere. */
function plant(name: string, executable = true): string {
  const file = path.join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  writeFileSync(file, IS_WINDOWS ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!IS_WINDOWS) chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hr-which-"));
  prevPath = process.env["PATH"];
  process.env["PATH"] = `${dir}${path.delimiter}${prevPath ?? ""}`;
  resetPathCache();
});

afterEach(() => {
  if (prevPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = prevPath;
  rmSync(dir, { recursive: true, force: true });
  resetPathCache();
});

describe("findOnPath", () => {
  it("finds an executable in a PATH directory and returns its full path", () => {
    const file = plant("hd-fake-harness");
    expect(findOnPath("hd-fake-harness")?.toLowerCase()).toBe(file.toLowerCase());
    expect(commandAvailable("hd-fake-harness")).toBe(true);
  });

  it("does not find a command that is not there", () => {
    expect(findOnPath("hd-no-such-harness")).toBeUndefined();
    expect(commandAvailable("hd-no-such-harness")).toBe(false);
  });

  it.skipIf(IS_WINDOWS)("does not count a file without an execute bit", () => {
    plant("hd-not-executable", false);
    expect(commandAvailable("hd-not-executable")).toBe(false);
  });

  it("answers from memory within the window, and looks again after it", () => {
    const file = plant("hd-memo-harness");
    const t0 = 1_000_000;
    expect(findOnPath("hd-memo-harness", t0)).toBeDefined();
    rmSync(file);
    // Within the window: not re-read. (The old resolver walked PATH on every call,
    // so this would already read false.)
    expect(findOnPath("hd-memo-harness", t0 + 1_000)).toBeDefined();
    // Past it: gone, as it should be.
    expect(findOnPath("hd-memo-harness", t0 + 60_000)).toBeUndefined();
  });

  it("finds a harness installed after a negative answer, once the window ends", () => {
    const t0 = 2_000_000;
    expect(findOnPath("hd-late-harness", t0)).toBeUndefined();
    plant("hd-late-harness");
    expect(findOnPath("hd-late-harness", t0 + 1_000)).toBeUndefined();
    expect(findOnPath("hd-late-harness", t0 + 60_000)).toBeDefined();
  });

  it.skipIf(!IS_WINDOWS)("matches case-insensitively and by PATHEXT on Windows", () => {
    plant("hd-win-harness");
    expect(findOnPath("HD-WIN-HARNESS")).toBeDefined();
  });
});
