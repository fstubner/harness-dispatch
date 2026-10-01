/**
 * Which processes a job started, so they can be found when its supervisor
 * cannot.
 *
 * A job's agent CLI is a child of the supervisor running it. When that
 * supervisor dies, the job reads orphaned — but on POSIX the CLI was spawned
 * in its own process group and keeps running, and on Windows a descendant can
 * outlive a tree kill. Nothing recorded its pid, so nothing could stop it:
 * `cancel_job` on an orphan marked it cancelled and killed nothing, while the
 * process went on editing the working directory (observed: an Antigravity
 * child outliving its cancelled job).
 *
 * Recorded without touching the dispatchers: Node publishes every child
 * process it creates on the `child_process` diagnostics channel, and the run
 * executes inside an AsyncLocalStorage scope, so the spawn can be attributed
 * to the job whose code made it — even with several jobs in one supervisor.
 */

import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import path from "node:path";
import { processAlive, timestamp } from "./store.js";
import type { JobChild } from "./types.js";


interface Scope {
  onSpawn(child: JobChild): void;
  onExit(pid: number): void;
}

const scopes = new AsyncLocalStorage<Scope>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  subscribe("child_process", (message) => {
    const scope = scopes.getStore();
    if (scope === undefined) return;
    // Published from the ChildProcess constructor, before the OS process
    // exists: the pid is only known once it has spawned.
    const child = (message as { process: ChildProcess }).process;
    child.once("spawn", () => {
      if (child.pid === undefined) return;
      scope.onSpawn({
        pid: child.pid,
        command: path.basename(child.spawnfile ?? ""),
        startedAt: timestamp(),
      });
    });
    child.once("exit", () => {
      if (child.pid !== undefined) scope.onExit(child.pid);
    });
  });
}

/**
 * Run `fn` with every child process it starts reported to `onChange`, as the
 * set of those still alive.
 */
export function trackChildren<T>(onChange: (alive: JobChild[]) => void, fn: () => Promise<T>): Promise<T> {
  ensureSubscribed();
  const alive = new Map<number, JobChild>();
  const scope: Scope = {
    onSpawn(child) {
      alive.set(child.pid, child);
      onChange([...alive.values()]);
    },
    onExit(pid) {
      if (alive.delete(pid)) onChange([...alive.values()]);
    },
  };
  return scopes.run(scope, fn);
}

/** How far a process's real start time may sit from the recorded one. */
const START_TIME_TOLERANCE_MS = 10_000;

/**
 * Kill the recorded processes that are still the SAME processes, and their
 * descendants. Returns the pids it killed.
 *
 * A pid is only a number the OS hands out again: by the time an orphan is
 * cancelled, the agent may have exited and its pid gone to something else.
 * So each is checked against the start time recorded when it was spawned,
 * and one that does not match — or cannot be checked — is left alone.
 */
export async function killJobChildren(children: readonly JobChild[] | undefined): Promise<number[]> {
  const candidates = (children ?? []).filter((c) => Number.isInteger(c.pid) && c.pid > 0 && processAlive(c.pid));
  if (candidates.length === 0) return [];
  const started = await processStartTimes(candidates.map((c) => c.pid));
  const killed: number[] = [];
  for (const child of candidates) {
    const actual = started.get(child.pid);
    const recorded = Date.parse(child.startedAt);
    if (actual === undefined || !Number.isFinite(recorded)) continue;
    if (Math.abs(actual - recorded) > START_TIME_TOLERANCE_MS) continue;
    await killTreeByPid(child.pid);
    killed.push(child.pid);
  }
  return killed;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

/** Start time (ms since epoch) of each pid that exists, from the OS. */
async function processStartTimes(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (process.platform === "win32") {
    const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
    const text = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`,
    ]);
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\S+)/.exec(line.trim());
      if (m !== null && Number.isFinite(Date.parse(m[2]!))) out.set(Number(m[1]), Date.parse(m[2]!));
    }
    return out;
  }
  // `etime` ([[dd-]hh:]mm:ss) is in both procps and BSD ps; `etimes` is not.
  const text = await run("ps", ["-o", "pid=,etime=", "-p", pids.join(",")]);
  const now = Date.now();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const [, pid, d, h, mi, s] = m;
    const elapsed = ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s);
    out.set(Number(pid), now - elapsed * 1000);
  }
  return out;
}

async function killTreeByPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  // Agent CLIs are spawned as process-group leaders (stream-subprocess.ts), so
  // the group takes their shells and test runners with them.
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a group leader, or gone.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
