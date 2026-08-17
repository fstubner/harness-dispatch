/**
 * Mutual exclusion over a working directory, across processes.
 *
 * `workspace_policy: shared_locked` promises that two dispatches never edit
 * one workspace at the same time. Until now that promise was implemented as a
 * `Map` in module scope — real within a process, and every job used to get its
 * OWN process, so concurrent jobs sharing a directory were free to clobber
 * each other the entire time. The guarantee read correctly and did nothing.
 * Pooling supervisors made it bind for jobs sharing a supervisor, which
 * narrowed the hole to four ways instead of N but did not close it.
 *
 * Two layers, because they solve different halves:
 *
 *   1. An in-process promise chain. Fast, fair (FIFO by arrival), and it keeps
 *      same-process waiters off the filesystem entirely.
 *   2. A lock FILE, for everything the first layer cannot see. Created with
 *      `wx`, which fails atomically if it already exists on both Windows and
 *      POSIX.
 *
 * Lock files live in the state directory, keyed by a hash of the resolved
 * path, rather than inside the workspace: a dispatcher should not drop
 * bookkeeping files into a user's repository, where they would show up in
 * `git status` and in the workspace diff the caller is handed back.
 *
 * A holder that dies must not wedge the directory forever, so the lock carries
 * a heartbeat refreshed while held, and a lock whose heartbeat has gone stale
 * is stolen. That is the same rule, and the same threshold, the job orphan
 * check already uses — one staleness concept in the system, not two.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Matches ORPHAN_THRESHOLD_MS in jobs.ts: one notion of "the holder is gone". */
export const LOCK_STALE_MS = 90_000;

/** How often a held lock refreshes its heartbeat. Comfortably inside the stale window. */
const HEARTBEAT_MS = 15_000;

/** Gap between attempts when another process holds the lock. */
const RETRY_MS = 100;

const inProcessLocks = new Map<string, Promise<void>>();

function lockKey(workingDir: string): string {
  const resolved = path.resolve(workingDir || process.cwd());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function lockFileFor(key: string): string {
  const dir =
    process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(dir, "workspace-locks", `${digest}.json`);
}

interface LockRecord {
  pid: number;
  key: string;
  beatMs: number;
}

function readRecord(file: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockRecord>;
    if (typeof parsed?.beatMs !== "number") return undefined;
    return { pid: Number(parsed.pid) || 0, key: String(parsed.key ?? ""), beatMs: parsed.beatMs };
  } catch {
    // Unreadable or half-written: treat as absent, and let the staleness
    // check below decide. A corrupt lock must not wedge the directory.
    return undefined;
  }
}

/** True if the recorded holder is definitely gone. */
function isDead(record: LockRecord): boolean {
  if (Date.now() - record.beatMs > LOCK_STALE_MS) return true;
  if (record.pid > 0) {
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(record.pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

function tryCreate(file: string, key: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ pid: process.pid, key, beatMs: Date.now() }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

async function acquireFileLock(key: string, timeoutMs: number): Promise<() => void> {
  const file = lockFileFor(key);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryCreate(file, key)) break;

    const record = readRecord(file);
    if (record === undefined || isDead(record)) {
      // Steal it. Deleting then re-creating with `wx` keeps the race honest:
      // if another waiter wins the gap, this loop simply goes round again.
      try {
        rmSync(file, { force: true });
      } catch {
        // Someone else removed it first, which is the outcome we wanted.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      // Proceeding unlocked would silently break the guarantee the caller
      // asked for, so this is an error rather than a warning.
      throw new Error(
        `workspace lock timed out after ${Math.round(timeoutMs / 1000)}s waiting for ` +
          `pid ${record.pid} to release ${key}. Another dispatch is still using this ` +
          `workspace; use workspace_policy: copy to run them concurrently.`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }

  const beat = setInterval(() => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, key, beatMs: Date.now() }), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // A failed refresh only risks the lock being stolen as stale, which is
      // the correct outcome if this process really is in trouble.
    }
  }, HEARTBEAT_MS);
  beat.unref?.();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      // Only remove it if we still hold it — a stolen lock now belongs to
      // someone else and deleting it would hand the directory to a third
      // party while the thief is mid-write.
      const current = readRecord(file);
      if (current === undefined || current.pid === process.pid) {
        rmSync(file, { force: true });
      }
    } catch {
      // Left behind; it ages out via the staleness rule.
    }
  };
}

/**
 * Take the lock for `workingDir`. Resolves once held; call the returned
 * function to release.
 *
 * @param timeoutMs how long to wait for another process. Defaults to an hour,
 * matching the job runtime ceiling — a legitimate holder can hold it that long.
 */
export async function acquireWorkspaceLock(
  workingDir: string,
  timeoutMs = 60 * 60 * 1000,
): Promise<() => void> {
  const key = lockKey(workingDir);

  // Layer 1: queue behind same-process waiters first, so a burst inside one
  // supervisor costs one filesystem acquisition rather than N spinning ones.
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = previous.catch(() => undefined).then(
    () =>
      new Promise<void>((resolve) => {
        releaseLocal = resolve;
      }),
  );
  inProcessLocks.set(key, current);
  await previous.catch(() => undefined);

  // Layer 2: the cross-process lock.
  let releaseFile: () => void;
  try {
    releaseFile = await acquireFileLock(key, timeoutMs);
  } catch (err) {
    releaseLocal();
    if (inProcessLocks.get(key) === current) inProcessLocks.delete(key);
    throw err;
  }

  return () => {
    releaseFile();
    releaseLocal();
    if (inProcessLocks.get(key) === current) inProcessLocks.delete(key);
  };
}
