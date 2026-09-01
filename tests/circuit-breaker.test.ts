import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC,
  CIRCUIT_BREAKER_THRESHOLD,
  CircuitBreaker,
  FAILURE_DECAY_SEC,
  MAX_COOLDOWN_SEC,
} from "../src/circuit-breaker.js";

/**
 * Stub `performance.now()` with a mutable counter so we can simulate time
 * advancement deterministically. CircuitBreaker reads `performance.now() / 1000`.
 */
let nowMs = 0;

beforeEach(() => {
  nowMs = 1_000_000; // arbitrary starting point, non-zero so we can detect state changes
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function advanceSec(sec: number): void {
  nowMs += sec * 1000;
}

describe("CircuitBreaker", () => {
  it("starts untripped with zero failures", () => {
    const cb = new CircuitBreaker();
    expect(cb.isTripped).toBe(false);
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
    expect(cb.cooldownRemaining()).toBe(0);
  });

  it("trips after threshold failures with default cooldown", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(true);
    const status = cb.status();
    expect(status.tripped).toBe(true);
    expect(status.failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(status.cooldownRemainingSec).toBeGreaterThan(0);
    expect(status.cooldownRemainingSec).toBeLessThanOrEqual(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC,
    );
  });

  it("auto-resets when cooldown expires", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(true);

    advanceSec(CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC + 1);

    expect(cb.isTripped).toBe(false);
    // After the reset the status should reflect zero failures.
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
  });

  it("trip(retryAfterSec) honours the provided cooldown", () => {
    const cb = new CircuitBreaker();
    cb.trip(42);
    expect(cb.isTripped).toBe(true);
    // Right after trip(), cooldownRemaining() should be close to 42.
    const remaining = cb.cooldownRemaining();
    expect(remaining).toBeGreaterThan(41);
    expect(remaining).toBeLessThanOrEqual(42);

    advanceSec(43);
    expect(cb.isTripped).toBe(false);
  });

  it("trip() falls back to default when retryAfter is missing / non-positive", () => {
    const cb = new CircuitBreaker();
    cb.trip();
    expect(cb.cooldownRemaining()).toBeGreaterThan(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC - 1,
    );

    const cb2 = new CircuitBreaker();
    cb2.trip(-5);
    expect(cb2.cooldownRemaining()).toBeGreaterThan(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC - 1,
    );
  });

  it("recordFailure(retryAfterSec) uses retryAfter when threshold is crossed", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(false);
    cb.recordFailure(77);
    expect(cb.isTripped).toBe(true);
    const remaining = cb.cooldownRemaining();
    expect(remaining).toBeGreaterThan(75);
    expect(remaining).toBeLessThanOrEqual(77);
  });

  it("recordSuccess resets failure counter", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.status().failures).toBe(3);
    cb.recordSuccess();
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
  });

  it("recordFailure below threshold keeps the breaker closed", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(false);
    expect(cb.status().failures).toBe(CIRCUIT_BREAKER_THRESHOLD - 1);
  });

  it("restarts the failure count after a long gap instead of tripping on stale failures", () => {
    // Five failures across a week are not the signal a breaker exists to
    // catch, but the counter only ever reset on success, so a route that
    // fails rarely tripped anyway.
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) cb.recordFailure();
    expect(cb.status().failures).toBe(CIRCUIT_BREAKER_THRESHOLD - 1);

    advanceSec(FAILURE_DECAY_SEC + 1);
    cb.recordFailure();

    expect(cb.isTripped).toBe(false);
    expect(cb.status().failures).toBe(1);
  });

  it("still trips on failures inside the decay window", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      advanceSec(1);
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(true);
  });

  describe("cooldown ceiling", () => {
    // An unbounded retryAfter reached trip() from dispatcher code generally,
    // not just from the header parser, and a cooldown is now written to disk
    // and rehydrated — so a bad value stopped being a per-process nuisance
    // and became a permanent one. Clamped in three places: parser, class, and
    // restore.
    it("clamps trip() to 24h no matter how large retryAfter is", () => {
      const cb = new CircuitBreaker();
      cb.trip(1.785e12); // a millisecond epoch read as seconds
      expect(cb.cooldownRemaining()).toBeLessThanOrEqual(MAX_COOLDOWN_SEC);
      expect(cb.cooldownRemaining()).toBeGreaterThan(MAX_COOLDOWN_SEC - 5);
    });

    it("clamps recordFailure() at the threshold too", () => {
      const cb = new CircuitBreaker();
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) cb.recordFailure();
      cb.recordFailure(1.785e12);
      expect(cb.cooldownRemaining()).toBeLessThanOrEqual(MAX_COOLDOWN_SEC);
    });

    it("clamps a restored deadline, so persisted junk can't outlive the ceiling", () => {
      const cb = new CircuitBreaker();
      cb.restore({ failures: 5, blockedUntilMs: Date.now() + 1.785e15 });
      expect(cb.isTripped).toBe(true);
      expect(cb.cooldownRemaining()).toBeLessThanOrEqual(MAX_COOLDOWN_SEC);
    });

    it("leaves a plausible cooldown alone", () => {
      const cb = new CircuitBreaker();
      cb.trip(42);
      expect(cb.cooldownRemaining()).toBeGreaterThan(41);
      expect(cb.cooldownRemaining()).toBeLessThanOrEqual(42);
    });
  });

  describe("snapshot()/restore() — wall-clock bridge for cross-process persistence", () => {
    it("snapshot() returns blockedUntilMs: null when not tripped", () => {
      const cb = new CircuitBreaker();
      cb.recordFailure();
      expect(cb.snapshot()).toMatchObject({ failures: 1, blockedUntilMs: null });
    });

    it("snapshot() converts a live cooldown into a wall-clock deadline", () => {
      const cb = new CircuitBreaker();
      cb.trip(42);
      const before = Date.now();
      const snap = cb.snapshot();
      const after = Date.now();
      // 1, not 0: an immediate trip counts the failure it tripped on. This
      // asserted 0 incidentally — the test is about the wall-clock deadline —
      // and that 0 was the defect an acceptance pass reported as `usage`
      // showing `tripped: true, failures: 0`.
      expect(snap.failures).toBe(1);
      expect(snap.blockedUntilMs).not.toBeNull();
      // Should land ~42s out from real wall-clock time (independent of the
      // mocked performance.now() used for the breaker's own monotonic math).
      //
      // Bracketed by BOTH clock reads. The upper bound was `before + 42_000`,
      // which silently assumed zero time elapsed between capturing `before`
      // and snapshot() taking its own Date.now() — one millisecond of drift on
      // a slower machine failed it by exactly 1. Observed on ubuntu CI:
      // "expected 1787094938306 to be less than or equal to 1787094938305".
      expect(snap.blockedUntilMs!).toBeGreaterThan(before + 40_000);
      expect(snap.blockedUntilMs!).toBeLessThanOrEqual(after + 42_000);
    });

    it("restore() hydrates a still-active cooldown from a snapshot", () => {
      const cb = new CircuitBreaker();
      cb.restore({ failures: 5, blockedUntilMs: Date.now() + 60_000 });
      expect(cb.isTripped).toBe(true);
      expect(cb.status().failures).toBe(5);
      const remaining = cb.cooldownRemaining();
      expect(remaining).toBeGreaterThan(58);
      expect(remaining).toBeLessThanOrEqual(60);
    });

    it("restore() treats an already-expired blockedUntilMs as not tripped", () => {
      const cb = new CircuitBreaker();
      cb.restore({ failures: 5, blockedUntilMs: Date.now() - 1_000 });
      expect(cb.isTripped).toBe(false);
    });

    it("restore() with blockedUntilMs: null just restores the failure count", () => {
      const cb = new CircuitBreaker();
      cb.restore({ failures: 3, blockedUntilMs: null });
      expect(cb.isTripped).toBe(false);
      expect(cb.status().failures).toBe(3);
    });

    it("round-trips through snapshot() -> restore() across two separate instances", () => {
      const original = new CircuitBreaker();
      original.trip(42);
      const snap = original.snapshot();

      const restored = new CircuitBreaker();
      restored.restore(snap);
      expect(restored.isTripped).toBe(true);
      const remaining = restored.cooldownRemaining();
      expect(remaining).toBeGreaterThan(40);
      expect(remaining).toBeLessThanOrEqual(42);
    });
  });
});

