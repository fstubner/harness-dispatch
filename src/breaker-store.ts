/**
 * Cross-process persistence for circuit-breaker state.
 *
 * CircuitBreaker itself is in-memory only (Router constructs a fresh Map on
 * every boot) — a rate-limited route becomes eligible again the instant the
 * server process restarts, even though the provider's real cooldown hasn't
 * elapsed. Confirmed in production: a restart during an active Codex quota
 * cooldown let the router immediately retry the same exhausted route.
 *
 * This mirrors QuotaCache's state-file pattern (same HARNESS_DISPATCH_STATE_DIR
 * override, same atomic temp-file-then-rename write) so a restart hydrates
 * each CircuitBreaker with any cooldown still in effect.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { CircuitBreakerSnapshot } from "./circuit-breaker.js";

function defaultStateFile(): string {
  const dir = process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
  return path.join(dir, "breaker_state.json");
}

export class BreakerStore {
  private readonly stateFile: string;
  private persistCounter = 0;

  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? defaultStateFile();
  }

  loadAll(): Record<string, CircuitBreakerSnapshot> {
    if (!existsSync(this.stateFile)) return {};
    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const data = JSON.parse(raw) as Record<
        string,
        { failures?: number; blockedUntilMs?: number | null } | null
      >;
      const out: Record<string, CircuitBreakerSnapshot> = {};
      for (const [service, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        out[service] = {
          failures: typeof v.failures === "number" ? v.failures : 0,
          blockedUntilMs: typeof v.blockedUntilMs === "number" ? v.blockedUntilMs : null,
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Persist one service's snapshot, synchronously — a CLI invocation can
   * exit immediately after a dispatch, same rationale as
   * QuotaCache.saveLocalCountsSync. A fully-healthy snapshot (no failures,
   * not blocked) removes the entry instead of writing a no-op record, so the
   * file stays empty in the common case.
   */
  save(service: string, snapshot: CircuitBreakerSnapshot): void {
    let existing: Record<string, CircuitBreakerSnapshot> = {};
    try {
      if (existsSync(this.stateFile)) {
        const raw = readFileSync(this.stateFile, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, CircuitBreakerSnapshot> | null;
        if (parsed && typeof parsed === "object") existing = parsed;
      }
    } catch {
      existing = {};
    }
    if (snapshot.blockedUntilMs === null && snapshot.failures === 0) {
      delete existing[service];
    } else {
      existing[service] = snapshot;
    }
    try {
      this.writeAtomicSync(JSON.stringify(existing, null, 2));
    } catch {
      // Best-effort — persistence failure shouldn't fail the dispatch.
    }
  }

  private nextTempFile(): string {
    this.persistCounter += 1;
    return `${this.stateFile}.${process.pid}.${Date.now()}.${this.persistCounter}.tmp`;
  }

  private writeAtomicSync(payload: string): void {
    const tmp = this.nextTempFile();
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, this.stateFile);
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
