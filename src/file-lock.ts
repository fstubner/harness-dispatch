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

import { mkdirSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How long a held lock may go unrefreshed before another process steals it.
 *
 * A crashed holder must not wedge a route's breaker file forever. Short,
 * because the critical section is one read and one write.
 */
const LOCK_STALE_MS = 10_000;

/** Give up rather than block a dispatch indefinitely. */
/** Pause between acquisition attempts, instead of spinning. */
const RETRY_MS = 25;

const LOCK_TIMEOUT_MS = 2_000;

/**
 * Run `fn` holding an exclusive cross-process lock on one route's file.
 *
 * mkdir is the atomic test-and-set here: it fails if the directory exists, on
 * every platform, and unlike `writeFile` with `wx` it needs no cleanup path
 * distinct from the directory itself. Synchronous on purpose — the callers
 * (Router.persistBreaker, and CLI paths that exit immediately afterwards) are
 * sync, and making them async to acquire a lock would ripple through the whole
 * dispatch return path for no benefit.
 *
 * Failing to acquire runs `fn` anyway rather than dropping the update: an
 * un-serialised write is what we had before, so the fallback is no worse than
 * the old behaviour, while a dropped failure would be strictly worse.
 */
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

export function withFileLock<T>(file: string, fn: () => T): T {
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
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        // Either the lock vanished between the two calls (retry immediately is
        // right), or mkdir failed for a reason that is not "already exists" —
        // most usefully a missing parent directory, where statSync fails the
        // same way forever. The deadline check MUST happen on this path too:
        // without it this loop spun forever the first time a caller locked
        // inside a directory that did not exist yet, hanging the whole test
        // suite rather than failing.
        if (Date.now() >= deadline) break;
        continue;
      }
      if (Date.now() >= deadline) break;
      // Sleep rather than spin. This was a tight synchronous loop that burned
      // a full CPU for up to 2s under contention, on a path that runs after
      // every dispatch result.
      sleepSync(RETRY_MS);
    }
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

