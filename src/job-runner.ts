/**
 * Detached job runner — the process a `dispatch` background run actually
 * lives in, so the run survives the MCP server that started it.
 *
 * Field incident that motivated this (2026-07-24): background runs used to
 * execute inside the server process; a session restart killed the server
 * and every in-flight run died with it, leaving status files frozen at
 * "running". Now the server only *starts* this process (detached, unref'd)
 * and watches the job directory; the run itself owes the server nothing.
 * Orphan detection (jobs.ts heartbeat) remains the safety net for the rare
 * case this runner itself dies.
 *
 * Usage: node dist/job-runner.js <jobDir>
 * Config: HARNESS_DISPATCH_CONFIG (set by the spawning server so the run
 * bootstraps against the same config file), else ./config.yaml if present,
 * else auto-detect — mirroring bin.ts's resolution.
 */

import { existsSync } from "node:fs";

import { bootstrapRuntime, RuntimeHolder } from "./mcp/config-hot-reload.js";
import { executeJobDir } from "./jobs.js";

async function main(): Promise<void> {
  const jobDir = process.argv[2];
  if (!jobDir) {
    console.error("usage: job-runner <jobDir>");
    process.exit(2);
  }
  const configPath =
    process.env.HARNESS_DISPATCH_CONFIG ??
    (existsSync("config.yaml") ? "config.yaml" : undefined);
  const state = await bootstrapRuntime(
    configPath !== undefined ? { configPath } : {},
  );
  await executeJobDir({ holder: new RuntimeHolder(state) }, jobDir);
  // executeJobDir never throws (runJob writes failures to the job dir), but
  // dispatcher/OTEL handles can keep the loop alive — exit deliberately.
  process.exit(0);
}

main().catch((err) => {
  // Last-resort: bootstrap itself failed (bad config, missing deps). The
  // job dir still holds only the frozen "queued/running" status, which the
  // heartbeat-staleness check will surface as orphaned.
  console.error(
    `harness-dispatch job-runner: fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
