/**
 * Per-service circuit breaker with dynamic cooldown from provider responses.
 *
 * Ported from the Python `coding_agent.router.CircuitBreaker` class.
 * Uses `performance.now()` for monotonic seconds (equivalent to Python's
 * `time.monotonic()`), independent of wall-clock adjustments.
 */

export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC = 300;

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
}

export class CircuitBreaker {
  private failures = 0;
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
    this.failures += 1;
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.trippedAt = monotonicSec();
      this.cooldown =
        retryAfterSec && retryAfterSec > 0
          ? retryAfterSec
          : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
    }
  }

  recordSuccess(): void {
    this.reset();
  }

  /** Immediately trip — use on 429 or explicit rate-limit response. */
  trip(retryAfterSec?: number): void {
    this.trippedAt = monotonicSec();
    this.cooldown =
      retryAfterSec && retryAfterSec > 0
        ? retryAfterSec
        : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
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
    if (!this.isTripped) {
      return { failures: this.failures, blockedUntilMs: null };
    }
    return { failures: this.failures, blockedUntilMs: Date.now() + this.cooldownRemaining() * 1000 };
  }

  /**
   * Hydrate from a snapshot persisted by a previous process. A
   * `blockedUntilMs` already in the past is treated as expired, matching
   * this class's own auto-reset-on-expiry semantics.
   */
  restore(snapshot: CircuitBreakerSnapshot): void {
    this.failures = snapshot.failures;
    if (snapshot.blockedUntilMs === null) {
      this.trippedAt = null;
      return;
    }
    const remainingSec = (snapshot.blockedUntilMs - Date.now()) / 1000;
    if (remainingSec <= 0) {
      this.trippedAt = null;
      return;
    }
    this.cooldown = remainingSec;
    this.trippedAt = monotonicSec();
  }

  private reset(): void {
    this.failures = 0;
    this.trippedAt = null;
    this.cooldown = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }
}
