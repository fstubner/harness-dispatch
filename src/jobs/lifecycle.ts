/**
 * The lifecycle verbs: stop a run, resolve its workspace, run it again.
 *
 * These sit above start/read because a retry starts a new job and a cancel
 * reads one, so the dependency runs one way — lifecycle imports start, never
 * the reverse.
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
 * Cancellation cannot be a signal here: jobs run inside POOLED supervisors,
 * and the only pid recorded against a job belongs to a process that is also
 * running other jobs, so signalling it would cancel work nobody asked to
 * cancel. Instead this writes a marker the run itself honours — it drops out
 * of its event stream, which triggers the dispatcher's teardown (killTree on
 * the agent CLI and its children) and releases the workspace lock through the
 * same path a normal finish uses.
 *
 * Two consequences worth stating plainly, because a caller who assumes
 * otherwise will be surprised:
 *
 *   1. It is not instantaneous. A running job stops within about a second;
 *      `cancelling` means requested, not done. Poll job_status to see it land.
 *   2. Work already done is NOT undone. A cancelled agent may have already
 *      edited files in the workspace, and those edits stay. Cancelling stops
 *      further work; it is not a rollback.
 *
 * A cancelled run is deliberately not recorded as a failure: the route's
 * circuit breaker and failure count never see it, because the caller changing
 * their mind says nothing about whether the route works.
 */
