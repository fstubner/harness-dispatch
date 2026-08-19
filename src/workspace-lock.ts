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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Matches ORPHAN_THRESHOLD_MS in jobs.ts: one notion of "the holder is gone". */
export const LOCK_STALE_MS = 90_000;

/** How often a held lock refreshes its heartbeat. Comfortably inside the stale window. */
const HEARTBEAT_MS = 15_000;

/** Gap between attempts when another process holds the lock. */
const RETRY_MS = 100;

/**
 * How long an EXISTING-but-unreadable lock file is given before it is treated
 * as stealable. An unreadable record used to be stolen on sight, which made a
 * torn read of a mid-rewrite heartbeat sufficient to take a LIVE holder's lock
 * — two dispatches then edited the same workspace, the exact outcome
 * `shared_locked` exists to prevent. Heartbeats are written atomically now, so
 * within one build a torn read cannot happen; the grace keeps the steal honest
 * against writers from older builds (in-place heartbeat rewrites during a
 * rolling upgrade) and external interference.
 */
const UNREADABLE_GRACE_MS = 1_000;

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

/**
 * Take a stale lock out of the way — by RENAME, not delete.
 *
 * Delete-then-recreate let two waiters both decide the same record was stale:
 * the slower one's delete then removed the FASTER one's freshly created lock,
 * and both ended up holding the directory. Rename is atomic and names a
 * specific victim — whoever loses the rename gets ENOENT and simply goes
 * round the acquire loop again. Returns true if this process performed the
 * steal (the caller still has to win the `wx` create; a third waiter may get
 * there first, which is an honest race, not a double hold).
 */
function stealLock(file: string): boolean {
  const tomb = `${file}.stolen-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(file, tomb);
  } catch {
    return false; // Another waiter stole it, or the holder released it first.
  }
  try {
    rmSync(tomb, { force: true });
  } catch {
    // A leftover tombstone is inert: nothing reads `*.stolen-*` names.
  }
  return true;
}

async function acquireFileLock(key: string, timeoutMs: number): Promise<() => void> {
  const file = lockFileFor(key);
  const deadline = Date.now() + timeoutMs;
  let unreadableSince: number | undefined;

  for (;;) {
    if (tryCreate(file, key)) break;

    const record = readRecord(file);
    if (record === undefined) {
      // Exists but unreadable (or vanished between the two calls). Give it a
      // grace window rather than stealing on sight — see UNREADABLE_GRACE_MS.
      unreadableSince ??= Date.now();
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        unreadableSince = undefined;
        stealLock(file);
        continue;
      }
    } else {
      unreadableSince = undefined;
      if (isDead(record)) {
        stealLock(file);
        continue;
      }
    }

    if (Date.now() >= deadline) {
      // Proceeding unlocked would silently break the guarantee the caller
      // asked for, so this is an error rather than a warning.
      throw new Error(
        `workspace lock timed out after ${Math.round(timeoutMs / 1000)}s waiting for ` +
          `pid ${record?.pid ?? "unknown"} to release ${key}. Another dispatch is still ` +
          `using this workspace; use workspace_policy: copy to run them concurrently.`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }

  const beat = setInterval(() => {
    // Refresh ATOMICALLY (tmp + rename), never by rewriting in place: an
    // in-place rewrite truncates first, and a waiter reading in that window
    // saw an empty record — grounds, under the old rules, to steal a lock
    // whose holder was alive and mid-write.
    //
    // Ownership is checked first: if the record is no longer ours, this
    // process froze past the stale window and was legitimately stolen.
    // Overwriting would clobber the thief's record — and worse, make our own
    // release() believe it still held the lock and delete it under the thief.
    try {
      const current = readRecord(file);
      if (current !== undefined && current.pid !== process.pid) {
        clearInterval(beat);
        return;
      }
      if (current === undefined) {
        // Missing or unreadable while we believe we hold it: a steal may be
        // mid-flight. Recreating it could re-take a lock someone else now
        // owns, so stop refreshing and let release()'s ownership check
        // decide what to delete.
        clearInterval(beat);
        return;
      }
      const tmp = `${file}.${process.pid}.beat`;
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, key, beatMs: Date.now() }), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmp, file);
    } catch {
      // A failed refresh only risks the lock being stolen as stale, which is
      // the correct outcome if this process really is in trouble. The next
      // beat retries; a leftover .beat tmp file is inert.
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
