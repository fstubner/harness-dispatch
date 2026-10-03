/** `breaker reset <route>`: take a route's persisted circuit breaker back to healthy. */

import { BreakerStore } from "../breaker-store.js";
import { UsageError } from "./common.js";
import { loadConfig } from "../config.js";

const USAGE = "usage: harness-dispatch breaker reset <route>";

/**
 * A tripped breaker is persisted per route and survives restarts on purpose, so
 * restarting the server does not clear it; this does. It works on the record
 * itself, so it also clears one left by a route that is no longer configured.
 * Running servers read the change on their next routing decision.
 */
export async function cmdBreaker(
  configPath: string | undefined,
  action: string | undefined,
  route: string | undefined,
): Promise<number> {
  if (action !== "reset") {
    throw new UsageError(action === undefined ? USAGE : `unknown breaker action: ${action}. ${USAGE}`);
  }
  if (route === undefined || route === "") throw new UsageError(`breaker reset: missing route. ${USAGE}`);

  const store = new BreakerStore();
  const before = store.loadAll()[route];
  if (before === undefined) {
    const unreadable = store.unreadableRoutes().includes(route);
    if (!unreadable) {
      // Say so when the name matches no route, so a typo is not read as "healthy".
      const known = await knownRoutes(configPath);
      process.stdout.write(
        known !== undefined && !known.includes(route)
          ? `breaker reset: no breaker record for "${route}", and it is not a configured route ` +
              `(configured: ${known.join(", ") || "none"}).\n`
          : `breaker reset: "${route}" has no breaker record; nothing to clear.\n`,
      );
      return known !== undefined && !known.includes(route) ? 1 : 0;
    }
  }
  // A healthy snapshot deletes the record (see BreakerStore.save).
  store.save(route, { failures: 0, blockedUntilMs: null, lastFailureAtMs: null });
  const err = store.lastWriteError();
  if (err !== undefined) {
    process.stderr.write(`breaker reset: ${err}\n`);
    return 1;
  }
  const remaining =
    before?.blockedUntilMs != null ? Math.max(0, Math.round((before.blockedUntilMs - Date.now()) / 1000)) : 0;
  process.stdout.write(
    before === undefined
      ? `breaker reset: removed the unreadable breaker record for "${route}".\n`
      : before.blockedUntilMs !== null && remaining > 0
        ? `breaker reset: "${route}" was tripped (${remaining}s of cooldown left); it is closed now.\n`
        : `breaker reset: cleared "${route}" (${before.failures} recorded failure${before.failures === 1 ? "" : "s"}, not tripped).\n`,
  );
  return 0;
}

async function knownRoutes(configPath: string | undefined): Promise<string[] | undefined> {
  try {
    return Object.keys((await loadConfig(configPath)).services);
  } catch {
    return undefined;
  }
}
