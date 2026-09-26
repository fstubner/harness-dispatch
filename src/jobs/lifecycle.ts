/**
 * The lifecycle verbs: stop a run, resolve its workspace, run it again.
 *
 * These sit above start/read: a retry starts a new job and a cancel reads one,
 * so lifecycle imports start, never the reverse.
 */

import { getAsyncJob } from "./read.js";
import { startAsyncJobTracked } from "./start.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { declaresModel } from "../router.js";
import type { RouteHints, ServiceConfig } from "../types.js";
import {
  applyWorkspace,
  discardWorkspace,
  isResolvable,
  workspaceDiff,
} from "../workspace-resolve.js";
import { acquireWorkspaceLock } from "../workspace-lock.js";
import {
  requestCancel,
  jobsRoot,
  readJson,
  timestamp,
  updateStatus,
} from "./store.js";
import type { JobDeps, JobStatus } from "./types.js";
/** What a cancel request actually did — the caller needs to tell these apart. */
export interface CancelOutcome {
  jobId: string;
  /**
   * `cancelled`  — it was queued and never started; stopped outright.
   * `cancelling` — it is running; teardown requested and lands shortly.
   * `already_finished` — it had already reached a terminal state; nothing done.
   */
  outcome: "cancelled" | "cancelling" | "already_finished";
  status: JobStatus["status"];
  message: string;
}

/**
 * Ask a job to stop.
 *
 * Cancellation cannot be a signal: jobs run inside POOLED supervisors, and the
 * only pid recorded against a job belongs to a process also running other
 * jobs. Instead this writes a marker the run itself honours — it drops out of
 * its event stream, triggering the dispatcher's teardown (killTree on the
 * agent CLI and its children) and releasing the workspace lock through the
 * same path a normal finish uses.
 *
 * Two consequences a caller will otherwise be surprised by: it is not
 * instantaneous (a running job stops within about a second, and `cancelling`
 * means requested, not done), and work already done is NOT undone — files the
 * agent already edited stay edited.
 *
 * A cancelled run is deliberately not recorded as a failure: the caller
 * changing their mind says nothing about whether the route works, so the
 * circuit breaker never sees it.
 */
export async function cancelJob(jobId: string, reason?: string): Promise<CancelOutcome> {
  const job = await getAsyncJob(jobId); // throws the friendly "No such job" for a stranger
  const current = job.status.status;

  // There are TWO kinds of orphaned job and they need opposite answers.
  //
  //   WRITTEN — a slot-queued job the server exited on is genuinely terminal:
  //     its own error text says to use retry_job. Cancelling it would leave a
  //     marker nothing reads.
  //   DERIVED — `withOrphanCheck` reports a job orphaned when its heartbeat
  //     goes stale while the FILE still says `queued` or `running`. Once the
  //     dead owner's claim ages out claimNextJob picks it up and runs it, so
  //     it is still cancellable.
  //
  // So the raw status decides, not the derived one — and `getAsyncJob` has
  // already applied the orphan check, hence the re-read.
  const rawStatus = await readJson<JobStatus>(
    path.join(jobsRoot(), jobId, "status.json"),
  ).catch(() => undefined);
  const terminalOnDisk = rawStatus?.status === "orphaned";
  if (
    current === "completed" ||
    current === "failed" ||
    current === "cancelled" ||
    terminalOnDisk
  ) {
    return {
      jobId,
      outcome: "already_finished",
      status: current,
      message: `Job ${jobId} had already finished (${current}); nothing to cancel.`,
    };
  }

  const jobDir = path.join(jobsRoot(), jobId);
  await requestCancel(jobDir, reason);

  // A job still waiting for a slot has no runner to notice the marker, so stop
  // it here; claimNextJob also refuses a marked job, closing the window where
  // a supervisor picks it up between these two steps. `orphaned` joins
  // `queued` because an orphaned job has no live runner by definition, so
  // nothing would act on the marker and it would sit at "cancelling" forever.
  if (current === "queued" || current === "orphaned") {
    // Out of the slot queue as well: left marked, a cancelled job was still
    // counted as waiting for a slot.
    const { slotQueued: _waiting, ...rest } = job.status;
    await updateStatus(jobDir, {
      ...rest,
      status: "cancelled",
      updatedAt: timestamp(),
      success: false,
      error: reason !== undefined ? `Cancelled: ${reason}` : "Cancelled before it started.",
    });
    // Deliberately NOT draining the slot queue: drainSlotQueue can SPAWN
    // supervisor processes, and a cancel must not start any. Every dispatch
    // and every runner exit already drains.
    return {
      jobId,
      outcome: "cancelled",
      status: "cancelled",
      message:
        current === "orphaned"
          ? `Job ${jobId} was orphaned — the process running it is gone — and is now ` +
            `marked cancelled, so no supervisor can reclaim it. Any partial output it ` +
            `wrote is still available from job_status.`
          : `Job ${jobId} was waiting for a slot and has been cancelled; it never started.`,
    };
  }

  return {
    jobId,
    outcome: "cancelling",
    status: current,
    message:
      `Cancellation requested for ${jobId}. The run stops within a second or so — poll ` +
      `job_status to confirm. Any files the agent already changed are NOT reverted.`,
  };
}

