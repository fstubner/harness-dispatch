/**
 * A minimal cross-process mutex over a file path.
 *
 * Shared by breaker-store.ts and quota.ts, which guard the same shape of bug:
 * a read-modify-write of a shared state file performed by many detached
 * dispatch processes at once, where the losers are silently discarded.
 *
 * A lock alone is not enough. Serialising writers does not help if each writer
 * holds an ABSOLUTE value computed from its own boot-time baseline — they will
 * politely take turns writing the same number. The caller must apply a DELTA to
 * whatever it reads inside the critical section. Both callers here do.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The file inside a lock directory that says who holds it. Release must check
 * it rather than doing a bare `rmdir` of the lock path: if the lock was stolen
 * as stale in the meantime, that path holds the NEW holder's lock, and removing
 * it lets a third process straight in.
 */
const OWNER_FILE = "owner";

/**
 * How long a held lock may go unrefreshed before another process steals it.
 *
 * A crashed holder must not wedge a route's breaker file forever. Short,
 * because the critical section is one read and one write.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Take a lock judged stale, by RENAME rather than delete.
 *
 * stat-then-rmdir lets two waiters both judge the same lock stale — the slower
 * one's rmdir then removes the faster one's FRESHLY CREATED lock and both enter
 * the critical section. Rename is atomic: exactly one waiter wins it, the loser
 * gets ENOENT and goes round the loop again.
 *
 * Both failures are expected and neither is worth reporting: losing the rename
 * means another waiter got there first, and a leftover tombstone is inert
 * because nothing reads `*.stale-*` names.
 */
function stealStaleLock(lockDir: string): void {
  const tomb = `${lockDir}.stale-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(lockDir, tomb);
  } catch {
    return; // lost the steal race to another waiter
  }
  try {
    rmSync(tomb, { recursive: true, force: true });
  } catch {
    // Leftover tombstone; nothing reads `*.stale-*` names.
  }
}

/** Pause between acquisition attempts, so waiting costs no CPU. */
const RETRY_MS = 25;

/** Give up rather than block a dispatch indefinitely. */
const LOCK_TIMEOUT_MS = 2_000;

/**
 * Run `fn` holding an exclusive cross-process lock on one route's file.
 *
 * mkdir is the atomic test-and-set here: it fails if the directory exists, on
 * every platform, and unlike `writeFile` with `wx` it needs no cleanup path
 * distinct from the directory itself. Synchronous on purpose — the callers
 * (BreakerStore.update via Router.handleResult, and CLI paths that exit
 * immediately afterwards) are sync.
 *
 * Failing to acquire runs `fn` anyway rather than dropping the update: an
 * un-serialised write may lose a count, while a dropped one loses it for
 * certain. That holds for a caller with NOTHING to fall back on, which is why
 * BreakerStore uses the default. It does not hold for a caller that can retry:
 * QuotaCache accumulates a pending delta and only clears it once a write
 * succeeds, so an unserialised write clears the delta believing it was
 * serialised, and the real lock holder then overwrites the file with a value
 * computed before it. `requireLock` is for that case: throw instead of running
 * unserialised, and let the caller try again.
 */
export class LockNotAcquiredError extends Error {
  constructor(file: string) {
    super(
      `Could not acquire the lock on ${file} within ${LOCK_TIMEOUT_MS}ms — not running ` +
        `unserialised, because this caller can retry.`,
    );
    this.name = "LockNotAcquiredError";
  }
}
/**
 * Block this thread briefly without spinning. Atomics.wait on a throwaway
 * buffer is the only synchronous sleep Node offers, and the lock has to stay
 * synchronous, so the choice is this or a busy loop.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without SharedArrayBuffer fall back to returning
    // immediately; the deadline still bounds the loop.
  }
}

/**
 * Remove the lock only if it is still the one this call took.
 *
 * The check and the removal are two steps, so a steal landing exactly between
 * them can still be undone. The window is one file read.
 */
function releaseIfOurs(lockDir: string, token: string | undefined): void {
  try {
    if (token !== undefined && readFileSync(path.join(lockDir, OWNER_FILE), "utf8") !== token) return;
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Gone already, or never marked: either way not ours to remove.
  }
}

export function withFileLock<T>(
  file: string,
  fn: () => T,
  opts: { requireLock?: boolean } = {},
): T {
  const lockDir = `${file}.lock`;
  // Ensure the parent exists before trying to lock inside it: a caller whose
  // state directory has not been created yet would otherwise spin against an
  // ENOENT that no amount of retrying resolves.
  //
  // If the parent cannot be created there is nothing to lock against and
  // retrying cannot help — an unwritable state directory would burn the full
  // 2s timeout on every call, forever. Run unlocked immediately instead; the
  // caller already tolerates that.
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return fn();
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let held = false;
  let marked = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      held = true;
      try {
        writeFileSync(path.join(lockDir, OWNER_FILE), token, "utf8");
        marked = true;
      } catch {
        // Could not mark it; released unconditionally below.
      }
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          stealStaleLock(lockDir);
          continue;
        }
      } catch {
        // mkdir failed for a reason that is not "already exists": the lock
        // vanished between the two calls, or the directory is unwritable, or
        // the name is too long. Retrying can only help in the first case, and
        // sleeping before it matters as much as in the contended branch:
        // continuing without a sleep spins a full CPU for the whole timeout on
        // every dispatch result when the state directory is unwritable.
        if (Date.now() >= deadline) break;
        sleepSync(RETRY_MS);
        continue;
      }
      if (Date.now() >= deadline) break;
      sleepSync(RETRY_MS);
    }
  }
  if (!held && opts.requireLock === true) {
    // Nothing to clean up: the lock was never taken, and the directory that
    // blocked us belongs to whoever is holding it.
    throw new LockNotAcquiredError(file);
  }
  try {
    return fn();
  } finally {
    if (held) releaseIfOurs(lockDir, marked ? token : undefined);
  }
}

