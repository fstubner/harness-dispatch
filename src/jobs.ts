/**
 * The job surface, assembled from the modules that own each concern.
 *
 * This file was 1,600 lines holding all of them at once: running a job,
 * admission and the supervisor pool, the start/read verbs, and the lifecycle
 * verbs. It is a barrel now, which is what it had already half become — every
 * consumer imports from here, so the split is invisible outside src/jobs/.
 */

export { executeJobDir, runJob } from "./jobs/run.js";
export {
  activeCapacity,
  claimJobDir,
  countLiveSupervisorsForTest,
  drainSlotQueue,
  orphanStrandedSlotQueue,
  resourceWeightFor,
  runSupervisor,
  SUPERVISOR_POOL_SIZE,
} from "./jobs/supervisor.js";
export { getAsyncJob, listAsyncJobs } from "./jobs/read.js";
export { startAsyncJob, startAsyncJobTracked } from "./jobs/start.js";
export {
  cancelJob,
  resolveJobWorkspace,
  retryJob,
  type CancelOutcome,
  type RetryOutcome,
} from "./jobs/lifecycle.js";
export { buildContextPreamble } from "./jobs/context.js";
export { setJobRetentionDays } from "./jobs/store.js";
export type { JobDeps, JobStatus, StartJobInput, StartedJob } from "./jobs/types.js";
