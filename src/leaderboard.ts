/**
 * Leaderboard-based quality scoring for harness-dispatch.
 *
 * Ported from `coding_agent.leaderboard`. Fetches Arena ELO scores from the
 * public wulong.dev API with a 24-hour cache. Scores are used as routing
 * quality multipliers — higher ELO → higher routing priority within the
 * same tier.
 *
 * API reference: https://blog.wulong.dev/posts/i-built-an-auto-updating-archive-of-every-ai-arena-leaderboard/
 * Endpoint:      https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — load-bearing, preserved from Python
// ---------------------------------------------------------------------------

export const LEADERBOARD_URL =
  "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code";

export const CACHE_TTL_MS = 24 * 3600 * 1000; // 24 hours
export const FETCH_TIMEOUT_MS = 8000;

// Tier auto-derivation thresholds (Arena ELO, calibrated April 2026)
export const TIER1_ELO_MIN = 1350;
export const TIER2_ELO_MIN = 1200;

// High-thinking threshold relaxation
export const THINKING_THRESHOLD_BOOST = 25;

// Thinking level score multipliers
export const THINKING_MULTIPLIERS: Record<string, number> = {
  high: 1.15,
  medium: 1.07,
  low: 1.0,
};

// ELO normalization range → quality_score in [QUALITY_MIN, QUALITY_MAX]
export const ELO_NORM_MIN = 1000;
export const ELO_NORM_MAX = 1600;
export const QUALITY_MIN = 0.6;
export const QUALITY_MAX = 1.0;
export const QUALITY_DEFAULT = 0.85;

// User-Agent required — API returns 403 without it
const USER_AGENT = "harness-dispatch/0.4 (leaderboard quality scoring)";

// ---------------------------------------------------------------------------
// Benchmark file resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `data/coding_benchmarks.json` relative to this module.
 *
 * Walks up from wherever this module lives (dist/ when built, src/ when
 * running via tsx) to find the package root containing `data/`.
 */
function resolveBenchmarkPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up a few levels looking for data/coding_benchmarks.json.
  // Handles src/, dist/, or deeper nesting.
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "data", "coding_benchmarks.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Fall back to a "reasonable" path — caller just sees an empty benchmark map.
  return path.join(here, "..", "data", "coding_benchmarks.json");
}

// ---------------------------------------------------------------------------
// Helpers (exposed for testing)
// ---------------------------------------------------------------------------

export function normalizeElo(elo: number): number {
  let ratio = (elo - ELO_NORM_MIN) / (ELO_NORM_MAX - ELO_NORM_MIN);
  ratio = Math.max(0, Math.min(1, ratio));
  return QUALITY_MIN + (QUALITY_MAX - QUALITY_MIN) * ratio;
}

/**
 * Case-insensitive partial-match lookup.
 *
 * Three-tier fallback (identical to Python `_fuzzy_match`):
 *   1. Exact match after lowercasing.
 *   2. Query is a substring of a leaderboard name → prefer the shortest
 *      match (most specific entry that still contains the query).
 *   3. All query words appear in the leaderboard name (order-insensitive) →
 *      again prefer the shortest match.
 */
