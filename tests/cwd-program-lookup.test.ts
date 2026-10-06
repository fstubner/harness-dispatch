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

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GenericCliDispatcher } from "../src/dispatchers/generic-cli.js";
import { codexLoginState } from "../src/dispatchers/shared/harness-login.js";
import { killTree } from "../src/dispatchers/shared/kill-tree.js";
import { killJobChildren } from "../src/jobs/children.js";
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

/** A route whose command is the bare NAME, as a config names it. */
function probeRoute(): GenericCliDispatcher {
  return new GenericCliDispatcher({
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
    const res = await probeRoute().dispatch("hi", [], planted);

    expect(existsSync(marker), "the planted program ran").toBe(false);
    expect(res.output).toContain("REAL");
  });

  // Windows only: cmd.exe, which runs a .cmd route, looks in its current
  // directory before PATH for every bare name the script runs. POSIX shells
  // search PATH alone.
  it.skipIf(!IS_WINDOWS)("is not what a .cmd route runs by bare name", { timeout: 30_000 }, async () => {
    // No `.` entry here: the planted copy must be reachable only by cmd.exe's
    // own current-directory search.
    process.env["PATH"] = [real, saved.path ?? ""].join(path.delimiter);
    writeFileSync(path.join(planted, "hd-cwd-helper.cmd"), `@echo off\r\necho PLANTED\r\necho x> "${marker}"\r\n`);
    writeFileSync(path.join(real, "hd-cwd-helper.cmd"), "@echo off\r\necho REAL-HELPER\r\n");
    program(real, ["hd-cwd-helper"]);

    const res = await probeRoute().dispatch("hi", [], planted);

    expect(existsSync(marker), "the planted helper ran").toBe(false);
    expect(res.output).toContain("REAL-HELPER");
  });

  // Windows only: with COMSPEC unset, cross-spawn starts a .cmd route through
  // a bare `cmd.exe`, which Node looks up in the working directory first.
  it.skipIf(!IS_WINDOWS)("is not the cmd.exe a .cmd route starts through", { timeout: 60_000 }, async () => {
    copyFileSync(process.execPath, path.join(planted, "cmd.exe"));
    program(real, [echo("REAL")]);
    const comspec = Object.keys(process.env).filter((k) => k.toLowerCase() === "comspec");
    const savedComspec = comspec.map((k) => [k, process.env[k]] as const);
    for (const k of comspec) delete process.env[k];
    try {
      const res = await probeRoute().dispatch("hi", [], planted);
      expect(res.output).toContain("REAL");
    } finally {
      for (const k of Object.keys(process.env)) if (k.toLowerCase() === "comspec") delete process.env[k];
      for (const [k, v] of savedComspec) process.env[k] = v;
    }
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

// Windows only: the tools that stop a run's process tree are Windows' own, and
// are run from System32 rather than whatever answers to the name on PATH.
// Each plant is a copy of node, which fails on taskkill's or PowerShell's
// arguments, so a run that used it leaves the child alive.
describe.skipIf(!IS_WINDOWS)("a system tool earlier on PATH", () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // gone
    }
    child = undefined;
  });

  function startSleeper(): ChildProcess {
    // Outside `root`, so a child slow to go cannot hold it open past cleanup.
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      cwd: os.tmpdir(),
      stdio: "ignore",
      windowsHide: true,
    });
    return child;
  }

  function exited(proc: ChildProcess, withinMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), withinMs);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it("is not the taskkill that stops a dispatch's child", { timeout: 60_000 }, async () => {
    copyFileSync(process.execPath, path.join(real, "taskkill.exe"));
    resetPathCache();
    const proc = startSleeper();
    await new Promise((resolve) => proc.once("spawn", resolve));
    // killTree does not wait for taskkill, which inherits this process's
    // current directory: out of `root`, so cleanup is not racing it.
    process.chdir(saved.cwd);

    killTree(proc, "SIGTERM");

    expect(await exited(proc, 15_000), "the child survived its tree kill").toBe(true);
  });

  it("is not the PowerShell or taskkill that stops an orphaned job's child", { timeout: 60_000 }, async () => {
    copyFileSync(process.execPath, path.join(real, "taskkill.exe"));
    copyFileSync(process.execPath, path.join(real, "powershell.exe"));
    resetPathCache();
    const proc = startSleeper();
    await new Promise((resolve) => proc.once("spawn", resolve));

    const killed = await killJobChildren([{ pid: proc.pid!, command: "node.exe", startedAt: new Date().toISOString() }]);

    expect(killed).toEqual([proc.pid]);
    expect(await exited(proc, 15_000), "the child survived its tree kill").toBe(true);
  });
});
