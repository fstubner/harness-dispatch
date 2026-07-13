/**
 * Quota management for harness-router.
 *
 * Ported from `coding_agent.quota`. Two-layer approach:
 *   1. Reactive — quota state is updated from every dispatch response
 *      (rate-limit headers on 429s, or usage headers on success).
 *   2. Proactive — each dispatcher can optionally implement `checkQuota()`
 *      for a live snapshot. Results are cached with a TTL to avoid
 *      hammering provider APIs.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";

import type { DispatchResult, QuotaInfo } from "./types.js";
import type { Dispatcher } from "./dispatchers/base.js";
import {
  parseLimit,
  parseRemaining,
} from "./dispatchers/shared/rate-limit-headers.js";

export const DEFAULT_QUOTA_TTL_MS = 300_000; // 5 minutes
export const PROACTIVE_CHECK_TIMEOUT_MS = 15_000;

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface QuotaStateJSON {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  score: number;
  source: string;
  updatedAgeSec: number;
  localCallCount: number;
  localSuccessCount: number;
  localFailureCount: number;
}

/** Mutable quota snapshot for one service, updated reactively. */
export class QuotaState {
  service: string;
  remaining: number | null = null;
  limit: number | null = null;
  used: number | null = null;
  resetAt: string | null = null;
  source: string = "unknown";
  updatedAtSec = 0; // performance.now() seconds

  constructor(service: string) {
    this.service = service;
  }

  get score(): number {
    if (this.remaining !== null && this.limit && this.limit > 0) {
      return Math.max(0, Math.min(1, this.remaining / this.limit));
    }
    if (this.used !== null && this.limit && this.limit > 0) {
      return Math.max(0, Math.min(1, (this.limit - this.used) / this.limit));
    }
    return 1.0;
  }

  updateFromQuotaInfo(info: QuotaInfo): void {
    this.remaining = info.remaining ?? null;
    this.limit = info.limit ?? null;
    this.used = info.used ?? null;
    this.resetAt = info.resetAt ?? null;
    this.source = info.source;
    this.updatedAtSec = monotonicSec();
  }

  toJSON(): Omit<QuotaStateJSON, "localCallCount" | "localSuccessCount" | "localFailureCount"> {
    return {
      used: this.used,
      limit: this.limit,
      remaining: this.remaining,
      resetAt: this.resetAt,
      score: this.score,
      source: this.source,
      updatedAgeSec:
        Math.round((monotonicSec() - this.updatedAtSec) * 10) / 10,
    };
  }
}

export interface QuotaCacheOptions {
  ttlMs?: number;
  stateFile?: string;
}

/**
 * Manages quota state for all dispatchers.
 */