describe("CircuitBreaker — failure decay across snapshot/restore", () => {
  // Every real dispatch runs in a detached child that rebuilds a breaker from
  // the persisted snapshot PER EVENT (router.handleResult), so decay only
  // exists at all if the failure clock survives the round trip. It did not:
  // the snapshot carried failures + blockedUntilMs only, restore left
  // lastFailureAt null, and five failures spread over weeks tripped the
  // breaker as readily as five in a burst — on the only path that matters.
  it("a failure older than the decay window resets the count on the next failure", () => {
    const cb = new CircuitBreaker();
    cb.restore({
      failures: CIRCUIT_BREAKER_THRESHOLD - 1,
      blockedUntilMs: null,
      lastFailureAtMs: Date.now() - (FAILURE_DECAY_SEC + 60) * 1000,
    });
    cb.recordFailure();
    expect(cb.isTripped).toBe(false);
    expect(cb.status().failures).toBe(1);
  });

  it("a recent failure keeps counting toward the threshold", () => {
    const cb = new CircuitBreaker();
    cb.restore({
      failures: CIRCUIT_BREAKER_THRESHOLD - 1,
      blockedUntilMs: null,
      lastFailureAtMs: Date.now() - 1000,
    });
    cb.recordFailure();
    expect(cb.isTripped).toBe(true);
  });

  it("round-trips the failure clock through snapshot()", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    const snap = cb.snapshot();
    expect(typeof snap.lastFailureAtMs).toBe("number");
    expect(Math.abs((snap.lastFailureAtMs as number) - Date.now())).toBeLessThan(5000);
  });

  it("tolerates snapshots from older builds that lack the field", () => {
    const cb = new CircuitBreaker();
    cb.restore({ failures: 2, blockedUntilMs: null });
    cb.recordFailure();
    expect(cb.status().failures).toBe(3);
  });
});

describe("an immediate trip is a failure too", () => {
  /**
   * `trip()` set trippedAt and cooldown but never touched the counter, so
   * `usage` reported `tripped: true, failures: 0` for a route knocked out by
   * a 429 — a contradiction on the surface an orchestrator is told to consult
   * before delegating, which reads as a bookkeeping bug rather than a real
   * trip. Reproduced against the built artifact:
   *   {"tripped":true,"failures":0,"cooldownRemainingSec":30}
   */
  it("counts the failure it tripped on", () => {
    const b = new CircuitBreaker("r");
    b.trip(30);
    const s = b.status();
    expect(s.tripped).toBe(true);
    expect(s.failures).toBeGreaterThan(0);
  });

  it("still clears on success", () => {
    const b = new CircuitBreaker("r");
    b.trip(30);
    b.recordSuccess();
    expect(b.status().failures).toBe(0);
  });
});
