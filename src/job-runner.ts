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
 * else auto-detect. Shared with bin.ts through resolveConfigPath(), which is
 * what makes that claim true — the two used to be written out separately and
 * had drifted apart.
 */

import { resolveConfigPath } from "./config.js";
import { bootstrapRuntime, RuntimeHolder } from "./mcp/config-hot-reload.js";
import { drainSlotQueue, executeJobDir, runSupervisor } from "./jobs.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: job-runner <jobDir> | job-runner --supervisor");
    process.exit(2);
  }
  const configPath = resolveConfigPath();
  const state = await bootstrapRuntime(
    configPath !== undefined ? { configPath } : {},
  );

  // Pool mode: claim work from the queue and run several jobs at once, so
  // supervision costs a bounded number of processes rather than one per job.
  if (arg === "--supervisor") {
    await runSupervisor({ holder: new RuntimeHolder(state) }, process.argv[3]);
    process.exit(0);
  }

  // Single-job mode is retained: it is the narrowest way to run one job dir,
  // which is what the end-to-end runner test drives against the real build.
  await executeJobDir({ holder: new RuntimeHolder(state) }, arg);
  // This runner's slot just freed — hand it to whoever is waiting. Doing it
  // here (rather than in a daemon) is what keeps the queue moving between
  // dispatches; a failure to drain must not fail the run that already
  // succeeded, hence the swallow.
  try {
    await drainSlotQueue(state.config, configPath);
  } catch {
    // Next dispatch drains instead.
  }
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
