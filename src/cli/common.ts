/** Shared pieces of the CLI: the runtime every command builds, flag parsing, and the error type the entrypoint turns into one line. */

import { loadConfig } from "../config.js";
import { LeaderboardCache } from "../leaderboard.js";
import { buildDispatchers } from "../mcp/dispatcher-factory.js";
import { QuotaCache } from "../quota.js";
import { initObservability } from "../observability/index.js";
import { Router } from "../router.js";
import type { RouterConfig } from "../types.js";

interface Runtime {
  config: RouterConfig;
  dispatchers: Awaited<ReturnType<typeof buildDispatchers>>;
  quota: QuotaCache;
  leaderboard: LeaderboardCache;
  router: Router;
}

export async function buildRuntime(configPath: string | undefined): Promise<Runtime> {
  const config = await loadConfig(configPath);
  // `telemetry: { enabled: true }` is known only now; bin.ts's early call can
  // see the environment variable only. Without this, one-shot commands
  // ignored the config setting.
  if (config.telemetry?.enabled) await initObservability({ enabled: true });
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache(undefined, {
    enabled: config.leaderboard?.enabled === true,
  });
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, leaderboard, router };
}

/**
 * Did this invocation ask for machine-readable output? Read from raw argv
 * rather than the parsed flags, because both callers — the unknown-command
 * branch and the top-level error handler — run where parsing has either not
 * happened or already failed. `--json=true` counts.
 */
export function wantsJsonOutput(): boolean {
  return process.argv.slice(2).some((a) => a === "--json" || a.startsWith("--json="));
}

export const SAFETY_PROFILES = ["read_only", "workspace_edit", "full_auto"] as const;

export const TASK_TYPES = ["execute", "plan", "review", "local"] as const;

/**
 * An enum-valued flag: rejected by name when it is not one of the listed
 * values, never silently dropped to a default.
 *
 * `--safety read_onlyy` dropping to workspace_edit would hand a delegate MORE
 * access than the caller asked for — the same reason `hints` is strict on the
 * MCP and HTTP surfaces.
 */
export function enumFlag<T extends string>(
  value: unknown,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(
    `${flag}: invalid value ${JSON.stringify(value)}. Valid: ${allowed.join(", ")}.`,
  );
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Thrown for a flag value the user typed wrong. main() turns it into a plain
 * one-line message and exit 1 — never a stack trace, which tells a CLI user
 * nothing they can act on.
 */
export class UsageError extends Error {}
