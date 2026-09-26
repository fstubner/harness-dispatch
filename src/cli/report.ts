/** `status` and `usage`. */

import { buildStatus, buildUsage, renderStatusText, renderUsageText } from "../status.js";
import { buildRuntime } from "./common.js";

export async function cmdStatus(
  configPath: string | undefined,
  opts: { json: boolean; watch: boolean; intervalMs: number },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  const render = async (): Promise<string> => {
    const status = await buildStatus(
      runtime.config,
      runtime.dispatchers,
      runtime.quota,
      runtime.router,
      runtime.leaderboard,
    );
    // Watching with --json prints one compact document per line (JSON Lines):
    // pretty-printed documents back to back parse neither as one JSON value
    // nor line by line.
    if (opts.json) return `${JSON.stringify(status, null, opts.watch ? undefined : 2)}\n`;
    return `${renderStatusText(status)}\n`;
  };

  if (!opts.watch) {
    process.stdout.write(await render());
    return 0;
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (running) {
      process.stdout.write(await render());
      await new Promise<void>((resolve) => setTimeout(resolve, opts.intervalMs));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

export async function cmdUsage(
  configPath: string | undefined,
  opts: { json: boolean },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  const status = await buildStatus(
    runtime.config,
    runtime.dispatchers,
    runtime.quota,
    runtime.router,
    runtime.leaderboard,
  );
  const usage = buildUsage(status);
  process.stdout.write(
    opts.json ? `${JSON.stringify(usage, null, 2)}\n` : `${renderUsageText(usage)}\n`,
  );
  return 0;
}
