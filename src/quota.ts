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

import { withFileLock } from "./file-lock.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { stateRoot } from "./state-dir.js";

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
  const dir = stateRoot();
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
  /**
   * Tokens reported by the harness, summed. Deliberately not money: see
   * QuotaCache.localInputTokens for why a price cannot be stated honestly.
   */
  localInputTokens: number;
  localOutputTokens: number;
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
    | "localCallCount"
    | "localSuccessCount"
    | "localFailureCount"
    | "localRateLimitedCount"
    | "localInputTokens"
    | "localOutputTokens"
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
  /**
   * Tokens actually reported by dispatchers, summed per route.
   *
   * The honest answer to "what has this cost me". Real spend in money is NOT
   * derivable here: subscription CLIs have no per-call price at all, and
   * putting a price on tokens would mean hardcoding a per-model rate card
   * that goes stale silently — the exact kind of confident-but-wrong number
   * this tool's billing policy refuses to invent. Tokens are measured, so
   * tokens are what gets reported.
   */
  private localInputTokens: Record<string, number>;
  private localOutputTokens: Record<string, number>;
  /**
   * Increments made since the last successful persist.
   *
   * The counters above are this process's ABSOLUTE view, used for local
   * reporting. They cannot be written to a shared file directly: every
   * dispatch runs in its own detached runner that booted from the same
   * baseline, so a wave of them all write "baseline + 1" and all but one
   * increment is lost. Measured at the shipped default of
   * max_concurrent_runs: 4 — 8 dispatches were recorded as 2.
   *
   * Persisting the DELTA under a lock is what makes the count additive across
   * processes. Cleared only after a write succeeds, so a failed write is
   * retried on the next call rather than dropped.
   */
  private pendingDelta: Record<string, { calls: number; success: number; failure: number; rateLimited: number; inputTokens: number; outputTokens: number }> = {};
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
    this.localInputTokens = loaded.inputTokens;
    this.localOutputTokens = loaded.outputTokens;
  }

  // ------------------------------------------------------------------
  // Public API — called by Router
  // ------------------------------------------------------------------

  async getQuotaScore(service: string): Promise<number> {
    await this.maybeRefresh(service);
    const state = this.states[service];
    return state ? state.score : 1.0;
  }

  private bumpDelta(service: string, field: "calls" | "success" | "failure" | "rateLimited"): void {
    const d = (this.pendingDelta[service] ??= { calls: 0, success: 0, failure: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0 });
    d[field] += 1;
  }

  recordResult(service: string, result: DispatchResult): void {
    this.localCounts[service] = (this.localCounts[service] ?? 0) + 1;
    this.bumpDelta(service, "calls");
    if (result.success) {
      this.localSuccessCounts[service] = (this.localSuccessCounts[service] ?? 0) + 1;
      this.bumpDelta(service, "success");
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
      this.bumpDelta(service, "rateLimited");
    } else {
      this.localFailureCounts[service] = (this.localFailureCounts[service] ?? 0) + 1;
      this.bumpDelta(service, "failure");
    }

    if (result.tokensUsed) {
      const { input, output } = result.tokensUsed;
      this.localInputTokens[service] = (this.localInputTokens[service] ?? 0) + input;
      this.localOutputTokens[service] = (this.localOutputTokens[service] ?? 0) + output;
      const d = (this.pendingDelta[service] ??= {
        calls: 0, success: 0, failure: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0,
      });
      d.inputTokens += input;
      d.outputTokens += output;
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
        // Each field is assigned only when it ARRIVED. Both were assigned
        // unconditionally under a guard that only asks whether EITHER did, so a
        // response carrying `remaining` and no `limit` — which providers send —
        // nulled the limit this cache already knew. With no limit there is no
        // ratio, so the score went back to a full 1.0: measured at
        // `remaining: 2` scoring the same as an untouched route, and the router
        // then preferred it. Right about "some header arrived", wrong one case
        // over. Headers are a partial update, not a replacement.
        if (remaining !== null) state.remaining = remaining;
        if (limit !== null) state.limit = limit;
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

  /**
   * Re-read the persisted counts before reporting them.
   *
   * Dispatches run in DETACHED child processes. Each child records its result
   * and persists it, but the server's own QuotaCache loaded its counts at boot
   * and never looked again — so `usage` inside the process that started the
   * work reported calls=0 while the disk held calls=3. The numbers only ever
   * appeared to a LATER process, which is the opposite of useful: the
   * walkthrough tells a user to run `usage` when spend looks unexpected, and
   * on the primary surface it answered zero.
   *
   * Max rather than adopt-disk: this process writes through on every
   * recordResult, so disk is normally current, but the persist path is a
   * documented read-modify-write race (counters are informational and never
   * consulted by routing). Taking the larger value means a lost write shows a
   * stale count rather than losing one this process definitely made.
   *
   * ALL SIX counters, not four. The first version refreshed calls, success,
   * failure and rateLimited and left the two token totals behind — so the bug
   * described above went on happening for tokens alone: a real dispatch
   * returned 45,345 input tokens, the state file held them, and `usage` in
   * that same long-lived server answered 0. Only a freshly started process
   * showed the truth, which is exactly the shape this docstring says was
   * fixed. A partial fix that reads as a complete one is worse than none,
   * because the docstring stops anyone looking again.
   */
  private refreshLocalCounts(): void {
    const disk = this.loadLocalCounts();
    for (const [service, count] of Object.entries(disk.calls)) {
      this.localCounts[service] = Math.max(this.localCounts[service] ?? 0, count);
    }
    for (const [service, count] of Object.entries(disk.success)) {
      this.localSuccessCounts[service] = Math.max(this.localSuccessCounts[service] ?? 0, count);
    }
    for (const [service, count] of Object.entries(disk.failure)) {
      this.localFailureCounts[service] = Math.max(this.localFailureCounts[service] ?? 0, count);
    }
    for (const [service, count] of Object.entries(disk.rateLimited)) {
      this.localRateLimitedCounts[service] = Math.max(
        this.localRateLimitedCounts[service] ?? 0,
        count,
      );
    }
    for (const [service, count] of Object.entries(disk.inputTokens)) {
      this.localInputTokens[service] = Math.max(this.localInputTokens[service] ?? 0, count);
    }
    for (const [service, count] of Object.entries(disk.outputTokens)) {
      this.localOutputTokens[service] = Math.max(this.localOutputTokens[service] ?? 0, count);
    }
  }

  async fullStatus(): Promise<Record<string, QuotaStateJSON>> {
    this.refreshLocalCounts();
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
        localInputTokens: this.localInputTokens[service] ?? 0,
        localOutputTokens: this.localOutputTokens[service] ?? 0,
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
    inputTokens: Record<string, number>;
    outputTokens: Record<string, number>;
  } {
    const empty = { calls: {}, success: {}, failure: {}, rateLimited: {}, inputTokens: {}, outputTokens: {} };
    if (!existsSync(this.stateFile)) {
      return empty;
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
          local_input_tokens?: number;
          local_output_tokens?: number;
        } | null
      >;
      const calls: Record<string, number> = {};
      const success: Record<string, number> = {};
      const failure: Record<string, number> = {};
      const rateLimited: Record<string, number> = {};
      const inputTokens: Record<string, number> = {};
      const outputTokens: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!v) continue;
        if (typeof v.local_calls === "number") calls[k] = v.local_calls;
        if (typeof v.local_success === "number") success[k] = v.local_success;
        if (typeof v.local_failure === "number") failure[k] = v.local_failure;
        if (typeof v.local_rate_limited === "number") rateLimited[k] = v.local_rate_limited;
        if (typeof v.local_input_tokens === "number") inputTokens[k] = v.local_input_tokens;
        if (typeof v.local_output_tokens === "number") outputTokens[k] = v.local_output_tokens;
      }
      return { calls, success, failure, rateLimited, inputTokens, outputTokens };
    } catch {
      return empty;
    }
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
  /**
   * Persist this process's increments, additively and under a lock.
   *
   * buildStatePayload() writes this process's ABSOLUTE counts over whatever it
   * read. With a detached runner per dispatch that is lossy by construction:
   * every runner boots from the same baseline, so a concurrent wave all write
   * "baseline + 1" and all but one increment disappears. Measured at the
   * shipped default of max_concurrent_runs: 4 — 8 successful dispatches were
   * recorded as 2, deterministically.
   *
   * The earlier Math.max merge on read could not fix this: it recovers a value
   * that was written, and these were never written at all.
   *
   * So the delta is applied to whatever is on disk INSIDE the lock. The lock
   * alone would not have been enough either — serialised writers each holding
   * an absolute value simply take turns writing the same number.
   */
  saveLocalCountsSync(): void {
    const pending = this.pendingDelta;
    if (Object.keys(pending).length === 0) return;
    try {
      withFileLock(this.stateFile, () => {
        const existing = this.readStateFile();
        for (const [service, delta] of Object.entries(pending)) {
          const bucket = existing[service] ?? {};
          const add = (key: string, by: number): void => {
            if (by === 0) return;
            bucket[key] = (typeof bucket[key] === "number" ? (bucket[key] as number) : 0) + by;
          };
          add("local_calls", delta.calls);
          add("local_success", delta.success);
          add("local_failure", delta.failure);
          add("local_rate_limited", delta.rateLimited);
          add("local_input_tokens", delta.inputTokens);
          add("local_output_tokens", delta.outputTokens);
          existing[service] = bucket;
        }
        this.writeStatePayloadAtomicSync(JSON.stringify(existing, null, 2));
      });
      // Only cleared once the write succeeded, so a failure is retried rather
      // than silently dropped.
      this.pendingDelta = {};
    } catch {
      // Ignore — counters are informational and must never fail a dispatch.
    }
  }

  /**
   * Current on-disk state, or {} if unreadable.
   *
   * `{}` used to mean two different things — "no file yet" and "a file I could
   * not read" — and the caller applies its delta to whatever this returns and
   * writes the result back. So one unparseable read did not merely stop
   * counting: it REPLACED every route's history with a single route at 1.
   * Measured — two routes with 5 and 3 calls became one route with 1, and
   * `usage` then reported that as fact, on the surface this project's own
   * instructions tell an orchestrator to consult before delegating.
   *
   * The file is moved aside rather than overwritten. Counters are
   * informational, so this does not try to recover them; it just declines to
   * be the thing that destroys them, and leaves the evidence next to the file.
   */
  private readStateFile(): Record<string, Record<string, unknown>> {
    try {
      if (!existsSync(this.stateFile)) return {};
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf-8")) as Record<
        string,
        Record<string, unknown>
      > | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      this.quarantineUnreadableState();
      return {};
    } catch {
      this.quarantineUnreadableState();
      return {};
    }
  }

  /**
   * Move an unreadable state file aside so the write that follows cannot
   * destroy it. Best-effort in every direction: this runs on the counter path,
   * which must never fail a dispatch, and a failed rename simply leaves the
   * previous behaviour.
   */
  private quarantineUnreadableState(): void {
    try {
      renameSync(this.stateFile, `${this.stateFile}.corrupt`);
    } catch {
      // Nothing to do — the caller returns {} either way.
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
