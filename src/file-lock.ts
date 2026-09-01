/**
 * A minimal cross-process mutex over a file path.
 *
 * Extracted from breaker-store.ts so quota.ts can use the same one. Both guard
 * the same shape of bug: a read-modify-write of a shared state file performed
 * by many detached dispatch processes at once, where the losers are silently
 * discarded.
 *
 * IMPORTANT, and the reason a lock alone is not enough: serialising writers
 * does not help if each writer holds an ABSOLUTE value computed from its own
 * boot-time baseline — they will politely take turns writing the same number.
 * The caller must apply a DELTA to whatever it reads inside the critical
 * section. Both callers here do; getting that wrong is what made the first
 * attempt at each of these fixes ineffective.
 */

import { mkdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How long a held lock may go unrefreshed before another process steals it.
 *
 * A crashed holder must not wedge a route's breaker file forever. Short,
 * because the critical section is one read and one write.
 */
const LOCK_STALE_MS = 10_000;

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
 * immediately afterwards) are sync, and making them async to acquire a lock
 * would ripple through the whole dispatch return path for no benefit.
 *
 * Failing to acquire runs `fn` anyway rather than dropping the update: an
 * un-serialised write is what we had before, so the fallback is no worse than
 * the old behaviour, while a dropped failure would be strictly worse.
 *
 * That reasoning holds for a caller with NOTHING to fall back on, and it is
 * why BreakerStore still uses the default. It does not hold for a caller that
 * can retry: QuotaCache accumulates a pending delta and only clears it once a
 * write succeeds, so for it a deferred write loses nothing while an
 * unserialised one silently loses counts — it clears the delta believing the
 * write was serialised, and the real lock holder then overwrites the file with
 * a value computed before that write existed. `requireLock` is for that case:
 * throw instead of running unserialised, and let the caller try again.
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
 * Block this thread briefly without spinning.
 *
 * Atomics.wait on a throwaway buffer is the only synchronous sleep Node
 * offers. The lock has to stay synchronous (its callers are), so the choice is
 * this or a busy loop.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without SharedArrayBuffer fall back to returning
    // immediately; the deadline still bounds the loop.
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
  // If the parent cannot be created there is nothing to lock against and
  // retrying cannot help — spinning the full timeout on EVERY call was
  // measured at 2005ms per call, forever, on an unwritable state directory.
  // Run unlocked immediately instead; the caller already tolerates that.
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return fn();
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          // Steal by RENAME, not delete. stat-then-rmdir let two waiters both
          // judge the same lock stale — the slower one's rmdir then removed
          // the faster one's FRESHLY CREATED lock, and both entered the
          // critical section, recreating the unserialised read-modify-write
          // this lock exists to prevent. Rename is atomic: exactly one waiter
          // wins it, the loser gets ENOENT and goes round the loop again.
          const tomb = `${lockDir}.stale-${process.pid}-${Date.now().toString(36)}`;
          try {
            renameSync(lockDir, tomb);
            try {
              rmdirSync(tomb);
            } catch {
              // Leftover tombstone; nothing reads `*.stale-*` names.
            }
          } catch {
            // Lost the steal race to another waiter; retry normally.
          }
          continue;
        }
      } catch {
        // mkdir failed for a reason that is not "already exists": the lock
        // vanished between the two calls, or the directory is unwritable, or
        // the name is too long. Retrying can only help in the first case.
        //
        // This branch previously `continue`d with NO sleep, so the loop spun a
        // full CPU for the whole timeout — measured at 1968ms of CPU per call
        // on an existing-but-unwritable state directory, after every dispatch
        // result. The earlier fix added a sleep to the contended branch only
        // and its commit claimed the whole defect was gone; it was not. Every
        // retry path sleeps now, and there is a test per branch.
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
    if (held) {
      try {
        rmdirSync(lockDir);
      } catch {
        // Already stolen as stale; the next acquirer owns it.
      }
    }
  }
}