export class QuotaCache {
  private dispatchers: Record<string, Dispatcher>;
  private ttlMs: number;
  private stateFile: string;
  private states: Record<string, QuotaState> = {};
  /** performance.now() seconds of last proactive check per service. */
  private lastChecked: Record<string, number> = {};
  private localCounts: Record<string, number>;
  private localSuccessCounts: Record<string, number>;
  private localFailureCounts: Record<string, number>;
  private persistVersion = 0;
  private persistCounter = 0;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    dispatchers: Record<string, Dispatcher>,
    opts: QuotaCacheOptions = {},
  ) {
    this.dispatchers = dispatchers;
    this.ttlMs = opts.ttlMs ?? DEFAULT_QUOTA_TTL_MS;
    this.stateFile = opts.stateFile ?? "quota_state.json";

    for (const name of Object.keys(dispatchers)) {
      this.states[name] = new QuotaState(name);
    }
    const loaded = this.loadLocalCounts();
    this.localCounts = loaded.calls;
    this.localSuccessCounts = loaded.success;
    this.localFailureCounts = loaded.failure;
  }

  // ------------------------------------------------------------------
  // Public API — called by Router
  // ------------------------------------------------------------------

  async getQuotaScore(service: string): Promise<number> {
    await this.maybeRefresh(service);
    const state = this.states[service];
    return state ? state.score : 1.0;
  }

  recordResult(service: string, result: DispatchResult): void {
    this.localCounts[service] = (this.localCounts[service] ?? 0) + 1;
    if (result.success) {
      this.localSuccessCounts[service] = (this.localSuccessCounts[service] ?? 0) + 1;
    } else {
      this.localFailureCounts[service] = (this.localFailureCounts[service] ?? 0) + 1;
    }

    // CLI commands often exit immediately after a route. Use the synchronous
    // atomic path so local-count persistence cannot leave a temp file behind.
    this.persistVersion += 1;
    this.saveLocalCountsSync();

    if (!result.rateLimitHeaders && !result.rateLimited) {
      return;
    }

    let state = this.states[service];
    if (!state) {
      state = new QuotaState(service);
      this.states[service] = state;
    }

    if (result.rateLimitHeaders) {
      const remaining = parseRemaining(result.rateLimitHeaders);
      const limit = parseLimit(result.rateLimitHeaders);
      if (remaining !== null || limit !== null) {
        state.remaining = remaining;
        state.limit = limit;
        state.source = "headers";
        state.updatedAtSec = monotonicSec();
      }
    }
  }

  async getQuotaInfo(service: string): Promise<QuotaInfo | null> {
    await this.maybeRefresh(service);
    const state = this.states[service];
    if (!state) {
      return null;
    }
    const info: QuotaInfo = {
      service,
      source: state.source as QuotaInfo["source"],
    };
    if (state.used !== null) info.used = state.used;
    if (state.limit !== null) info.limit = state.limit;
    if (state.remaining !== null) info.remaining = state.remaining;
    if (state.resetAt !== null) info.resetAt = state.resetAt;
    return info;
  }

  async fullStatus(): Promise<Record<string, QuotaStateJSON>> {
    const out: Record<string, QuotaStateJSON> = {};
    for (const service of Object.keys(this.dispatchers)) {
      await this.maybeRefresh(service);
      const state = this.states[service] ?? new QuotaState(service);
      out[service] = {
        ...state.toJSON(),
        localCallCount: this.localCounts[service] ?? 0,
        localSuccessCount: this.localSuccessCounts[service] ?? 0,
        localFailureCount: this.localFailureCounts[service] ?? 0,
      };
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Proactive refresh
  // ------------------------------------------------------------------

  private async maybeRefresh(service: string): Promise<void> {
    const last = this.lastChecked[service];
    // Node's performance.now() starts near 0 at process start, unlike Python's
    // time.monotonic() (which references OS boot). Treat "never checked" as a
    // force-refresh rather than comparing against 0 — otherwise the first call
    // in a freshly-started process may short-circuit before TTL elapses.
    if (last !== undefined && monotonicSec() - last < this.ttlMs / 1000) {
      return;
    }

    const dispatcher = this.dispatchers[service];
    if (!dispatcher) {
      return;
    }

    this.lastChecked[service] = monotonicSec();
    try {
      const info = await withTimeout(
        dispatcher.checkQuota(),
        PROACTIVE_CHECK_TIMEOUT_MS,
      );
      if (info.source !== "unknown") {
        let state = this.states[service];
        if (!state) {
          state = new QuotaState(service);
          this.states[service] = state;
        }
        state.updateFromQuotaInfo(info);
      }
    } catch {
      // Proactive check failed — rely on reactive state.
    }
  }

  // ------------------------------------------------------------------
  // Local count persistence
  // ------------------------------------------------------------------

  private loadLocalCounts(): {
    calls: Record<string, number>;
    success: Record<string, number>;
    failure: Record<string, number>;
  } {
    if (!existsSync(this.stateFile)) {
      return { calls: {}, success: {}, failure: {} };
    }
    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const data = JSON.parse(raw) as Record<
        string,
        { local_calls?: number; local_success?: number; local_failure?: number } | null
      >;
      const calls: Record<string, number> = {};
      const success: Record<string, number> = {};
      const failure: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!v) continue;
        if (typeof v.local_calls === "number") calls[k] = v.local_calls;
        if (typeof v.local_success === "number") success[k] = v.local_success;
        if (typeof v.local_failure === "number") failure[k] = v.local_failure;
      }
      return { calls, success, failure };
    } catch {
      return { calls: {}, success: {}, failure: {} };
    }
  }

  /** Build the on-disk payload, merging new counts over any existing state. */
  private buildStatePayload(): string {
    let existing: Record<string, Record<string, unknown>> = {};
    try {
      if (existsSync(this.stateFile)) {
        const raw = readFileSync(this.stateFile, "utf-8");
        const parsed = JSON.parse(raw) as Record<
          string,
          Record<string, unknown>
        > | null;
        if (parsed && typeof parsed === "object") {
          existing = parsed;
        }
      }
    } catch {
      existing = {};
    }
    for (const [service, count] of Object.entries(this.localCounts)) {
      const bucket = existing[service] ?? {};
      bucket["local_calls"] = count;
      existing[service] = bucket;
    }
    for (const [service, count] of Object.entries(this.localSuccessCounts)) {
      const bucket = existing[service] ?? {};
      bucket["local_success"] = count;
      existing[service] = bucket;
    }
    for (const [service, count] of Object.entries(this.localFailureCounts)) {
      const bucket = existing[service] ?? {};
      bucket["local_failure"] = count;
      existing[service] = bucket;
    }
    return JSON.stringify(existing, null, 2);
  }

  private nextTempStateFile(): string {
    this.persistCounter += 1;
    return `${this.stateFile}.${process.pid}.${Date.now()}.${this.persistCounter}.tmp`;
  }

  private async writeStatePayloadAtomic(payload: string): Promise<void> {
    const tmp = this.nextTempStateFile();
    try {
      await writeFile(tmp, payload);
      await rename(tmp, this.stateFile);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        // Ignore cleanup failures; the original write error is intentionally
        // swallowed by the caller because persistence is best-effort.
      }
      throw err;
    }
  }

  private writeStatePayloadAtomicSync(payload: string): void {
    const tmp = this.nextTempStateFile();
    try {
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

  private async saveLocalCounts(version: number): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      if (version < this.persistVersion) {
        return;
      }
      try {
        const payload = this.buildStatePayload();
        if (version < this.persistVersion) {
          return;
        }
        await this.writeStatePayloadAtomic(payload);
      } catch {
        // Best-effort; the in-memory count remains correct.
      }
    });
    await this.persistQueue;
  }

  /** Synchronous variant for tests where awaiting the async write is awkward. */
  saveLocalCountsSync(): void {
    try {
      this.writeStatePayloadAtomicSync(this.buildStatePayload());
    } catch {
      // Ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