export function fuzzyMatch(
  query: string,
  scores: Record<string, number>,
): number | null {
  const q = query.toLowerCase().trim();
  if (!q) {
    return null;
  }

  // 1. Exact
  if (Object.prototype.hasOwnProperty.call(scores, q)) {
    return scores[q] ?? null;
  }

  // 2. Substring — query appears inside a leaderboard entry; prefer shortest.
  const substrHits: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(scores)) {
    if (k.includes(q)) {
      substrHits.push([k, v]);
    }
  }
  if (substrHits.length > 0) {
    substrHits.sort((a, b) => a[0].length - b[0].length);
    return substrHits[0]![1];
  }

  // 3. All words appear in entry; prefer shortest.
  const words = q.split(/\s+/).filter(Boolean);
  const wordHits: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(scores)) {
    if (words.every((w) => k.includes(w))) {
      wordHits.push([k, v]);
    }
  }
  if (wordHits.length > 0) {
    wordHits.sort((a, b) => a[0].length - b[0].length);
    return wordHits[0]![1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// LeaderboardCache
// ---------------------------------------------------------------------------

export interface QualityScoreResult {
  qualityScore: number;
  elo: number | null;
}


/**
 * Disk cache for the fetched leaderboard.
 *
 * The 24h TTL lived only in process memory, and every detached supervisor
 * bootstraps its own Router, so each one refetched. Sharing the cache on disk
 * makes the TTL mean what it says: one request a day for the machine, not one
 * per process. It also means a slow or down api.wulong.dev delays routing once
 * rather than once per process — the fetch sits on the routing path with an
 * 8s timeout.
 *
 * Single file, last-write-wins, and that is safe here in a way it was NOT for
 * breaker state: this is one shared value rather than a map being merged, so
 * concurrent writers write the same thing instead of clobbering each other's
 * entries. Still written atomically, so a reader never sees a half file.
 *
 * Failures are cached too. Without that, an endpoint returning 500 is retried
 * by every process on every dispatch, which is the worst behaviour precisely
 * when the far end is already struggling.
 */
interface LeaderboardCacheFile {
  fetchedAt: number;
  failed: boolean;
  data: Record<string, number>;
}

function cacheFilePath(): string {
  const dir =
    process.env.HARNESS_DISPATCH_STATE_DIR ?? path.join(homedir(), ".harness-dispatch");
  return path.join(dir, "leaderboard_cache.json");
}

function readCacheFile(): LeaderboardCacheFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as Partial<LeaderboardCacheFile>;
    if (typeof parsed?.fetchedAt !== "number") return undefined;
    return {
      fetchedAt: parsed.fetchedAt,
      failed: parsed.failed === true,
      data: parsed.data && typeof parsed.data === "object" ? parsed.data : {},
    };
  } catch {
    return undefined;
  }
}

function writeCacheFile(payload: LeaderboardCacheFile): void {
  const file = cacheFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore cleanup failures.
    }
    // A cache miss costs one extra request; it must never fail routing.
  }
}

export class LeaderboardCache {
  /**
   * Whether to consult the Arena leaderboard at all. OFF by default.
   *
   * The router used to lean on public ELO scores to rank routes and to
   * auto-derive tiers, which meant the default install made an outbound
   * request to a third party before it could route, and let a benchmark
   * nobody here controls reorder a user's own subscriptions. Neither is what
   * the tool is for: the routing decision that matters is "which of the
   * things I already pay for is available", and that is answered by the
   * `tier` and `weight` a user sets in config.
   *
   * With this off, getQualityScore returns a neutral 1.0 (thinking-level
   * multipliers still apply) and autoTier returns the configured tier, so
   * scoring reduces to tier/weight/capability/quota and the router makes no
   * network call at all. Turn it on with `leaderboard: { enabled: true }`.
   */
  private readonly enabled: boolean;
  private data: Record<string, number> = {};
  private fetchedAt = 0; // epoch ms
  private fetchFailed = false;
  /** In-flight fetch promise — callers await it to serialize access. */
  private inflight: Promise<void> | null = null;
  private benchmark: Record<string, number> = {};
  private benchmarkLoadedFlag = false;
  private benchmarkPath: string;

  constructor(benchmarkPath?: string, opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? false;
    this.benchmarkPath = benchmarkPath ?? resolveBenchmarkPath();
    this.loadBenchmarkFileSync();
  }

  /** True when Arena scores are consulted; false means tier/weight only. */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------

  benchmarkLoaded(): boolean {
    return this.benchmarkLoadedFlag;
  }

  cacheAgeMs(): number | null {
    if (this.fetchedAt === 0) {
      return null;
    }
    return Date.now() - this.fetchedAt;
  }

  async getScores(): Promise<Record<string, number>> {
    await this.ensureFetched();
    return this.data;
  }

  async getElo(leaderboardModel: string | undefined): Promise<number | null> {
    if (!leaderboardModel) {
      return null;
    }
    const scores = await this.getScores();
    if (Object.keys(scores).length === 0) {
      return null;
    }
    return fuzzyMatch(leaderboardModel, scores);
  }

  async getQualityScore(
    leaderboardModel: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
  ): Promise<QualityScoreResult> {
    const mult =
      (thinkingLevel && THINKING_MULTIPLIERS[thinkingLevel]) ?? 1.0;

    // 0. Disabled: quality is neutral and ranking falls to tier/weight.
    //
    // This deliberately skips the BUNDLED benchmark file as well as the live
    // fetch. Gating only the network call would swap a current third-party
    // ranking for a stale shipped one — still a benchmark nobody here
    // controls deciding the order of a user's own subscriptions, just an
    // older one. thinkingLevel survives because it is a property of the route
    // the user configured, not a score handed down from outside.
    if (!this.enabled) {
      return { qualityScore: mult, elo: null };
    }

    // 1. Blended benchmark file
    if (leaderboardModel && this.benchmarkLoadedFlag) {
      const bs = fuzzyMatch(leaderboardModel, this.benchmark);
      if (bs !== null) {
        const elo = await this.getElo(leaderboardModel);
        return { qualityScore: bs * mult, elo };
      }
    }

    // 2. Live Arena ELO
    const elo = leaderboardModel ? await this.getElo(leaderboardModel) : null;
    if (elo !== null) {
      return { qualityScore: normalizeElo(elo) * mult, elo };
    }

    // 3. Default
    return { qualityScore: QUALITY_DEFAULT * mult, elo: null };
  }

