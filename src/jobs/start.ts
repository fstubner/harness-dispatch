/**
 * Starting a job.
 *
 * Split out of jobs.ts with the rest of its concerns; nothing was rewritten.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkingDir, validateWorkingDir, workingDirWarning } from "../working-dir.js";
import { buildContextPreamble } from "./context.js";
import {
  jobsRoot,
  newJobId,
  pollInstructions,
  pruneStaleJobs,
  readJson,
  snapshotFiles,
  SUGGESTED_POLL_SECONDS,
  timestamp,
  updateStatus,
  writeJson,
} from "./store.js";
import type { JobDeps, JobManifest, JobStatus, StartedJob, StartJobInput } from "./types.js";
import { resolveRunnerPath, runJob, watchUntilTerminal } from "./run.js";
import {
  configLoadError,
  drainSlotQueue,
  maxConcurrentRuns,
  spawnDetachedRunner,
} from "./supervisor.js";
export async function startAsyncJob(deps: JobDeps, input: StartJobInput): Promise<JobStatus> {
  return (await startAsyncJobTracked(deps, input)).status;
}

export async function startAsyncJobTracked(deps: JobDeps, input: StartJobInput): Promise<StartedJob> {
  // Before anything is created on disk. Every dispatch path — MCP, HTTP,
  // fanout — funnels through here, so this is the one place that catches a bad
  // workingDir while the error can still name the real cause, and the only
  // point at which failing leaves no half-built job directory behind.
  const workingDirError = validateWorkingDir(input.workingDir);
  if (workingDirError !== undefined) throw new Error(workingDirError);

  // The runner reads the config FILE, so a file this server can no longer load
  // means no runner can start — and the job would sit untouched until the 90s
  // orphan threshold reported it dead. Observed: a caller told
  // "ended without a result (status: orphaned)" about a job whose own
  // status.json later read completed/success. Two false statements from one
  // broken file, ninety seconds apart.
  //
  // The server itself is fine: a failed hot-reload keeps the previous config
  // in memory, which is why it can still accept the dispatch at all. That
  // divergence between what the server runs and what the runner would read is
  // the whole bug, so it is refused here, immediately, naming the real cause —
  // before a job directory exists to be misreported.
  const configError = await configLoadError(deps.holder.state.configPath);
  if (configError !== undefined) throw new Error(configError);

  await pruneStaleJobs();
  const jobId = newJobId();
  const root = jobsRoot();
  const jobDir = path.join(root, jobId);
  await mkdir(path.join(jobDir, "context"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(jobDir, "output"), { recursive: true, mode: 0o700 });

  const promptPath = path.join(jobDir, "prompt.md");
  // Prepend prior-job context before the prompt is frozen to disk, so the
  // runner, the manifest and any later inspection all see exactly what the
  // delegate was given.
  const preamble = await buildContextPreamble(input.contextJobs ?? []);
  const effectivePrompt = preamble + input.prompt;
  await writeFile(promptPath, effectivePrompt, { encoding: "utf8", mode: 0o600 });
  const fileSnapshots = await snapshotFiles(jobDir, input.files ?? []);
  const createdAt = timestamp();
  const resolvedWorkingDir = resolveWorkingDir(input.workingDir);
  const warning = workingDirWarning(resolvedWorkingDir);
  const manifest: JobManifest = {
    jobId,
    createdAt,
    workingDir: resolvedWorkingDir.workingDir,
    promptPath,
    files: fileSnapshots,
    ...(input.hints !== undefined ? { hints: input.hints } : {}),
    ...(input.workspacePolicy !== undefined ? { workspacePolicy: input.workspacePolicy } : {}),
    ...(input.service !== undefined ? { service: input.service } : {}),
    ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
  await writeJson(path.join(jobDir, "manifest.json"), manifest);

  const status: JobStatus = {
    jobId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    jobDir,
    ...(input.service !== undefined ? { service: input.service } : {}),
    nextPollSeconds: SUGGESTED_POLL_SECONDS,
    instructions: pollInstructions(jobId),
    ...(warning !== undefined ? { warning } : {}),
  };
  await updateStatus(jobDir, status);

  // Detached by default: the run must not die with this process. In-process
  // mode exists for unit tests (injected fake dispatchers aren't visible to
  // a separate process) and as the fallback when the runner script can't be
  // found (running from raw src/ with no dist/ build).
  const inproc = process.env.HARNESS_DISPATCH_INPROC_JOBS === "1";
  const runnerPath = inproc ? undefined : resolveRunnerPath();
  if (inproc || runnerPath === undefined) {
    if (!inproc) {
      console.error(
        "harness-dispatch: dist/job-runner.js not found (unbuilt checkout?) — " +
          "running the job in-process; it will not survive a server restart.",
      );
    }
    // The DETACHED runner re-reads prompt.md, which carries the context
    // preamble — so the in-process run must dispatch the same frozen prompt,
    // not input.prompt. Passing the raw prompt here silently dropped
    // contextJobs for every in-process run (unit tests with injected fakes,
    // and the unbuilt-checkout fallback).
    const completion = runJob(deps, jobDir, manifest, { ...input, prompt: effectivePrompt });
    return { status, completion };
  }

  // Concurrency gate. Every dispatch spawns its own detached runner, so an
  // in-process semaphore would bound nothing — the count has to come off
  // disk. The caller still gets its jobId back immediately either way, so the
  // API contract is unchanged and only the start time can move.
  const limit = maxConcurrentRuns(deps.holder.state.config);
  if (limit === 0) {
    spawnDetachedRunner(runnerPath, jobDir, deps.holder.state.configPath);
    return { status, completion: watchUntilTerminal(jobDir) };
  }

  // Enqueue first, then let drainSlotQueue decide — rather than testing the
  // limit here and spawning inline. Two reasons, both learned the hard way:
  // this job's own `queued` status is already on disk, so an inline count
  // included itself and deadlocked at limit 1; and a fresh dispatch arriving
  // while others wait must not jump the queue, which only one FIFO drainer
  // can guarantee. Whether this job starts now is then just "did the drain
  // reach it".
  await updateStatus(jobDir, { ...status, slotQueued: true });
  await drainSlotQueue(deps.holder.state.config, deps.holder.state.configPath);
  const settled = await readJson<JobStatus>(path.join(jobDir, "status.json"));
  return { status: settled, completion: watchUntilTerminal(jobDir) };
}
