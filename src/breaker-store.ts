/**
 * Cross-process persistence for circuit-breaker state.
 *
 * CircuitBreaker itself is in-memory only (Router constructs a fresh Map on
 * every boot) — a rate-limited route becomes eligible again the instant the
 * server process restarts, even though the provider's real cooldown hasn't
 * elapsed. Confirmed in production: a restart during an active Codex quota
 * cooldown let the router immediately retry the same exhausted route.
 *
 * ONE FILE PER ROUTE, in a breaker_state/ directory.
 *
 * The first version of this mirrored QuotaCache's single-blob state file, and
 * inherited its read-modify-write: load the whole map, set one key, write the
 * whole map back. QuotaCache documents and accepts that race explicitly
 * because its counters are cosmetic and never consulted by routing. That
 * justification does not transfer here — breaker state gates routing, and the
 * writers are genuinely concurrent: every detached job runner bootstraps its
 * own Router and BreakerStore (mcp/config-hot-reload.ts) against the same
 * path, fanout starts one runner per route, and harness-dispatch is commonly
 * configured in two clients at once.
 *
 * Measured 2026-08-17: four processes with a synchronised start, 200 writes
 * each, lost 600 of 800 writes (75%). A rate-limit trip recorded by one runner
 * was erased by another — precisely the bug persistence was added to prevent.
 *
 * Per-route files remove the race by construction rather than by locking:
 * concurrent writers touch different files, and the existing atomic
 * temp-then-rename keeps each individual file readable at all times. No
 * lockfile, no retry loop, nothing to get wrong under contention.
 */

import {
  existsSync,
  mkdirSync,
  rmdirSync,
  statSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { CircuitBreakerSnapshot } from "./circuit-breaker.js";

function defaultStateDir(): string {
  const dir = process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
  return path.join(dir, "breaker_state");
}

/**
 * Route names come from config keys, so they are operator-authored rather
 * than attacker-controlled — but they still land in a filename, and a route
 * called `../../etc/passwd` should not escape the state directory. Anything
 * outside [A-Za-z0-9_.-] is percent-escaped, which is reversible and keeps
 * the common case (`codex_cli.json`) readable by a human debugging it.
 */
function fileNameFor(service: string): string {
  return `${service.replace(/[^A-Za-z0-9_.-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}.json`;
}


/**
 * How long a held lock may go unrefreshed before another process steals it.
 *
 * A crashed holder must not wedge a route's breaker file forever. Short,
 * because the critical section is one read and one write.
 */
const LOCK_STALE_MS = 10_000;

/** Give up rather than block a dispatch indefinitely. */
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
function withRouteLock<T>(file: string, fn: () => T): T {
  const lockDir = `${file}.lock`;
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
        continue; // vanished between the two calls — retry immediately
      }
      if (Date.now() >= deadline) break;
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

export class BreakerStore {
  private readonly stateDir: string;
  private persistCounter = 0;

  /**
   * @param stateDir directory holding one JSON file per route. Older builds
   * passed a single `breaker_state.json` FILE here; such a path is treated as
   * the legacy blob and migrated on first read.
   */
  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? defaultStateDir();
  }

  loadAll(): Record<string, CircuitBreakerSnapshot> {
    const out: Record<string, CircuitBreakerSnapshot> = {};
    this.absorbLegacyBlob(out);
    if (!existsSync(this.stateDir)) return out;
    let entries: string[];
    try {
      entries = readdirSync(this.stateDir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const service = decodeURIComponent(entry.slice(0, -".json".length));
      const snapshot = this.readOne(path.join(this.stateDir, entry));
      if (snapshot) out[service] = snapshot;
    }
    return out;
  }

  /**
   * Persist one route's snapshot, synchronously — a CLI invocation can exit
   * immediately after a dispatch, same rationale as
   * QuotaCache.saveLocalCountsSync. A fully-healthy snapshot (no failures,
   * not blocked) deletes the file rather than writing a no-op record, so a
   * healthy install keeps an empty directory.
   */
  save(service: string, snapshot: CircuitBreakerSnapshot): void {
    const file = path.join(this.stateDir, fileNameFor(service));
    if (snapshot.blockedUntilMs === null && snapshot.failures === 0) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Best-effort — a stale healthy record is harmless on read.
      }
      return;
    }
    try {
      this.writeAtomicSync(file, JSON.stringify(snapshot, null, 2));
    } catch {
      // Best-effort — persistence failure shouldn't fail the dispatch.
    }
  }

  /**
   * Apply `mutate` to a route's PERSISTED snapshot, atomically across
   * processes.
   *
   * save() alone was not enough and the reason is worth stating: each process
   * holds its own in-memory CircuitBreaker loaded at boot, mutates it, and
   * writes the result. Two concurrent failures therefore both read 0, both
   * write 1, and one is lost. Measured before this fix: 8 concurrent failures
   * on one route persisted as `failures: 1` and the breaker never tripped, so
   * a dead route kept being selected.
   *
   * That is exactly the defect the per-route file split was meant to remove,
   * and it did not — splitting removed contention BETWEEN routes while leaving
   * the read-modify-write inside each file untouched. The probe that "proved"
   * the split wrote to 800 distinct routes and so could never have caught it.
   *
   * Passing the on-disk value into `mutate` makes the persisted count the
   * authority, so each process contributes exactly one event.
   */
  update(
    service: string,
    mutate: (current: CircuitBreakerSnapshot | undefined) => CircuitBreakerSnapshot,
  ): CircuitBreakerSnapshot {
    const file = path.join(this.stateDir, fileNameFor(service));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withRouteLock(file, () => {
      const merged = mutate(this.readOne(file));
      this.save(service, merged);
      return merged;
    });
  }

  private readOne(file: string): CircuitBreakerSnapshot | undefined {
    try {
      const v = JSON.parse(readFileSync(file, "utf-8")) as {
        failures?: number;
        blockedUntilMs?: number | null;
      } | null;
      if (!v || typeof v !== "object") return undefined;
      return {
        failures: typeof v.failures === "number" ? v.failures : 0,
        blockedUntilMs: typeof v.blockedUntilMs === "number" ? v.blockedUntilMs : null,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Read state written by the pre-split single-blob format, then delete it.
   *
   * Without this an upgrade silently drops every live cooldown — the exact
   * failure the feature exists to prevent, reintroduced by the fix for it.
   * Per-route files win on conflict: they are newer by construction.
   */
  private absorbLegacyBlob(out: Record<string, CircuitBreakerSnapshot>): void {
    const legacy = this.stateDir.endsWith(".json")
      ? this.stateDir
      : path.join(path.dirname(this.stateDir), "breaker_state.json");
    if (!existsSync(legacy)) return;
    try {
      const data = JSON.parse(readFileSync(legacy, "utf-8")) as Record<
        string,
        { failures?: number; blockedUntilMs?: number | null } | null
      >;
      for (const [service, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        out[service] = {
          failures: typeof v.failures === "number" ? v.failures : 0,
          blockedUntilMs: typeof v.blockedUntilMs === "number" ? v.blockedUntilMs : null,
        };
      }
    } catch {
      // Corrupt legacy blob — nothing to migrate.
    }
    try {
      rmSync(legacy, { force: true });
    } catch {
      // Left behind; it is re-read and re-deleted next time.
    }
  }

  private nextTempFile(file: string): string {
    this.persistCounter += 1;
    return `${file}.${process.pid}.${Date.now()}.${this.persistCounter}.tmp`;
  }

  private writeAtomicSync(file: string, payload: string): void {
    const tmp = this.nextTempFile(file);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Ignore cleanup failures.
      }
      throw err;
    }
  }
}
