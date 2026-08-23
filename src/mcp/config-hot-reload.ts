/**
 * Config hot-reload for the MCP server.
 *
 * Ported from Python `server.py:_maybe_reload_config`. Rather than file-system
 * watchers (which are flaky on Windows + WSL mounts), we poll the config
 * file's mtime between tool calls. A reload rebuilds the dispatcher map,
 * quota cache, and router — while preserving circuit-breaker state for any
 * service that still exists in the new config.
 *
 * Concurrency: the reload is guarded by a mutex so that simultaneous
 * tool-calls can't race on global state replacement. Only the first caller
 * performs the reload; the rest wait behind the mutex and pick up the
 * already-refreshed state.
 */

import { promises as fs } from "node:fs";

import { loadConfig } from "../config.js";
import { setJobRetentionDays } from "../jobs.js";
import { LeaderboardCache } from "../leaderboard.js";
import { QuotaCache } from "../quota.js";
import { Router } from "../router.js";
import type { RouterConfig } from "../types.js";
import { buildDispatchers, type DispatcherMap } from "./dispatcher-factory.js";

export interface RuntimeState {
  config: RouterConfig;
  dispatchers: DispatcherMap;
  quota: QuotaCache;
  router: Router;
  leaderboard: LeaderboardCache;
  mtimeMs: number;
  /**
   * Where this runtime's config came from (undefined = auto-detect). Jobs
   * pass it to their detached runner process so a run bootstraps against
   * the SAME config file as the server that started it, not whatever the
   * runner's cwd happens to contain.
   */
  configPath?: string;
}

/** A mutable holder you pass to tool handlers so hot-reloads are picked up. */
export class RuntimeHolder {
  state: RuntimeState;
  constructor(state: RuntimeState) {
    this.state = state;
  }
  replace(next: RuntimeState): void {
    this.state = next;
  }
}

async function statMtime(path: string | undefined): Promise<number> {
  if (!path) return 0;
  try {
    const stat = await fs.stat(path);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Bootstrap the full runtime from a config path. Used on server start and
 * again (internally) when a reload is triggered.
 */
export async function bootstrapRuntime(opts: {
  configPath?: string;
  leaderboard?: LeaderboardCache;
}): Promise<RuntimeState> {
  const config = await loadConfig(opts.configPath);
  // Runs at boot AND on every hot reload, so config-driven retention tracks
  // the live config.
  setJobRetentionDays(config.retention?.jobsDays);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard =
    opts.leaderboard ?? new LeaderboardCache(undefined, { enabled: config.leaderboard?.enabled === true });
  const router = new Router(config, quota, dispatchers, leaderboard);
  const mtimeMs = await statMtime(opts.configPath);
  return {
    config,
    dispatchers,
    quota,
    router,
    leaderboard,
    mtimeMs,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  };
}

/** Gate that serialises concurrent reload attempts. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(task: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await task();
    } finally {
      release();
    }
  }
}

/**
 * Reload helper — pairs with a RuntimeHolder for in-place swap.
 *
 * If the config file's mtime has not moved since we last reloaded, the call
 * is a cheap no-op. Circuit-breaker state from the previous router is
 * preserved for every service that still exists in the new config.
 */
export class ConfigHotReloader {
  private readonly mutex = new Mutex();
  /** Last reload failure reported, so a broken file is not logged every poll. */
  private lastReloadError: string | undefined;

  constructor(
    private readonly holder: RuntimeHolder,
    private readonly configPath?: string,
  ) {}

  /** Returns true iff a reload actually happened. Swallows all errors. */
  async maybeReload(): Promise<boolean> {
    if (!this.configPath) return false;
    const mtimeMs = await statMtime(this.configPath);
    if (mtimeMs === 0) return false;
    if (mtimeMs <= this.holder.state.mtimeMs) return false;

    return this.mutex.run(async () => {
      // Re-check after acquiring the lock — another caller may have already
      // reloaded, in which case we bail without redoing the work.
      const current = this.holder.state.mtimeMs;
      if (mtimeMs <= current) return false;

      let next: RuntimeState;
      try {
        const bootOpts: { configPath?: string; leaderboard?: LeaderboardCache } = {
          leaderboard: this.holder.state.leaderboard,
        };
        if (this.configPath !== undefined) bootOpts.configPath = this.configPath;
        next = await bootstrapRuntime(bootOpts);
      } catch (err) {
        // Malformed edits shouldn't crash the server — keep the old state.
        //
        // But SAY SO. A bare `catch {}` here meant a config with a typo was
        // silently ignored: the server kept routing on the previous version
        // with nothing on stderr and nothing in status to say the file on disk
        // was not the file in effect. The edit looks applied because the
        // server is still up and still working — just not the way the file
        // now reads.
        //
        // Rate-limited to one line per distinct message, because the reloader
        // re-checks on a timer and a broken file would otherwise print on
        // every poll until it was fixed.
        const message = err instanceof Error ? err.message : String(err);
        if (message !== this.lastReloadError) {
          this.lastReloadError = message;
          process.stderr.write(
            `harness-dispatch: config reload FAILED, still running the previously loaded ` +
              `config — ${message}\n`,
          );
        }
        return false;
      }
      this.lastReloadError = undefined;

      // Preserve circuit-breaker state for services that still exist.
      const oldRouter = this.holder.state.router;
      const oldBreakerStatus = oldRouter.circuitBreakerStatus();
      for (const [name, status] of Object.entries(oldBreakerStatus)) {
        if (!(name in next.config.services)) continue;
        const nb = next.router.getBreaker(name);
        if (!nb) continue;
        if (status.tripped) {
          nb.trip(status.cooldownRemainingSec ?? undefined);
        }
      }

      this.holder.replace(next);
      return true;
    });
  }
}