/** Long enough for a large apply to finish; a crashed holder is detected sooner. */
const JOB_ACTION_LOCK_TIMEOUT_MS = 120_000;

/**
 * Inspect or resolve the isolated workspace a finished job left behind.
 *
 * Looks the job up the same way job_status does, then hands off to
 * workspace-resolve.ts, so the caller only ever needs a jobId — where the
 * workspace lives and which policy produced it are in the job's own result.
 */
export async function resolveJobWorkspace(
  jobId: string,
  action: "diff" | "apply" | "discard",
  opts: { force?: boolean } = {},
): Promise<unknown> {
  const job = await getAsyncJob(jobId);
  const run = job.result?.result?.workspace;
  if (!isResolvable(run)) {
    // A separate binding: the type guard narrows `run` to never on this
    // branch, so the diagnostic could not name the policy the caller got.
    const raw = job.result?.result?.workspace;
    const policy = raw?.policy ?? "shared";
    throw new Error(
      `Job ${jobId} has no isolated workspace to ${action} (workspace policy: ${policy}). ` +
        `Only 'copy' and 'git_worktree' dispatches produce one — a 'shared' or ` +
        `'shared_locked' run edited ${raw?.originalWorkingDir ?? "the working directory"} ` +
        `directly, so there is nothing separate to inspect, apply or throw away.`,
    );
  }
  const jobDir = path.join(jobsRoot(), jobId);

  // One action per job at a time, across processes. Each action reads the
  // project and the workspace and rewrites output/workspace.patch, which apply
  // then hands to git by path — so two at once (an orchestrator issuing diff
  // and apply in parallel is enough) let git read a patch file another action
  // had just truncated, let a diff read the project halfway through an apply
  // and cache that partial patch, and made the losing apply of two report
  // conflict markers that were not there and advise undoing the winner's
  // work. Keyed on the job directory, so it never contends with a dispatch.
  let release: () => void;
  try {
    release = await acquireWorkspaceLock(jobDir, JOB_ACTION_LOCK_TIMEOUT_MS);
  } catch {
    throw new Error(
      `Another workspace action on ${jobId} is still running after ` +
        `${JOB_ACTION_LOCK_TIMEOUT_MS / 1000}s. Wait for it to finish, then try again.`,
    );
  }
  try {
    if (action === "diff") return await workspaceDiff(jobId, jobDir, run);
    if (action === "apply") return await applyWorkspace(jobId, jobDir, run, opts);
    // force reaches discard too: it refuses to destroy work the project does
    // not have, so the caller needs the same override apply offers.
    return await discardWorkspace(jobId, run, opts);
  } finally {
    release();
  }
}

export interface RetryOutcome {
  jobId: string;
  retryOf: string;
  service?: string;
  reusedFrom: { prompt: boolean; files: number; workingDir: string };
  /**
   * The original's model, when the retry's route does not declare it.
   *
   * Declared explicitly because the object is built with a conditional
   * spread, which TypeScript does not excess-property check — without this
   * line a typed caller cannot see a field that ships.
   */
  droppedModel?: string;
  message: string;
}

/**
 * Run a finished job's task again.
 *
 * Reuses the prompt, file list, working directory and hints the job record
 * already holds. The prompt comes from prompt.md, the FROZEN prompt including
 * any context preamble the original dispatch rendered in, so a retry
 * reproduces what the delegate actually saw rather than what the caller typed.
 *
 * `service` retargets the attempt — the reason a run failed is often the route
 * rather than the task. Omit it to reuse the original route, or to let the
 * router pick again if the original had none.
 */
