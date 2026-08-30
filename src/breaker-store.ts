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
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { CircuitBreakerSnapshot } from "./circuit-breaker.js";
import { withFileLock } from "./file-lock.js";
import { stateRoot } from "./state-dir.js";

function defaultStateDir(): string {
  const dir = stateRoot();
  return path.join(dir, "breaker_state");
}

/**
 * Route name -> filename, reversibly.
 *
 * Route names are operator-authored rather than attacker-controlled, but they
 * still land in a filename, and a route called `../../etc/passwd` must not
 * escape the state directory.
 *
 * The encode and decode MUST be inverses. They were not: encoding used
 * `%${charCodeAt(0).toString(16)}` while decoding used decodeURIComponent,
 * which agree only for ASCII. A route named `café_cli` wrote `caf%e9_cli.json`
 * — `%e9` is not valid UTF-8 percent-encoding — and reading it threw
 * `URIError: URI malformed` out of loadAll(), which the Router constructor
 * calls unguarded. One such route took down `status`, `doctor` and the MCP
 * server itself.
 *
 * encodeURIComponent produces UTF-8 percent-encoding that decodeURIComponent
 * reverses exactly. The extra replace covers the handful of characters it
 * leaves alone that are still illegal in a Windows filename. ASCII route names
 * are unchanged, so `codex_cli.json` stays readable to a human debugging it.
 */
function fileNameFor(service: string): string {
  // Case is encoded explicitly, because NTFS is case-INSENSITIVE: routes `A`
  // and `a` produced A.json and a.json, which are one file on Windows — the
  // second save clobbered the first and loadAll() returned only one of them.
  // Linux kept both, so the same config behaved differently per platform on a
  // product that calls Windows first-class. An uppercase letter becomes
  // `~<lower>`, and `~` itself is escaped first so the mapping stays
  // reversible.
  const caseFolded = service.replace(/~/g, "~~").replace(/[A-Z]/g, (c) => `~${c.toLowerCase()}`);
  const encoded = encodeURIComponent(caseFolded).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${encoded}.json`;
}

function unfoldCase(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] !== "~") {
      out += name[i];
      continue;
    }
    const next = name[i + 1];
    if (next === "~") {
      out += "~";
      i += 1;
    } else if (next !== undefined) {
      out += next.toUpperCase();
      i += 1;
    }
  }
  return out;
}

function serviceFromFileName(entry: string): string | undefined {
  try {
    return unfoldCase(decodeURIComponent(entry.slice(0, -".json".length)));
  } catch {
    // A file this module did not write, or wrote under the old broken scheme.
    // Skipping it is right: loading breaker state is best-effort, and throwing
    // here bricked every entry point in the tool.
    return undefined;
  }
}

export class BreakerStore {
  private readonly stateDir: string;
  private persistCounter = 0;
  /**
   * Routes whose record exists but could not be parsed, as of the last
   * loadAll(). See loadAll() for why this is tracked rather than shrugged off.
   */
  private unreadable: string[] = [];

  /**
   * @param stateDir directory holding one JSON file per route. Older builds
   * passed a single `breaker_state.json` FILE here; such a path is treated as
   * the legacy blob and migrated on first read.
   */
  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? defaultStateDir();
  }

  /**
   * Every route's persisted snapshot. Routes with no file are healthy by
   * construction — save() deletes a fully-healthy record rather than writing
   * a no-op one.
   *
   * A file that EXISTS but does not parse is a different thing, and used to
   * be indistinguishable from that absence: readOne() returned undefined for
   * both, so a truncated or half-written record rendered as `breaker=closed
   * failures=0`, route Ready, with nothing said by `status` or `doctor`. One
   * corrupt file silently un-tripped a route mid-cooldown — the exact failure
   * this whole module was added to prevent, arrived at from the other side.
   *
   * The lost state cannot be recovered, so this does not try to guess at it
   * (failing closed would strand a route until someone deleted a file by
   * hand). It records the route name instead, so the surfaces a person reads
   * can say the state is unknown rather than assert that it is fine.
   */
  loadAll(): Record<string, CircuitBreakerSnapshot> {
    const out: Record<string, CircuitBreakerSnapshot> = {};
    this.unreadable = [];
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
      const service = serviceFromFileName(entry);
      if (service === undefined) continue;
      const file = path.join(this.stateDir, entry);
      const snapshot = this.readOne(file);
      if (snapshot) {
        out[service] = snapshot;
        continue;
      }
      // readdir listed it a moment ago; still being there means the read
      // failed on the contents, not on a file that vanished under us.
      if (existsSync(file)) this.unreadable.push(service);
    }
    return out;
  }

  /** Routes whose record was present but unparseable at the last loadAll(). */
  unreadableRoutes(): string[] {
    return this.unreadable.slice();
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
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      // Unwritable state directory. save() and QuotaCache.saveLocalCountsSync()
      // both swallow persistence failures deliberately; this did not, so the
      // throw propagated out of Router.handleResult and discarded a COMPLETED
      // dispatch's result. The job then sat "running" until the 90s heartbeat
      // window and reported "the dispatch server exited before the run
      // finished" — which never happened. Losing breaker state is survivable;
      // losing the user's finished work to report a false cause is not.
      return mutate(undefined);
    }
    return withFileLock(file, () => {
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
        lastFailureAtMs?: number | null;
      } | null;
      if (!v || typeof v !== "object") return undefined;
      return {
        failures: typeof v.failures === "number" ? v.failures : 0,
        blockedUntilMs: typeof v.blockedUntilMs === "number" ? v.blockedUntilMs : null,
        // Round-tripped so FAILURE_DECAY_SEC works across processes; omitted
        // (not nulled) when absent, so files written by older builds read
        // back exactly as they were written.
        ...(typeof v.lastFailureAtMs === "number" ? { lastFailureAtMs: v.lastFailureAtMs } : {}),
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
    // The blob is only deleted once everything in it is durably on disk in
    // the per-route format. The first version of this migration merged into
    // MEMORY and deleted the blob — no caller ever persisted the result, so
    // the first process to call loadAll() after an upgrade (even a plain
    // `status`) consumed every live cooldown: the exact failure the comment
    // above it claimed to prevent.
    let persistedAll = true;
    try {
      const data = JSON.parse(readFileSync(legacy, "utf-8")) as Record<
        string,
        { failures?: number; blockedUntilMs?: number | null } | null
      >;
      for (const [service, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        const snapshot: CircuitBreakerSnapshot = {
          failures: typeof v.failures === "number" ? v.failures : 0,
          blockedUntilMs: typeof v.blockedUntilMs === "number" ? v.blockedUntilMs : null,
        };
        out[service] = snapshot;
        const file = path.join(this.stateDir, fileNameFor(service));
        // Per-route files win on conflict: they are newer by construction.
        if (existsSync(file)) continue;
        // Healthy records are represented by absence in the new format.
        if (snapshot.blockedUntilMs === null && snapshot.failures === 0) continue;
        try {
          this.writeAtomicSync(file, JSON.stringify(snapshot, null, 2));
        } catch {
          persistedAll = false;
        }
      }
    } catch {
      // Corrupt legacy blob — nothing to migrate, and nothing lost by
      // deleting it below.
    }
    if (!persistedAll) return; // Keep the blob; the migration re-runs next read.
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
