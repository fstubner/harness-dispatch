/**
 * Detached job runner — the process a `dispatch` background run actually
 * lives in, so the run survives the MCP server that started it.
 *
 * A run executing inside the server process dies with it on a session restart,
 * leaving its status file frozen at "running". So the server only *starts*
 * this process (detached, unref'd) and watches the job directory. Orphan
 * detection (jobs.ts heartbeat) covers this runner itself dying.
 *
 * Usage: node dist/job-runner.js <jobDir>
 * Config: HARNESS_DISPATCH_CONFIG (set by the spawning server so the run
 * bootstraps against the same config file), else ./config.yaml if present,
 * else auto-detect. Shared with bin.ts through resolveConfigPath(), so the two
 * cannot drift apart.
 */

import { resolveConfigPath } from "./config.js";
import { installOutputRedaction } from "./redaction.js";
import { bootstrapRuntime, RuntimeHolder } from "./mcp/config-hot-reload.js";
import { drainSlotQueue, executeJobDir, runSupervisor } from "./jobs.js";

async function main(): Promise<void> {
  // This process writes its own stdout/stderr straight into
  // .supervisors/spawn-<id>.log, so a fatal handler or an unhandled stack
  // trace here needs the same redaction sink bin.ts installs.
  installOutputRedaction();
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

  // Single-job mode: the narrowest way to run one job dir, which is what the
  // end-to-end runner test drives against the real build.
  await executeJobDir({ holder: new RuntimeHolder(state) }, arg);
  // This runner's slot just freed — hand it to whoever is waiting. Doing it
  // here rather than in a daemon is what keeps the queue moving between
  // dispatches, and a failed drain must not fail a run that already succeeded.
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
  // Bootstrap itself failed (bad config, missing deps). The job dir still
  // holds a frozen "queued/running" status, which the heartbeat-staleness
  // check surfaces as orphaned.
  console.error(
    `harness-dispatch job-runner: fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