export async function retryJob(
  jobId: string,
  deps: JobDeps,
  opts: { service?: string } = {},
): Promise<RetryOutcome> {
  const prior = await getAsyncJob(jobId); // friendly "No such job" for a stranger
  const state = prior.status.status;
  if (state === "running" || state === "queued") {
    throw new Error(
      `Job ${jobId} is still ${state}. Let it finish, or cancel it first with ` +
        `cancel_job — retrying a live run would leave two attempts racing on the ` +
        `same working directory.`,
    );
  }
  // A DERIVED orphan produces the outcome the guard above forbids, and that
  // guard cannot see it: `getAsyncJob` reports orphaned when the heartbeat is
  // stale, but the status FILE still says `queued` and `claimNextJob` filters
  // on the raw file, so a supervisor can claim the original while the retry
  // runs. Marking it cancelled closes that — claimNextJob refuses a marked
  // job, so the retry becomes the only attempt.
  if (state === "orphaned") {
    const rawStatus = await readJson<JobStatus>(
      path.join(jobsRoot(), jobId, "status.json"),
    ).catch(() => undefined);
    if (rawStatus?.status === "queued" || rawStatus?.status === "running") {
      await cancelJob(jobId, `superseded by a retry`);
    }
  }

  const manifest = prior.manifest;
  const prompt = await readFile(manifest.promptPath, "utf8");
  // `Object.hasOwn`, not `in` — see the same guard in `mcp/tools.ts`. With
  // `in`, an inherited key such as `toString` is not refused, and the retry
  // starts against a route that does not exist.
  if (opts.service !== undefined && !Object.hasOwn(deps.holder.state.config.services, opts.service)) {
    throw new Error(
      `Unknown service: ${opts.service}. Valid route ids: ` +
        `${Object.keys(deps.holder.state.config.services).join(", ")}.`,
    );
  }
  const service = opts.service ?? manifest.service;
  const { hints, droppedModel } = hintsForRetry(
    manifest.hints,
    prior.status.route ?? manifest.service,
    service,
    deps.holder.state.config.services,
  );

  const { status } = await startAsyncJobTracked(deps, {
    prompt,
    files: manifest.files.map((f) => f.originalPath),
    workingDir: manifest.workingDir,
    retryOf: jobId,
    ...(hints !== undefined ? { hints } : {}),
    ...(manifest.workspacePolicy !== undefined
      ? { workspacePolicy: manifest.workspacePolicy }
      : {}),
    ...(service !== undefined ? { service } : {}),
  });

  return {
    jobId: status.jobId,
    retryOf: jobId,
    ...(service !== undefined ? { service } : {}),
    ...(droppedModel !== undefined ? { droppedModel } : {}),
    reusedFrom: {
      prompt: true,
      files: manifest.files.length,
      workingDir: manifest.workingDir,
    },
    message:
      `Started ${status.jobId} from ${jobId}'s prompt, files and working directory` +
      `${opts.service !== undefined ? `, retargeted to ${opts.service}` : ""}. ` +
      `${
        droppedModel !== undefined
          ? `Left behind the original's model "${droppedModel}", which ${service} does ` +
            `not declare — a model name belongs to the route it was chosen for. Pass ` +
            `hints.model on a fresh dispatch if you want a specific model here. `
          : ""
      }` +
      `Check it with job_status; the original job is untouched.`,
  };
}

/**
 * Carry the original's hints into a retry — except a model that belonged to
 * the route being left behind.
 *
 * Model names are route-scoped, so reusing one verbatim on a different route
 * defeats the documented reason for retargeting — the retry fails for the same
 * reason as the original without reaching the task.
 *
 * Narrow on purpose: the model is kept when the retry stays on the original's
 * route, and when the new route declares it anyway. Only a model the
 * destination does not know is dropped, and the caller is told in the
 * response rather than left to infer it from a different result.
 */
function hintsForRetry(
  hints: RouteHints | undefined,
  priorRoute: string | undefined,
  service: string | undefined,
  services: Record<string, ServiceConfig>,
): { hints: RouteHints | undefined; droppedModel?: string } {
  if (hints === undefined) return { hints };
  const model = hints.model;
  if (model === undefined || service === undefined || service === priorRoute) return { hints };
  const target = services[service];
  if (target === undefined || declaresModel(target, model)) return { hints };
  const { model: _dropped, ...rest } = hints;
  return { hints: rest, droppedModel: model };
}