  async autoTier(
    leaderboardModel: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
    fallbackTier: number,
  ): Promise<number> {
    const elo = leaderboardModel ? await this.getElo(leaderboardModel) : null;
    if (elo === null) {
      return fallbackTier;
    }
    const boost = thinkingLevel === "high" ? THINKING_THRESHOLD_BOOST : 0;
    if (elo + boost >= TIER1_ELO_MIN) {
      return 1;
    }
    if (elo + boost >= TIER2_ELO_MIN) {
      return 2;
    }
    return 3;
  }

  // ------------------------------------------------------------------
  // Internal — fetch coordination
  // ------------------------------------------------------------------

  /** Ensure a fresh fetch has happened (or is in-flight); safe to call concurrently. */
  private async ensureFetched(): Promise<void> {
    // The one gate. Every consumer (getScores/getElo/getQualityScore/
    // autoTier) funnels through here, so disabling is guaranteed to mean "no
    // request", not "a request whose result is ignored".
    if (!this.enabled) return;

    // Adopt another process's recent fetch before considering our own state.
    if (Date.now() - this.fetchedAt >= CACHE_TTL_MS) {
      const cached = readCacheFile();
      if (cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        this.data = cached.data;
        this.fetchedAt = cached.fetchedAt;
        this.fetchFailed = cached.failed;
      }
    }

    const age = Date.now() - this.fetchedAt;
    if (Object.keys(this.data).length > 0 && age < CACHE_TTL_MS) {
      return;
    }
    if (this.fetchFailed && age < CACHE_TTL_MS) {
      // Suppress repeated retries within the same TTL window.
      return;
    }
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async doFetch(): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(LEADERBOARD_URL, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        this.fetchFailed = true;
        // Update fetchedAt so the failure-suppression window starts now.
        this.fetchedAt = Date.now();
        this.persist();
        return;
      }
      const payload = (await response.json()) as {
        models?: Array<{ model?: string; score?: number }>;
      };
      const models = Array.isArray(payload.models) ? payload.models : [];
      const parsed: Record<string, number> = {};
      for (const m of models) {
        if (typeof m.model === "string" && typeof m.score === "number") {
          parsed[m.model.toLowerCase()] = m.score;
        }
      }
      if (Object.keys(parsed).length > 0) {
        this.data = parsed;
        this.fetchedAt = Date.now();
        this.fetchFailed = false;
      } else {
        this.fetchFailed = true;
        this.fetchedAt = Date.now();
      }
      this.persist();
    } catch {
      this.fetchFailed = true;
      this.fetchedAt = Date.now();
      this.persist();
      // Return stale data rather than crashing routing.
    }
  }

  /** Share this process's result with every other process on the machine. */
  private persist(): void {
    writeCacheFile({ fetchedAt: this.fetchedAt, failed: this.fetchFailed, data: this.data });
  }

  // ------------------------------------------------------------------
  // Benchmark file
  // ------------------------------------------------------------------

  private loadBenchmarkFileSync(): void {
    // Sync load at construction to match Python behaviour (loaded once at
    // startup). Swallow all errors — missing/malformed file just falls back
    // to the Arena API.
    try {
      if (!existsSync(this.benchmarkPath)) {
        return;
      }
      // Sync IO here is acceptable: constructor runs once at startup.
      const raw = readFileSync(this.benchmarkPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        models?: Record<string, { coding_score?: number | null } | null>;
      };
      const out: Record<string, number> = {};
      const models = parsed.models ?? {};
      for (const [k, v] of Object.entries(models)) {
        const score = v?.coding_score;
        if (typeof score === "number") {
          out[k.toLowerCase()] = score;
        }
      }
      this.benchmark = out;
      this.benchmarkLoadedFlag = Object.keys(out).length > 0;
    } catch {
      // Malformed — silently fall back.
    }
  }

}
