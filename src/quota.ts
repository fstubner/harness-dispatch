/**
 * Quota management for harness-dispatch.
 *
 * SCOPE, stated up front because the previous version of this comment
 * overpromised: real quota numbers are available for `openai_compatible`
 * ENDPOINT routes only. CLI routes — claude_code_cli, codex_cli, cursor_cli,
 * antigravity_cli, i.e. the routes this product exists to arbitrate between —
 * always report score 1.0 and source "unknown".
 *
 * Two layers were described here. Measured 2026-08-17, neither reaches a CLI
 * route:
 *   1. Reactive — state is updated from `rateLimitHeaders`, which only
 *      OpenAICompatibleDispatcher ever sets. A CLI route's
 *      `rateLimited: true` passes the early-return guard in recordResult()
 *      and then updates nothing.
 *   2. Proactive — `checkQuota()` is a stub returning source "unknown" in
 *      BOTH dispatcher implementations, and maybeRefresh() discards
 *      "unknown". There are only two dispatchers, so this layer is currently
 *      unreachable in its entirety.
 *
 * Feeding 51 consecutive rate-limited CLI results through recordResult()
 * leaves getQuotaScore at 1.0.
 *
 * This is a real gap but NOT an unhandled one: exhaustion of a CLI route is
 * caught by the circuit breaker, which does trip on the CLI rate-limit
 * signal. What is missing is GRADUATED preference — the router cannot lean
 * toward the less-depleted of two working subscriptions, only avoid a route
 * that has already failed. Binary, not proportional.
 *
 * Left as-is deliberately rather than papered over: the breaker already
 * covers the safety-relevant case, and inventing a synthetic score from the
 * one bit CLIs actually give us would make `usage` look informative while
 * telling the reader nothing. Documented instead so the output can be read
 * correctly.
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

import type { DispatchResult, QuotaInfo } from "./types.js";
import type { Dispatcher } from "./dispatchers/base.js";
import {
  parseLimit,
  parseRemaining,
} from "./dispatchers/shared/rate-limit-headers.js";

export const DEFAULT_QUOTA_TTL_MS = 300_000; // 5 minutes
export const PROACTIVE_CHECK_TIMEOUT_MS = 15_000;

/**
 * Default quota state location — same HARNESS_DISPATCH_STATE_DIR-override,
 * else ~/.harness-dispatch/<subdir> pattern as jobs.ts/dispatch-log.ts. A
 * bare "quota_state.json" (the old default) resolves relative to
 * process.cwd(): running the router from different directories splits
 * state across stray files, and — worse — the test suite writes real
 * counts into whatever cwd the tests happen to run from (this repo's own
 * root, in dev) since nothing points it elsewhere by default.
 */
function defaultStateFile(): string {
  const dir = process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
  return path.join(dir, "quota_state.json");
}

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
  /** Calls the route declined because it was rate limited — busy, not broken. */
  localRateLimitedCount: number;
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

  toJSON(): Omit<
    QuotaStateJSON,
    "localCallCount" | "localSuccessCount" | "localFailureCount" | "localRateLimitedCount"
  > {
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
  private localRateLimitedCounts: Record<string, number>;
  private persistCounter = 0;

  constructor(
    dispatchers: Record<string, Dispatcher>,
    opts: QuotaCacheOptions = {},
  ) {
    this.dispatchers = dispatchers;
    this.ttlMs = opts.ttlMs ?? DEFAULT_QUOTA_TTL_MS;
    this.stateFile = opts.stateFile ?? defaultStateFile();

    for (const name of Object.keys(dispatchers)) {
      this.states[name] = new QuotaState(name);
    }
    const loaded = this.loadLocalCounts();
    this.localCounts = loaded.calls;
    this.localSuccessCounts = loaded.success;
    this.localFailureCounts = loaded.failure;
    this.localRateLimitedCounts = loaded.rateLimited;
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
    } else if (result.rateLimited) {
      // Rate limiting is UNAVAILABILITY, not failure, and the difference is
      // not cosmetic: `usage` is what an orchestrating agent is told to check
      // before delegating, and these counts persist across restarts. Filing a
      // busy route under `failed` leaves a permanent record that it is
      // unreliable, so the agent routes away from a route that was never
      // broken — a tool quietly destroying its own reputation. The circuit
      // breaker already handles the routing consequence of a rate limit
      // properly and separately; this is only about what the numbers say.
      this.localRateLimitedCounts[service] = (this.localRateLimitedCounts[service] ?? 0) + 1;
    } else {
      this.localFailureCounts[service] = (this.localFailureCounts[service] ?? 0) + 1;
    }

    // CLI commands often exit immediately after a route. Use the synchronous
    // atomic path so local-count persistence cannot leave a temp file behind.
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
        localRateLimitedCount: this.localRateLimitedCounts[service] ?? 0,
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
    rateLimited: Record<string, number>;
  } {
    if (!existsSync(this.stateFile)) {
      return { calls: {}, success: {}, failure: {}, rateLimited: {} };
    }
    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const data = JSON.parse(raw) as Record<
        string,
        {
          local_calls?: number;
          local_success?: number;
          local_failure?: number;
          local_rate_limited?: number;
        } | null
      >;
      const calls: Record<string, number> = {};
      const success: Record<string, number> = {};
      const failure: Record<string, number> = {};
      const rateLimited: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!v) continue;
        if (typeof v.local_calls === "number") calls[k] = v.local_calls;
        if (typeof v.local_success === "number") success[k] = v.local_success;
        if (typeof v.local_failure === "number") failure[k] = v.local_failure;
        if (typeof v.local_rate_limited === "number") rateLimited[k] = v.local_rate_limited;
      }
      return { calls, success, failure, rateLimited };
    } catch {
      return { calls: {}, success: {}, failure: {}, rateLimited: {} };
    }
  }

  /**
   * Build the on-disk payload, merging new counts over any existing state.
   *
   * Known limitation: this read-modify-write is not atomic across processes.
   * Two `harness-dispatch` CLI invocations racing on the same stateFile can
   * both read the same baseline and each write back only their own count,
   * silently losing the other's increment. Left as-is deliberately —
   * localCallCount/localSuccessCount/localFailureCount are purely
   * informational (surfaced in `status`/`doctor`/`usage` output and the live
   * dashboard; see status.ts, dashboard/live.ts), never consulted by
   * QuotaState.score or any routing/billing decision — so an occasional
   * undercount here doesn't affect what the router actually does, only what
   * it reports. Not worth cross-process file locking for a display counter.
   */
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
    for (const [service, count] of Object.entries(this.localRateLimitedCounts)) {
      const bucket = existing[service] ?? {};
      bucket["local_rate_limited"] = count;
      existing[service] = bucket;
    }
    return JSON.stringify(existing, null, 2);
  }

  private nextTempStateFile(): string {
    this.persistCounter += 1;
    return `${this.stateFile}.${process.pid}.${Date.now()}.${this.persistCounter}.tmp`;
  }

  private writeStatePayloadAtomicSync(payload: string): void {
    const tmp = this.nextTempStateFile();
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

  /**
   * Write local counts to disk via a temp-file-then-rename (atomic within
   * this process — see buildStatePayload's doc comment for the known
   * cross-process caveat). Synchronous so a CLI invocation that exits
   * immediately after a route can't leave a temp file behind.
   */
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
