/**
 * HTTP rate-limit header parsers.
 *
 * Ported from `src/coding_agent/dispatchers/utils.py` (parse_remaining,
 * parse_limit, parse_retry_after). Preserves the same key order and semantics:
 * - matching is case-insensitive (headers are normalized to lowercase)
 * - numeric strings with commas are NOT supported here (matches Python)
 * - Retry-After may be a delta-seconds number or an HTTP-date
 * - reset-* headers may be an epoch timestamp (seconds since 1970)
 */

const REMAINING_KEYS = [
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "ratelimit-remaining",
] as const;

const LIMIT_KEYS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-tokens-limit",
  "ratelimit-limit",
] as const;

const RETRY_AFTER_KEYS = [
  "retry-after",
  "x-ratelimit-retry-after",
] as const;

const RESET_EPOCH_KEYS = [
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

/**
 * Normalize to lowercase keys so lookups are case-insensitive.
 * Later duplicates win (matches typical HTTP proxy behavior).
 */
function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function parseIntStrict(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Python's int() rejects decimals; match that.
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatStrict(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return null;
  // Reject obvious non-numeric prefixes like "soon"/"5min".
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return null;
  return n;
}

export function parseRemaining(headers: Record<string, string>): number | null {
  const h = lower(headers);
  for (const key of REMAINING_KEYS) {
    const v = parseIntStrict(h[key]);
    if (v !== null) return v;
  }
  return null;
}

export function parseLimit(headers: Record<string, string>): number | null {
  const h = lower(headers);
  for (const key of LIMIT_KEYS) {
    const v = parseIntStrict(h[key]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Returns retry-after in seconds (fractional allowed). Sources in priority order:
 *   1. Retry-After or x-ratelimit-retry-after as delta-seconds
 *   2. Retry-After as an HTTP-date (RFC 7231)
 *   3. x-ratelimit-reset{,-requests,-tokens} as an epoch timestamp
 *
 * Returns null if no header is present or all are malformed.
 */
/**
 * Ceiling on any parsed retry-after, in seconds (24h).
 *
 * The epoch branch below assumes `x-ratelimit-reset` is in SECONDS. Providers
 * that send MILLISECONDS yield delay = 1.7e12 - 1.7e9 ~= 1.8e12 seconds, and
 * nothing downstream clamped it: parseRetryAfter -> result.retryAfter ->
 * CircuitBreaker.trip() -> cooldown. Measured 2026-08-17, a millisecond-epoch
 * header produced a 56,600-year cooldown, and since breaker state now
 * persists to disk it survived a restart — one malformed header permanently
 * removing a route. An RFC-7231 HTTP-date far in the future does the same.
 *
 * No real provider asks a client to wait longer than a day, so a value past
 * this is malformed rather than authoritative. Clamping (not discarding) is
 * deliberate: the route IS rate limited, so a long-but-sane backoff is the
 * right reading of a broken header.
 */
export const MAX_RETRY_AFTER_SEC = 24 * 60 * 60;

function clamp(seconds: number | null): number | null {
  if (seconds === null) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SEC);
}

export function parseRetryAfter(headers: Record<string, string>): number | null {
  return clamp(parseRetryAfterRaw(headers));
}

function parseRetryAfterRaw(headers: Record<string, string>): number | null {
  const h = lower(headers);

  // 1. delta-seconds
  for (const key of RETRY_AFTER_KEYS) {
    const v = parseFloatStrict(h[key]);
    if (v !== null) return v;
  }

  // 2. HTTP-date (only Retry-After permits this per RFC 7231 §7.1.3)
  const retryAfter = h["retry-after"];
  if (retryAfter && retryAfter.trim() !== "") {
    const ts = Date.parse(retryAfter);
    if (Number.isFinite(ts)) {
      const delay = (ts - Date.now()) / 1000;
      return Math.max(0, delay);
    }
  }

  // 3. epoch reset
  for (const key of RESET_EPOCH_KEYS) {
    const epoch = parseFloatStrict(h[key]);
    if (epoch !== null) {
      const delay = epoch - Date.now() / 1000;
      return Math.max(0, delay);
    }
  }

  return null;
}
