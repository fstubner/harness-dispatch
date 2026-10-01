/**
 * A usage limit's stated reset time becomes the breaker's cooldown.
 *
 * Every limit message below is quoted verbatim from the real dispatch log
 * (~/.harness-dispatch/logs/dispatches.jsonl). Before this, Codex's came back
 * as `retryAfter: null` (so the breaker used its 300 s default and the router
 * re-tried a route its provider had said was out for up to five days), and
 * Claude's was not recognised as a limit at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectRateLimit } from "../../src/dispatchers/generic-cli.js";
import { statedResetSeconds } from "../../src/dispatchers/shared/rate-limit-reset.js";
import { CircuitBreaker, MAX_COOLDOWN_SEC } from "../../src/circuit-breaker.js";

const CODEX_DATED =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:34 PM.";
const CODEX_TIME_ONLY =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:50 PM.";
const CLAUDE_SESSION = "You've hit your session limit · resets 1:30am (Europe/Dublin)";

/** Codex states machine-local time with no zone, so expectations are built the same way. */
const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo, d, h, mi).getTime();

afterEach(() => {
  vi.useRealTimers();
});

describe("statedResetSeconds", () => {
  it("reads Codex's dated reset in local time", () => {
    const now = local(2026, 8, 20, 10, 0);
    expect(statedResetSeconds(CODEX_DATED, now)).toBe((local(2026, 8, 26, 13, 34) - now) / 1000);
  });

  it("reads a bare time as later today", () => {
    const now = local(2026, 8, 26, 10, 0);
    expect(statedResetSeconds(CODEX_TIME_ONLY, now)).toBe((local(2026, 8, 26, 14, 50) - now) / 1000);
  });

  it("reads a bare time already past today as tomorrow", () => {
    const now = local(2026, 8, 26, 15, 0);
    expect(statedResetSeconds(CODEX_TIME_ONLY, now)).toBe((local(2026, 8, 27, 14, 50) - now) / 1000);
  });

  it("reads Claude's reset in the zone it names, not the machine's", () => {
    // The real row was logged at 2026-07-24T23:24Z. Dublin is UTC+1 in July,
    // so 1:30am there is 00:30Z, 66 minutes later — whatever zone runs this.
    const now = Date.parse("2026-07-24T23:24:00Z");
    expect(statedResetSeconds(CLAUDE_SESSION, now)).toBe(66 * 60);
  });

  it("returns null when nothing states a time, or the time has passed", () => {
    expect(statedResetSeconds("You've hit your usage limit Get Cursor Pro for more Agent usage")).toBeNull();
    const after = local(2026, 8, 27, 9, 0);
    expect(statedResetSeconds(CODEX_DATED, after)).toBeNull();
  });
});

describe("detectRateLimit uses the stated reset", () => {
  it("gives Codex's limit the provider's own reset as retryAfter", () => {
    vi.useFakeTimers();
    const now = local(2026, 8, 26, 10, 0);
    vi.setSystemTime(now);
    const r = detectRateLimit(CODEX_DATED);
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfter).toBe((local(2026, 8, 26, 13, 34) - now) / 1000);
  });

  it("recognises Claude's session limit as a rate limit, with its reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-24T23:24:00Z"));
    expect(detectRateLimit(CLAUDE_SESSION)).toEqual({ rateLimited: true, retryAfter: 66 * 60 });
  });

  it("still prefers an explicit retry-after", () => {
    expect(detectRateLimit(`rate limit exceeded, retry after 42. ${CODEX_TIME_ONLY}`).retryAfter).toBe(42);
  });

  it("trips the breaker until the stated reset, capped at 24 h", () => {
    vi.useFakeTimers();
    const now = local(2026, 8, 20, 10, 0);
    vi.setSystemTime(now);
    const { retryAfter } = detectRateLimit(CODEX_DATED);
    const breaker = new CircuitBreaker();
    breaker.trip(retryAfter ?? undefined);
    // Six days out: held for the 24 h ceiling, and the next attempt re-trips.
    const blockedUntil = breaker.snapshot().blockedUntilMs!;
    expect(Math.abs(blockedUntil - (now + MAX_COOLDOWN_SEC * 1000))).toBeLessThan(1000);
  });
});
