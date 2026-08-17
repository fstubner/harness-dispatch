/**
 * Arena ELO is opt-in; the default is tier/weight and no network.
 *
 * The router used to consult public benchmark scores to rank routes and
 * auto-derive tiers. That meant a default install made an outbound request to
 * a third party before it could route, and let a benchmark nobody here
 * controls reorder the user's own paid subscriptions — which is not the
 * decision this tool exists to make.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaderboardCache } from "../src/leaderboard.js";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LeaderboardCache — disabled by default", () => {
  it("defaults to disabled", () => {
    expect(new LeaderboardCache().isEnabled()).toBe(false);
  });

  it("makes no network call, whatever is asked of it", async () => {
    const lb = new LeaderboardCache();
    await lb.getScores();
    await lb.getElo("claude-opus-4");
    await lb.getQualityScore("claude-opus-4", undefined);
    await lb.autoTier("claude-opus-4", undefined, 3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a neutral quality score so ranking falls to tier/weight", async () => {
    const { qualityScore, elo } = await new LeaderboardCache().getQualityScore(
      "claude-opus-4",
      undefined,
    );
    expect(qualityScore).toBe(1.0);
    expect(elo).toBeNull();
  });

  it("still honours thinkingLevel, which is route config rather than an outside score", async () => {
    const { qualityScore } = await new LeaderboardCache().getQualityScore(
      "claude-opus-4",
      "high",
    );
    expect(qualityScore).toBeCloseTo(1.15, 5);
  });

  it("skips the BUNDLED benchmark file too, not just the live fetch", async () => {
    // Gating only the network would swap a current third-party ranking for a
    // stale shipped one — still an outside benchmark ordering the user's own
    // subscriptions. A neutral 1.0 here proves the bundled file is bypassed:
    // a real benchmark score for this model would not land exactly on 1.0.
    const lb = new LeaderboardCache();
    expect(lb.benchmarkLoaded()).toBe(true);
    expect((await lb.getQualityScore("claude-opus-4", undefined)).qualityScore).toBe(1.0);
  });

  it("returns the configured tier instead of deriving one", async () => {
    expect(await new LeaderboardCache().autoTier("claude-opus-4", undefined, 3)).toBe(3);
    expect(await new LeaderboardCache().autoTier("some-weak-model", undefined, 1)).toBe(1);
  });
});

describe("LeaderboardCache — explicitly enabled", () => {
  it("does consult the network once turned on", async () => {
    await new LeaderboardCache(undefined, { enabled: true }).getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
