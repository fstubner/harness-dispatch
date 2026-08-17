/**
 * The leaderboard's 24h TTL must hold across processes, not just within one.
 *
 * It lived in module memory, and every detached supervisor bootstraps its own
 * Router, so each refetched — the TTL bounded nothing at machine level. The
 * fetch sits on the routing path with an 8s timeout, so a slow or down
 * api.wulong.dev delayed routing once per process.
 *
 * Only reachable when the leaderboard is explicitly enabled; it is off by
 * default. These construct with { enabled: true } deliberately.
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CACHE_TTL_MS, LeaderboardCache } from "../src/leaderboard.js";

let stateDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

const PAYLOAD = { models: [{ model: "claude-opus-4", score: 1500 }] };

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-lbcache-"));
  vi.stubEnv("HARNESS_DISPATCH_STATE_DIR", stateDir);
  fetchSpy = vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const cacheFile = (): string => path.join(stateDir, "leaderboard_cache.json");
const enabled = (): LeaderboardCache => new LeaderboardCache(undefined, { enabled: true });

describe("leaderboard disk cache", () => {
  it("writes the fetch to disk so other processes can use it", async () => {
    await enabled().getScores();
    expect(existsSync(cacheFile())).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).data["claude-opus-4"]).toBe(1500);
  });

  it("a SECOND instance reuses it instead of refetching", async () => {
    // Stands in for a second supervisor process: fresh instance, empty memory.
    await enabled().getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const scores = await enabled().getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no second request
    expect(scores["claude-opus-4"]).toBe(1500);
  });

  it("refetches once the cached entry ages past the TTL", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      cacheFile(),
      JSON.stringify({
        fetchedAt: Date.now() - CACHE_TTL_MS - 1000,
        failed: false,
        data: { "stale-model": 1 },
      }),
      "utf8",
    );
    const scores = await enabled().getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(scores["claude-opus-4"]).toBe(1500);
  });

  it("caches a FAILURE too, so a struggling endpoint is not retried per process", async () => {
    // Without this, an endpoint returning 500 is hit again by every process on
    // every dispatch — worst behaviour exactly when the far end is in trouble.
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    await enabled().getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await enabled().getScores();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).failed).toBe(true);
  });

  it("survives a corrupt cache file by refetching", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cacheFile(), "{ not json", "utf8");
    expect((await enabled().getScores())["claude-opus-4"]).toBe(1500);
  });

  it("writes nothing at all while disabled", async () => {
    await new LeaderboardCache().getScores();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(cacheFile())).toBe(false);
  });
});
