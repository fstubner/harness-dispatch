/**
 * Per-service circuit breaker with dynamic cooldown from provider responses.
 *
 * Ported from the Python `coding_agent.router.CircuitBreaker` class.
 * Uses `performance.now()` for monotonic seconds (equivalent to Python's
 * `time.monotonic()`), independent of wall-clock adjustments.
 */

export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC = 300;

/**
 * Hard ceiling on any cooldown, in seconds (24h).
 *
 * Belt-and-braces alongside the clamp in rate-limit-headers.ts. That one
 * guards the parser; this one guards the class, because `retryAfter` reaches
 * trip()/recordFailure() from dispatcher code paths generally, not only from
 * that parser — and because a cooldown is now written to disk and rehydrated
 * by later processes, so a bad value stops being a per-process nuisance and
 * becomes a permanent one.
 */
export const MAX_COOLDOWN_SEC = 24 * 60 * 60;

/**
 * Gap after which the consecutive-failure count restarts (30 min).
 *
 * Without this the counter only ever reset on success, so five failures
 * separated by days tripped the breaker as readily as five in a burst — the
 * opposite of what a breaker is for.
 */
export const FAILURE_DECAY_SEC = 30 * 60;

function boundedCooldown(retryAfterSec?: number): number {
  if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }
  return Math.min(retryAfterSec, MAX_COOLDOWN_SEC);
}

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface CircuitBreakerStatus {
  tripped: boolean;
  failures: number;
  cooldownRemainingSec?: number;
}

export interface CircuitBreakerSnapshot {
  failures: number;
  /** Wall-clock epoch ms when the current cooldown ends; null when not tripped. */
  blockedUntilMs: number | null;
  /**
   * Wall-clock epoch ms of the most recent failure; null when none recorded.
   * Optional because snapshots written by older builds lack it — restoring
   * one of those just means decay cannot apply until the next failure, the
   * same behaviour those builds had.
   *
   * This field is what makes FAILURE_DECAY_SEC real across processes: every
   * dispatch runs in a detached child that rebuilds a breaker from the
   * persisted snapshot per event, so without persisting the failure time,
   * recordFailure never saw a prior one and the decay was dead code on the
   * only path that matters — five failures spread over weeks still tripped.
   */
  lastFailureAtMs?: number | null;
}

export class CircuitBreaker {
  private failures = 0;
  private lastFailureAt: number | null = null;
  private trippedAt: number | null = null;
  private cooldown: number = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;

  get isTripped(): boolean {
    if (this.trippedAt === null) {
      return false;
    }
    if (monotonicSec() - this.trippedAt >= this.cooldown) {
      this.reset();
      return false;
    }
    return true;
  }

  recordFailure(retryAfterSec?: number): void {
    // Decay first: five failures spread across a week are not the same signal
    // as five in a row, but the counter never reset except on success, so a
    // route that fails rarely eventually tripped anyway. Any gap longer than
    // the decay window starts the count over.
    const now = monotonicSec();
    if (this.lastFailureAt !== null && now - this.lastFailureAt > FAILURE_DECAY_SEC) {
      this.failures = 0;
    }
    this.lastFailureAt = now;
    this.failures += 1;
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.trippedAt = monotonicSec();
      this.cooldown = boundedCooldown(retryAfterSec);
    }
  }

  recordSuccess(): void {
    this.reset();
  }

  /**
   * Immediately trip — use on 429 or explicit rate-limit response.
   *
   * Counts the failure as well as tripping. It did not, so `usage` reported
   * `tripped: true, failures: 0` for a route knocked out by a 429 — a
   * contradiction on the surface an orchestrator is told to consult before
   * delegating, and one that makes a real trip look like a bookkeeping bug.
   * A 429 IS a failed attempt; the threshold path already counts it.
   */
  trip(retryAfterSec?: number): void {
    // monotonicSec, matching recordFailure — this field feeds the decay
    // window and lastFailureWallMs, both of which read it as monotonic
    // seconds. An epoch value here would put the last failure decades in the
    // future and disable decay entirely.
    this.failures += 1;
    this.lastFailureAt = monotonicSec();
    this.trippedAt = monotonicSec();
    this.cooldown = boundedCooldown(retryAfterSec);
  }

  cooldownRemaining(): number {
    if (!this.isTripped || this.trippedAt === null) {
      return 0;
    }
    return Math.max(0, this.cooldown - (monotonicSec() - this.trippedAt));
  }

  status(): CircuitBreakerStatus {
    if (!this.isTripped) {
      return { tripped: false, failures: this.failures };
    }
    return {
      tripped: true,
      failures: this.failures,
      cooldownRemainingSec: Math.round(this.cooldownRemaining() * 10) / 10,
    };
  }

  /**
   * Wall-clock snapshot for cross-process persistence. `trippedAt`/`cooldown`
   * are deliberately monotonic (performance.now(), immune to clock
   * adjustments mid-run) so they can't be written to disk as-is; this
   * converts the live state to an absolute deadline a future process (after
   * a restart) can compare against its own Date.now().
   */
  snapshot(): CircuitBreakerSnapshot {
    // Order matters: the isTripped getter auto-resets on expiry, which also
    // clears lastFailureAt — evaluate it first so the snapshot reflects the
    // post-expiry state.
    if (!this.isTripped) {
      return {
        failures: this.failures,
        blockedUntilMs: null,
        lastFailureAtMs: this.lastFailureWallMs(),
      };
    }
    return {
      failures: this.failures,
      blockedUntilMs: Date.now() + this.cooldownRemaining() * 1000,
      lastFailureAtMs: this.lastFailureWallMs(),
    };
  }

  /** The monotonic lastFailureAt as a wall-clock epoch, for persistence. */
  private lastFailureWallMs(): number | null {
    if (this.lastFailureAt === null) return null;
    return Date.now() - (monotonicSec() - this.lastFailureAt) * 1000;
  }

  /**
   * Hydrate from a snapshot persisted by a previous process. A
   * `blockedUntilMs` already in the past is treated as expired, matching
   * this class's own auto-reset-on-expiry semantics.
   */
  restore(snapshot: CircuitBreakerSnapshot): void {
    this.failures = snapshot.failures;
    // Rehydrate the failure clock so FAILURE_DECAY_SEC keeps working across
    // processes (a failure age in the future, from clock skew, clamps to 0
    // rather than extending the decay window).
    this.lastFailureAt =
      typeof snapshot.lastFailureAtMs === "number"
        ? monotonicSec() - Math.max(0, (Date.now() - snapshot.lastFailureAtMs) / 1000)
        : null;
    if (snapshot.blockedUntilMs === null) {
      this.trippedAt = null;
      return;
    }
    const remainingSec = (snapshot.blockedUntilMs - Date.now()) / 1000;
    if (remainingSec <= 0) {
      this.trippedAt = null;
      return;
    }
    // Clamped on the way back in too: state written by an older build (or a
    // hand-edited file) can carry a deadline centuries out, and hydrating it
    // verbatim would make the ceiling above trivially bypassable.
    this.cooldown = Math.min(remainingSec, MAX_COOLDOWN_SEC);
    this.trippedAt = monotonicSec();
  }

  private reset(): void {
    this.failures = 0;
    this.lastFailureAt = null;
    this.trippedAt = null;
    this.cooldown = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }
}