export async function cancelJob(jobId: string, reason?: string): Promise<CancelOutcome> {
  const job = await getAsyncJob(jobId); // throws the friendly "No such job" for a stranger
  const current = job.status.status;

  // There are TWO kinds of orphaned job and they need opposite answers.
  //
  //   WRITTEN — `drainSlotQueue` marks a slot-queued job orphaned on disk when
  //     the server exits before it ever starts. That job is genuinely
  //     terminal: its own error text says it is not resumed automatically and
  //     to use retry_job. Cancelling it is a no-op that would leave a marker
  //     nothing reads.
  //   DERIVED — `withOrphanCheck` reports a job orphaned when its heartbeat
  //     goes stale, while the FILE still says `queued` or `running`. That job
  //     is not inert: once the dead owner's claim ages out, claimNextJob will
  //     pick it up and run it. Answering "had already finished; nothing to
  //     cancel" was wrong about work that could still start, and left the
  //     caller no way to stop it.
  //
  // So the raw status decides, not the derived one. `getAsyncJob` has already
  // applied the orphan check, which is why this re-reads the file.
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

  // A job still waiting for a slot has no runner to notice the marker, so
  // stop it here. claimNextJob also refuses to claim a marked job, which
  // closes the window where a supervisor picks it up between these two steps.
  // `orphaned` joins `queued` here rather than falling through to "the runner
  // will notice the marker": an orphaned job has no live runner BY
  // DEFINITION, so nothing would ever act on the marker and the job would sit
  // at "cancelling" forever. The marker written above still matters — it is
  // what stops a supervisor reclaiming it — but the status has to be settled
  // here, by the only process still involved.
  if (current === "queued" || current === "orphaned") {
    await updateStatus(jobDir, {
      ...job.status,
      status: "cancelled",
      updatedAt: timestamp(),
      success: false,
      error: reason !== undefined ? `Cancelled: ${reason}` : "Cancelled before it started.",
    });
    // Deliberately NOT draining the slot queue here. Freeing this job's slot
    // makes room for a waiting one, but drainSlotQueue can SPAWN supervisor
    // processes, and a cancel — the operation whose whole point is to stop
    // work — must not start any. Every dispatch and every runner exit already
    // drains, which is the same "resumes on the next event" contract the
    // queue documents elsewhere.
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

/**
 * Inspect or resolve the isolated workspace a finished job left behind.
 *
 * Looks the job up the same way job_status does, then hands off to
 * workspace-resolve.ts. Kept here so the caller only ever needs a jobId —
 * where the workspace lives, and which policy produced it, are details
 * recorded in the job's own result.
 */
export async function resolveJobWorkspace(
  jobId: string,
  action: "diff" | "apply" | "discard",
  opts: { force?: boolean } = {},
): Promise<unknown> {
  const job = await getAsyncJob(jobId);
  const run = job.result?.result?.workspace;
  if (!isResolvable(run)) {
    // Read through a separate binding: the type guard narrows `run` to never
    // on this branch, which would make the diagnostic unable to say WHICH
    // policy the caller actually got.
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
  if (action === "diff") return workspaceDiff(jobId, jobDir, run);
  if (action === "apply") return applyWorkspace(jobId, jobDir, run, opts);
  // force reaches discard too: it now refuses to destroy work the project
  // does not have, and the caller needs the same override apply offers.
  return discardWorkspace(jobId, run, opts);
}

export interface RetryOutcome {
  jobId: string;
  retryOf: string;
  service?: string;
  reusedFrom: { prompt: boolean; files: number; workingDir: string };
  /**
   * The original's model, when the retry's route does not declare it.
   *
   * `retryJob` has always SET this and the MCP tool description has always
   * documented it, but the interface never listed it — the object is built
   * with a conditional spread, which TypeScript does not excess-property
   * check. So a typed caller could not see a field that ships, and the tests
   * asserting it only compiled because the tests were not typechecked.
   */
  droppedModel?: string;
  message: string;
}

/**
 * Run a finished job's task again.
 *
 * The last verb missing from the job lifecycle: you could start work, watch
 * it, stop it, and resolve its workspace — but if it failed, reproducing it
 * meant reconstructing the prompt, the file list, the working directory and
 * the hints by hand, from a job record that already holds all four. The
 * machinery to execute a job bundle existed (executeJobDir) and simply was
 * not reachable from outside.
 *
 * The prompt is taken from prompt.md, which is the FROZEN prompt — including
 * any context preamble the original dispatch rendered in. A retry therefore
 * reproduces what the delegate actually saw, not what the caller typed.
 *
 * `service` retargets the attempt, which is the common case rather than an
 * afterthought: the reason a run failed is often the route, not the task
 * ("codex hit its usage limit — try claude"). Omit it to reuse the original
 * route, or to let the router pick again if the original had none.
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
  // A DERIVED orphan produces exactly the outcome the message above forbids,
  // and this guard could not see it.
  //
  // `getAsyncJob` reports orphaned when the heartbeat is stale, but the status
  // FILE still says `queued`, and `claimNextJob` filters on the raw file — so
  // a supervisor can still claim the original while the retry runs. The guard
  // reads the derived status, which is neither `running` nor `queued`, so it
  // let the retry through. `cancelJob` was given this reasoning when it learnt
  // to tell the two kinds of orphan apart; retry was not, so the fix stopped
  // one square short.
  //
  // Marking the original cancelled is what closes it: claimNextJob refuses a
  // marked job, so the retry becomes the only attempt. A job orphaned while
  // RUNNING has no live runner either, so the marker is equally correct there
  // and simply has nothing left to interrupt.
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
  if (opts.service !== undefined && !(opts.service in deps.holder.state.config.services)) {
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
 * Retrying somewhere else is the documented reason this tool exists ("the task
 * was fine and the route was not"), and reusing the model verbatim defeated
 * exactly that case: model names are route-scoped, so the retry failed for the
 * same reason as the original. Observed end to end — a Cursor run that died on
 * `Cannot use this model` was retried onto Claude and died on
 * `unrecognized_model`, having never reached the task.
 *
 * Narrow on purpose. The model is kept when the retry stays on the original's
 * route (that is a plain "try again"), and when the new route declares it
 * anyway. Only a model the destination does not know is dropped, and the
 * caller is told — a silently changed model is the failure this project keeps
 * finding, so it is reported in the response rather than inferred from a
 * different result.
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
