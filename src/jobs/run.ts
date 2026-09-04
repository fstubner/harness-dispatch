/**
 * Running one job: the work a runner process actually does.
 *
 * Split out of jobs.ts, which had grown to hold five concerns at 1,600 lines
 * — this one, admission and the supervisor pool, the start/read verbs, and
 * the lifecycle verbs. Nothing here was rewritten; the code moved.
 */

import { existsSync } from "node:fs";
import { redact } from "../redaction.js";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DispatchResult, DispatcherEvent, RouteHints, RoutingDecision } from "../types.js";
import {
  boundedError,
  cancelReason,
  cancelRequested,
  readJson,
  timestamp,
  updateStatus,
  withOrphanCheck,
  writeJson,
} from "./store.js";
import type { JobDeps, JobManifest, JobResultPayload, JobStatus, StartJobInput } from "./types.js";
export async function runJob(
  deps: JobDeps,
  jobDir: string,
  manifest: JobManifest,
  input: StartJobInput,
): Promise<void> {
  const started = Date.now();
  const runningStatus = (): JobStatus => ({
    jobId: manifest.jobId,
    status: "running",
    createdAt: manifest.createdAt,
    updatedAt: timestamp(),
    jobDir,
    ...(input.service !== undefined ? { service: input.service } : {}),
    ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
  });
  await updateStatus(jobDir, runningStatus());

  // Heartbeat: bump updatedAt while the run is alive so a reader can tell
  // "running" apart from "the server that owned this run died and left a
  // stale status file" (getAsyncJob reports the latter as "orphaned").
  // unref'd so an exiting process never lingers on it — which is exactly
  // the scenario the heartbeat exists to expose. The `finished` flag stops
  // a beat that FIRES after the terminal write; `pendingBeat` covers the
  // beat that fired BEFORE it and is still mid-write — updateStatus's rename
  // can back off ~900ms on Windows EPERM, long enough to land after the
  // terminal status and re-mark a completed job "running" (then "orphaned"
  // forever in the list view). The terminal paths await it before writing.
  let finished = false;
  let pendingBeat: Promise<unknown> = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (finished) return;
    pendingBeat = updateStatus(jobDir, runningStatus()).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const state = deps.holder.state;
    const files = input.files ?? [];
    // Reuse the value already resolved (and recorded) at job creation, not a
    // fresh process.cwd() snapshot — the two must stay in sync with the
    // warning captured in manifest.warning.
    const workingDir = manifest.workingDir;
    const hints: RouteHints = { ...(input.hints ?? {}) };
    if (input.workspacePolicy !== undefined) hints.workspacePolicy = input.workspacePolicy;

    // Stream the dispatch so agents polling action=get can watch progress in
    // stdout.partial.log instead of waiting blind for the final result.
    const partialPath = path.join(jobDir, "output", "stdout.partial.log");
    // Cancellation travels DOWN to the child process, not up through the
    // iterator. Returning from an async generator that is suspended at an
    // `await` does not take effect until that await settles — which for an
    // agent CLI gone quiet is never — so the only thing that reliably stops a
    // silent run is aborting the subprocess (or fetch) directly.
    const cancelController = new AbortController();
    const events = input.service
      ? state.router.streamTo(input.service, input.prompt, files, workingDir, {
          ...(hints.safetyProfile !== undefined
            ? { safetyProfile: hints.safetyProfile }
            : {}),
          ...(hints.workspacePolicy !== undefined
            ? { workspacePolicy: hints.workspacePolicy }
            : {}),
          ...(hints.routePolicy !== undefined
            ? { routePolicy: hints.routePolicy }
            : {}),
          ...(hints.model !== undefined ? { model: hints.model } : {}),
          ...(hints.taskType !== undefined ? { taskType: hints.taskType } : {}),
          ...(hints.timeoutMs !== undefined ? { timeoutMs: hints.timeoutMs } : {}),
          defaultTimeoutMs: JOB_DEFAULT_TIMEOUT_MS,
          signal: cancelController.signal,
        })
      : state.router.stream(input.prompt, files, workingDir, {
          hints,
          maxFallbacks: 2,
          defaultTimeoutMs: JOB_DEFAULT_TIMEOUT_MS,
          signal: cancelController.signal,
        });

    let finalResult: DispatchResult | null = null;
    let finalDecision: RoutingDecision | null = null;
    let cancelled = false;

    // Driven through an explicit iterator rather than `for await`, so a
    // cancellation can interrupt a stream that is producing NOTHING. A
    // for-await body only runs when an event arrives, and the case that most
    // needs cancelling is the agent that has gone quiet for twenty minutes.
    // Racing next() against a poll lets us stop either way, and calling
    // return() on the iterator is what tears the child process down —
    // stream-subprocess's return() runs killTree, which on POSIX now signals
    // the whole process group.
    const iterator = events[Symbol.asyncIterator]();
    const CANCEL_POLL_MS = 1_000;
    // The in-flight next() is held ACROSS polls rather than re-issued.
    // Racing a fresh iterator.next() each time round drops events: when the
    // poll wins, the previous next() is still pending, and calling next()
    // again queues a second pull whose result is the one we read — the first
    // event resolves into nothing. Losing a `completion` that way leaves a
    // finished run with no result.json, so the job never reaches a terminal
    // state and the caller polls a corpse. Caught by the slot-queue test,
    // which waits for a queued job to actually complete.
    let pending: Promise<IteratorResult<{ event: DispatcherEvent; decision?: RoutingDecision | null }>> | undefined;
    for (;;) {
      pending ??= iterator.next() as Promise<
        IteratorResult<{ event: DispatcherEvent; decision?: RoutingDecision | null }>
      >;
      const winner = await Promise.race([
        pending.then((r) => ({ kind: "event" as const, r })),
        delay(CANCEL_POLL_MS, { kind: "poll" as const }, { ref: false }),
      ]);
      if (winner.kind === "poll") {
        if (!cancelRequested(jobDir)) continue; // `pending` deliberately kept
        cancelled = true;
        cancelController.abort();
        // Not awaited: the generator is parked on an await that only settles
        // once the abort above kills the child, so awaiting return() here
        // would deadlock on the very thing it is trying to stop.
        void iterator.return?.().catch(() => undefined);
        break;
      }
      pending = undefined;
      const next = winner.r;
      if (next.done) break;
      if (cancelRequested(jobDir)) {
        cancelled = true;
        cancelController.abort();
        void iterator.return?.().catch(() => undefined);
        break;
      }
      const { event, decision } = next.value;
      if (decision) finalDecision = decision;
      if (input.onEvent) {
        try {
          input.onEvent(event);
        } catch {
          // Progress forwarding is best-effort; the job itself must not fail.
        }
      }
      if (event.type === "stdout" || event.type === "stderr") {
        try {
          await appendFile(partialPath, redact(event.chunk), { encoding: "utf8", mode: 0o600 });
        } catch {
          // Progress mirroring is best-effort; the final result still lands.
        }
      } else if (event.type === "completion") {
        // Fallback chains yield one completion per attempt; last one wins.
        finalResult = event.result;
      }
    }
    if (cancelled) {
      // Terminal, and deliberately NOT routed through the result/failure path:
      // no result.json is written and the router never sees a failure, so a
      // cancellation cannot charge the route's breaker or failure count for
      // the caller changing their mind.
      finished = true;
      await pendingBeat;
      const reason = await cancelReason(jobDir);
      await updateStatus(jobDir, {
        jobId: manifest.jobId,
        status: "cancelled",
        createdAt: manifest.createdAt,
        updatedAt: timestamp(),
        jobDir,
        ...(input.service !== undefined ? { service: input.service } : {}),
        success: false,
        error: reason !== undefined ? `Cancelled: ${reason}` : "Cancelled before it finished.",
        ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
        durationMs: Date.now() - started,
      });
      return;
    }

    const result: DispatchResult = finalResult ?? {
      output: "",
      service: input.service ?? "none",
      success: false,
      error: "Router stream ended without a completion event",
    };

    finished = true;
    await pendingBeat;
    const payload: JobResultPayload = {
      jobId: manifest.jobId,
      result: { ...result, ...(result.error !== undefined ? { error: boundedError(result.error)! } : {}) },
      decision: finalDecision,
    };
    await writeFile(path.join(jobDir, "output", "stdout.log"), redact(result.output), { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(jobDir, "output", "stderr.log"), redact(result.error ?? ""), { encoding: "utf8", mode: 0o600 });
    await writeJson(path.join(jobDir, "output", "result.json"), payload);
    await writeFile(
      path.join(jobDir, "output", "result.md"),
      redact(result.output || result.error || ""),
      { encoding: "utf8", mode: 0o600 },
    );
    await updateStatus(jobDir, {
      jobId: manifest.jobId,
      status: result.success ? "completed" : "failed",
      createdAt: manifest.createdAt,
      updatedAt: timestamp(),
      jobDir,
      ...(input.service !== undefined ? { service: input.service } : {}),
      route: result.service,
      success: result.success,
      ...(result.error !== undefined ? { error: boundedError(result.error)! } : {}),
      ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    finished = true;
    await pendingBeat;
    const message = err instanceof Error ? err.message : String(err);
    try {
      // The sibling of the success path 25 lines up, which redacts. Missing
      // this one is the same one-branch-of-a-pair miss the chokepoint exists
      // to make impossible, found in the very file the chokepoint edited.
      await writeFile(path.join(jobDir, "output", "stderr.log"), redact(message), {
        encoding: "utf8",
        mode: 0o600,
      });
      await updateStatus(jobDir, {
        jobId: manifest.jobId,
        status: "failed",
        createdAt: manifest.createdAt,
        updatedAt: timestamp(),
        jobDir,
        ...(input.service !== undefined ? { service: input.service } : {}),
        success: false,
        error: boundedError(message)!,
        ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
        durationMs: Date.now() - started,
      });
    } catch {
      // The job directory can be GONE by the time a failure is recorded —
      // retention pruning, or a caller that tore down its state mid-run.
      // There is nowhere to write and no reader left to care; throwing here
      // would reject `completion`, which is documented to never reject (and
      // surfaced in CI as an unhandled rejection out of a finished test).
    }
  } finally {
    clearInterval(heartbeat);
  }
}


/** How often a live background run bumps its status file's updatedAt. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Fallback dispatch timeout for jobs. Dispatchers hard-code a short default
 * (10 min for CLI harnesses, 2 min for openai_compatible) meant to catch a
 * genuinely hung process — waiting on stdin that'll never come, a stalled
 * network call — not to cap a slow-but-healthy run. That default made sense
 * as-is for `code`, which blocks an MCP call anyway, but `job` runs in the
 * background and is polled, so nothing about it requires killing a process
 * that's still making progress after 10 minutes. Below both an explicit
 * `hints.timeoutMs` and the route's own configured `timeoutMs` in
 * precedence, so this only fills the gap when nobody set either.
 *
 * Router.stream() treats this specific value as a budget for the WHOLE call
 * (including router fallback retries), not a per-attempt allowance — without
 * that, a job that falls back twice (the router's default maxFallbacks: 2)
 * could burn up to 3x this value before failing conclusively.
 */
export const JOB_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;


/**
 * Rebuild a job's input from its on-disk bundle and execute it. This is the
 * detached runner's whole job; the manifest deliberately carries everything
 * a run needs (prompt path, resolved workingDir, hints, service) precisely
 * so execution can happen in a process that wasn't there when the job was
 * created.
 */
export async function executeJobDir(deps: JobDeps, jobDir: string): Promise<void> {
  const manifest = await readJson<JobManifest>(path.join(jobDir, "manifest.json"));
  const prompt = await readFile(manifest.promptPath, "utf8");
  const input: StartJobInput = {
    prompt,
    files: manifest.files.map((f) => f.originalPath),
    workingDir: manifest.workingDir,
    ...(manifest.hints !== undefined ? { hints: manifest.hints } : {}),
    ...(manifest.workspacePolicy !== undefined
      ? { workspacePolicy: manifest.workspacePolicy }
      : {}),
    ...(manifest.service !== undefined ? { service: manifest.service } : {}),
  };
  await runJob(deps, jobDir, manifest, input);
}

/** dist/job-runner.js next to this module (compiled), or via the package's dist/ when running from src. */
export function resolveRunnerPath(): string | undefined {
  // Resolved against THIS module's own location, which is a trap worth
  // stating: the candidates below have to be updated whenever this function
  // moves between directories. Splitting jobs.ts moved it from `dist/` down
  // into `dist/jobs/`, both candidates missed, and the function returned
  // undefined — which is not an error anywhere, it is the signal to run the
  // job IN-PROCESS. So every dispatch quietly stopped being detached and the
  // concurrency gate stopped firing, with nothing failing until the job
  // concurrency tests ran.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/jobs/run.js -> dist/job-runner.js (the built layout today)
    path.join(here, "..", "job-runner.js"),
    // Beside this file, if the build ever flattens or co-locates it.
    path.join(here, "job-runner.js"),
    // src/jobs/run.ts with a dist/ build present (unbuilt checkout, tests).
    path.join(here, "..", "..", "dist", "job-runner.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

const TERMINAL_WATCH_INTERVAL_MS = 300;

/**
 * Watch a detached job's directory until it reaches a terminal state
 * (result.json present, or a failed/orphaned status — the orphan check
 * doubles as the exit path if the runner dies). Timer is unref'd: an
 * exiting server abandons the watch, which is exactly the point of
 * detached execution.
 */
export async function watchUntilTerminal(jobDir: string): Promise<void> {
  const deadline = Date.now() + JOB_DEFAULT_TIMEOUT_MS + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    // Waits for a terminal STATUS, deliberately not for result.json.
    //
    // runJob writes result.json and then updates the status, so returning on
    // result.json alone let this resolve in the window between the two: a
    // caller could `await` a job and then read `status: "running"` from the
    // job it had just been told was finished. Observed on Windows CI as
    // "expected 'running' to be 'completed'".
    //
    // Because the status write comes last, a terminal status implies the
    // result is already on disk — the ordering does the synchronising, so no
    // extra check is needed here. A runner that dies between the two writes
    // is covered by withOrphanCheck below, which is the same exit path as any
    // other dead runner.
    try {
      const status = withOrphanCheck(
        await readJson<JobStatus>(path.join(jobDir, "status.json")),
      );
      if (
        status.status === "completed" ||
        status.status === "failed" ||
        status.status === "orphaned" ||
        status.status === "cancelled"
      ) {
        return;
      }
    } catch {
      // Transient read during an atomic rename — retry next tick.
    }
    await delay(TERMINAL_WATCH_INTERVAL_MS, undefined, { ref: false });
  }
}
