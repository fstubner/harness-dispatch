/**
 * A program named by a bare command is found through PATH, never in the
 * current directory.
 *
 * `which` and Windows itself both look in the current directory first. A
 * server started inside a cloned repository therefore ran a `codex.cmd` (or
 * `git.exe`) planted in that repository instead of the real program: on
 * availability checks, on the dispatch's own spawn, in doctor's login probe,
 * and for every git call a workspace makes. An empty or `.` PATH entry means
 * the current directory too, on every platform.
 *
 * Each case plants a program in the current directory that would be told
 * apart from the real one, and puts the real one (or nothing) on PATH.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GenericCliDispatcher } from "../src/dispatchers/generic-cli.js";
import { codexLoginState } from "../src/dispatchers/shared/harness-login.js";
import { findOnPath, resetPathCache } from "../src/dispatchers/shared/which-available.js";
import { prepareWorkspace } from "../src/workspaces.js";
import type { ServiceConfig } from "../src/types.js";

const IS_WINDOWS = process.platform === "win32";
const NAME = "hd-cwd-probe";

let root: string;
let planted: string;
let real: string;
let marker: string;
const saved: { cwd: string; path: string | undefined; noCwd: [string, string] | undefined } = {
  cwd: process.cwd(),
  path: undefined,
  noCwd: undefined,
};

/** A runnable script: a .cmd on Windows, an executable shell script elsewhere. */
function program(dir: string, lines: string[]): string {
  if (IS_WINDOWS) {
    const file = path.join(dir, `${NAME}.cmd`);
    writeFileSync(file, ["@echo off", ...lines].join("\r\n") + "\r\n");
    return file;
  }
  const file = path.join(dir, NAME);
  writeFileSync(file, ["#!/bin/sh", ...lines].join("\n") + "\n");
  chmodSync(file, 0o755);
  return file;
}

const echo = (text: string): string => (IS_WINDOWS ? `echo ${text}` : `echo "${text}"`);
const touch = (file: string): string => (IS_WINDOWS ? `echo x> "${file}"` : `echo x > "${file}"`);
const exit = (code: number): string => (IS_WINDOWS ? `exit /b ${code}` : `exit ${code}`);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "hd-cwd-lookup-"));
  planted = path.join(root, "cloned-repo");
  real = path.join(root, "real-bin");
  mkdirSync(planted);
  mkdirSync(real);
  marker = path.join(root, "planted-program-ran");
  saved.path = process.env["PATH"];
  // `.` and an empty entry both mean the current directory to a PATH search.
  process.env["PATH"] = [".", "", real, saved.path ?? ""].join(path.delimiter);
  // Some environments (Claude Code among them) set this, which turns off
  // Windows' own current-directory search for a spawned bare name. A server
  // started by any other client does not have it, so the spawn cases run
  // without it.
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "nodefaultcurrentdirectoryinexepath");
  saved.noCwd = key !== undefined ? [key, process.env[key]!] : undefined;
  if (key !== undefined) delete process.env[key];
  process.chdir(planted);
  resetPathCache();
});

afterEach(() => {
  process.chdir(saved.cwd);
  if (saved.path === undefined) delete process.env["PATH"];
  else process.env["PATH"] = saved.path;
  if (saved.noCwd !== undefined) process.env[saved.noCwd[0]] = saved.noCwd[1];
  resetPathCache();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("a program planted in the current directory", () => {
  it("is not found by the PATH lookup", () => {
    program(planted, [echo("PLANTED")]);
    expect(findOnPath(NAME), "found in the current directory").toBeUndefined();

    const realFile = program(real, [echo("REAL")]);
    resetPathCache(); // the miss above is remembered for a few seconds
    expect(findOnPath(NAME)?.toLowerCase()).toBe(realFile.toLowerCase());
  });

  it("is not what a dispatch runs", { timeout: 30_000 }, async () => {
    program(planted, [echo("PLANTED"), touch(marker)]);
    program(real, [echo("REAL")]);
    const d = new GenericCliDispatcher({
      name: "probe",
      enabled: true,
      type: "cli",
      harness: "generic",
      command: NAME,
      tier: 3,
      weight: 1,
      cliCapability: 1,
      capabilities: {},
      escalateOn: [],
      protocol: { args: [], output: { mode: "text" } },
    } as unknown as ServiceConfig);

    const res = await d.dispatch("hi", [], planted);

    expect(existsSync(marker), "the planted program ran").toBe(false);
    expect(res.output).toContain("REAL");
  });

  it("is not what doctor's login probe runs", async () => {
    program(planted, [echo("Logged in using ChatGPT"), touch(marker), exit(0)]);
    expect(await codexLoginState(NAME)).toBe("unknown");
    program(real, [echo("Not logged in"), exit(1)]);
    resetPathCache(); // the miss above is remembered for a few seconds
    expect(await codexLoginState(NAME)).toBe("logged_out");
    expect(existsSync(marker), "the planted program ran").toBe(false);
  });

  // Windows only: a shell-less spawn of `git` finds only a .exe/.com, so the
  // plant is a real executable — a copy of node, which fails `git rev-parse`
  // with "Cannot find module". On POSIX the spawn searches PATH alone, and
  // the `.` entry case is covered by the lookup above.
  it.skipIf(!IS_WINDOWS)("is not the git a git_worktree workspace runs", async () => {
    const gitExe = findOnPath("git");
    if (gitExe === undefined) return; // no git on this machine
    const run = (args: string[]): void => {
      execFileSync(gitExe, args, { cwd: planted, stdio: "ignore" });
    };
    run(["init", "-q"]);
    run(["config", "user.email", "t@example.test"]);
    run(["config", "user.name", "T"]);
    run(["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(planted, "a.txt"), "a\n");
    run(["add", "a.txt"]);
    run(["commit", "-qm", "initial"]);
    copyFileSync(process.execPath, path.join(planted, "git.exe"));

    const prepared = await prepareWorkspace({
      routeName: "probe",
      policy: "git_worktree",
      workingDir: planted,
      files: [],
    });
    expect(prepared.effectiveWorkingDir).not.toBe(planted);
    await prepared.finish({ output: "", service: "probe", success: true });
  }, 30_000);
});
