/** Running one job: the work a runner process actually does. */

import { existsSync } from "node:fs";
import { createStreamRedactor, redact } from "../redaction.js";
import { appendFile, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DispatchResult, DispatcherEvent, RouteHints, RoutingDecision } from "../types.js";
import {
  boundedError,
  cancelReason,
  cancelRequested,
  claimHolder,
  JOB_EVENTS_LOG,
  readJson,
  timestamp,
  updateStatus,
  withOrphanCheck,
  writeJson,
} from "./store.js";
import { isResolvable, persistWorkspacePatch } from "../workspace-resolve.js";
import { trackChildren } from "./children.js";
import { logDispatch, type DispatchLogContext } from "../dispatch-log.js";
import type { PreparedWorkspace } from "../workspaces.js";
import type { JobChild, JobDeps, JobManifest, JobResultPayload, JobStatus, StartJobInput } from "./types.js";
export async function runJob(
  deps: JobDeps,
  jobDir: string,
  manifest: JobManifest,
  input: StartJobInput,
): Promise<void> {
  const started = Date.now();
  /** The processes this run started that are still alive — see children.ts. */
  let children: JobChild[] = [];
  const runningStatus = (): JobStatus => ({
    jobId: manifest.jobId,
    status: "running",
    createdAt: manifest.createdAt,
    updatedAt: timestamp(),
    jobDir,
    ...(input.service !== undefined ? { service: input.service } : {}),
    ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
    ...(children.length > 0 ? { children } : {}),
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
  /** Set once result.json holds the run's outcome — see the catch below. */
  let saved: DispatchResult | undefined;
  let pendingBeat: Promise<unknown> = Promise.resolve();
  // Chained, so a beat never lands after a later one and puts back a child
  // list that has since changed.
  const beat = (): void => {
    pendingBeat = pendingBeat
      .then(() => (finished ? undefined : updateStatus(jobDir, runningStatus())))
      .catch(() => undefined);
  };
  const heartbeat = setInterval(() => {
    if (finished) return;
    beat();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  await trackChildren(
    (alive) => {
      children = alive;
      // Written at once rather than at the next 15 s beat: a supervisor can
      // die in between, and then the pid is exactly what nobody has.
      if (!finished) beat();
    },
    async () => {
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
      const eventsPath = path.join(jobDir, "output", JOB_EVENTS_LOG);
      // Cancellation travels DOWN to the child process, not up through the
      // iterator. Returning from an async generator that is suspended at an
      // `await` does not take effect until that await settles — which for an
      // agent CLI gone quiet is never — so the only thing that reliably stops a
      // silent run is aborting the subprocess (or fetch) directly.
      const cancelController = new AbortController();
      // The latest attempt's workspace, so a cancellation can still record it.
      let workspace: PreparedWorkspace | undefined;
      const onWorkspace = (ws: PreparedWorkspace): void => {
        workspace = ws;
      };
      const logContext = { jobId: manifest.jobId, ...(manifest.caller ?? {}) };
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
            onWorkspace,
            logContext,
          })
        : state.router.stream(input.prompt, files, workingDir, {
            hints,
            maxFallbacks: 2,
            defaultTimeoutMs: JOB_DEFAULT_TIMEOUT_MS,
            signal: cancelController.signal,
            onWorkspace,
            logContext,
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
      // state and the caller polls a corpse.
      let pending: Promise<IteratorResult<{ event: DispatcherEvent; decision?: RoutingDecision | null }>> | undefined;
      // A key split across two chunks would survive per-chunk redaction.
      const partialRedactor = createStreamRedactor();
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
            const text = partialRedactor.push(event.chunk);
            if (text !== "") await appendFile(partialPath, text, { encoding: "utf8", mode: 0o600 });
          } catch {
            // Progress mirroring is best-effort; the final result still lands.
          }
        } else if (event.type === "completion") {
          // Fallback chains yield one completion per attempt; last one wins.
          finalResult = event.result;
        }
        // The events a caller streaming this job needs, in order: answer text
        // as it arrives, and each attempt's completion. A streaming HTTP request
        // follows this file instead of the router, which is what gives it a job
        // record — before, it was the one dispatch path with none, so a dropped
        // connection or a restart lost work that had finished.
        if ((event.type === "stdout" && event.text === true) || event.type === "completion") {
          try {
            await appendFile(eventsPath, `${redact(JSON.stringify(event))}\n`, {
              encoding: "utf8",
              mode: 0o600,
            });
          } catch {
            // Best-effort, like the partial log; result.json still lands.
          }
        }
      }
      const tail = partialRedactor.flush();
      if (tail !== "") {
        await appendFile(partialPath, tail, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
      }
      if (cancelled) {
        // Terminal, and deliberately NOT routed through the router's
        // result/failure path: the router never sees a failure, so a
        // cancellation cannot charge the route's breaker or failure count for
        // the caller changing their mind.
        finished = true;
        await pendingBeat;
        const reason = await cancelReason(jobDir);
        const cancelError =
          reason !== undefined ? `Cancelled: ${reason}` : "Cancelled before it finished.";
        await recordCancelledWorkspace(jobDir, manifest.jobId, workspace, pending, {
          output: "",
          service: finalDecision?.service ?? input.service ?? "none",
          success: false,
          error: cancelError,
        }, finalDecision);
        await updateStatus(jobDir, {
          jobId: manifest.jobId,
          status: "cancelled",
          createdAt: manifest.createdAt,
          updatedAt: timestamp(),
          jobDir,
          ...(input.service !== undefined ? { service: input.service } : {}),
          success: false,
          error: cancelError,
          ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
          durationMs: Date.now() - started,
        });
        logCancelledRun(
          finalDecision?.service ?? input.service ?? "none",
          cancelError,
          Date.now() - started,
          finalDecision,
          logContext,
        );
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

      // Save the patch now, while the workspace still exists: an isolated
      // workspace lives under the OS temp directory, which Linux clears on
      // reboot and WSL clears when its VM idles out, so building it lazily on
      // `diff`/`apply` can find nothing left. Best effort — never fails the job.
      if (isResolvable(result.workspace)) {
        await persistWorkspacePatch(jobDir, result.workspace);
      }

      const payload: JobResultPayload = {
        jobId: manifest.jobId,
        result: { ...result, ...(result.error !== undefined ? { error: boundedError(result.error)! } : {}) },
        decision: finalDecision,
      };
      await writeFile(path.join(jobDir, "output", "stdout.log"), redact(result.output), { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(jobDir, "output", "stderr.log"), redact(result.error ?? ""), { encoding: "utf8", mode: 0o600 });
      await writeJson(path.join(jobDir, "output", "result.json"), payload);
      saved = result;
      await writeFile(
        path.join(jobDir, "output", "result.md"),
        redact(result.output || result.error || ""),
        { encoding: "utf8", mode: 0o600 },
      );
      // A successful job's whole answer is now in result.json and stdout.log, so
      // the raw progress stream is a second copy of it: 78% of a measured state
      // directory. Kept for a failure (and for a success with no output of its
      // own), where it is the only trail of what the agent did.
      if (result.success && result.output !== "") {
        await rm(partialPath, { force: true }).catch(() => undefined);
      }
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
        // Redacted like the success path above — both branches write the same
        // log and must scrub it the same way.
        await writeFile(path.join(jobDir, "output", "stderr.log"), redact(message), {
          encoding: "utf8",
          mode: 0o600,
        });
        // The run's outcome is already in result.json when a LATER write
        // fails (result.md, the status update itself). Recording that as a
        // failed job contradicted the saved result, and a caller told "failed"
        // retries work that had succeeded. The outcome stands; the write
        // failure is reported beside it.
        const warning =
          saved !== undefined
            ? `The result was saved, but writing the job's other files failed: ${message}`
            : undefined;
        const warnings = [manifest.warning, warning].filter((w): w is string => w !== undefined);
        await updateStatus(jobDir, {
          jobId: manifest.jobId,
          status: saved === undefined ? "failed" : saved.success ? "completed" : "failed",
          createdAt: manifest.createdAt,
          updatedAt: timestamp(),
          jobDir,
          ...(input.service !== undefined ? { service: input.service } : {}),
          ...(saved !== undefined ? { route: saved.service } : {}),
          success: saved?.success ?? false,
          ...(saved === undefined
            ? { error: boundedError(message)! }
            : saved.error !== undefined
              ? { error: boundedError(saved.error)! }
              : {}),
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          durationMs: Date.now() - started,
        });
      } catch {
        // The job directory can be GONE by the time a failure is recorded —
        // retention pruning, or a caller that tore down its state mid-run.
        // There is nowhere to write and no reader left to care; throwing here
        // would reject `completion`, which is documented to never reject.
      }
    } finally {
      clearInterval(heartbeat);
    }
    },
  );
}


/**
 * One dispatch-log line for a run that was cancelled.
 *
 * A cancel bypasses the router on purpose, so the breaker is never charged for
 * a caller changing their mind — and that also kept it out of the log, which
 * the router writes. The runs cancelled for hanging (31-35 minutes of silence,
 * in the real log) were exactly the ones no latency or success figure could
 * see. `reason: "cancelled"` marks them; the breaker still never sees them.
 */
export function logCancelledRun(
  route: string,
  error: string,
  durationMs: number | undefined,
  decision: RoutingDecision | null,
  context: DispatchLogContext,
): void {
  logDispatch(
    route,
    { output: "", service: route, success: false, error, ...(durationMs !== undefined ? { durationMs } : {}) },
    // The log takes its `reason` from the decision. A run cancelled before
    // the router decided anything has none, so this one carries only that.
    { ...(decision ?? {}), reason: "cancelled" } as RoutingDecision,
    context,
  );
}

/** How often a live background run bumps its status file's updatedAt. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Fallback dispatch timeout for jobs. Dispatchers hard-code a short default
 * (10 min for CLI harnesses, 2 min for openai_compatible) meant to catch a
 * genuinely hung process — waiting on stdin that'll never come, a stalled
 * network call — not to cap a slow-but-healthy run. A background job is
 * polled rather than blocking a caller, so nothing about it requires killing
 * a process that's still making progress after 10 minutes. Below both an
 * explicit `hints.timeoutMs` and the route's own configured `timeoutMs` in
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
/**
 * Keep a cancelled isolated run's work reachable.
 *
 * A cancel abandons the stream before any completion arrives, and the
 * completion is where an isolated workspace's record — which files changed,
 * and so what the patch is — gets produced. Without this, cancelling a
 * `copy`/`git_worktree` run leaves the agent's edits in a workspace nothing
 * points at, which retention then deletes a day later.
 *
 * Only the router's breaker accounting is skipped for a cancel; the result is
 * written, so `workspace diff`/`apply` work on it like on any other run.
 */
async function recordCancelledWorkspace(
  jobDir: string,
  jobId: string,
  workspace: PreparedWorkspace | undefined,
  pending: Promise<unknown> | undefined,
  cancelled: DispatchResult,
  decision: RoutingDecision | null,
): Promise<void> {
  if (workspace === undefined || !workspace.isolated) return;
  // The abort has only been SENT. Give the child a bounded moment to die, so
  // the fingerprint below sees its last write rather than racing it — the
  // in-flight read settles once the process is gone.
  if (pending !== undefined) {
    await Promise.race([pending.catch(() => undefined), delay(10_000, undefined, { ref: false })]);
  }
  let finished: DispatchResult;
  try {
    // Single-use: if the dispatcher's own completion got there first, this
    // returns that same record rather than finishing the workspace twice.
    finished = await workspace.finish(cancelled);
  } catch {
    return;
  }
  if (!isResolvable(finished.workspace)) return;
  await persistWorkspacePatch(jobDir, finished.workspace);
  const payload: JobResultPayload = {
    jobId,
    result: { ...finished, success: false, error: cancelled.error ?? "Cancelled." },
    decision,
  };
  await writeJson(path.join(jobDir, "output", "result.json"), payload);
}

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
  // moves between directories. Returning undefined is not an error anywhere,
  // it is the signal to run the job IN-PROCESS — so a stale candidate list
  // silently stops every dispatch being detached, and the concurrency gate
  // with it.
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

/** How often a watch of a waiting job checks that something will run it. */
const WAITING_NUDGE_MS = 10_000;

/**
 * Watch a detached job's directory until it reaches a terminal state
 * (result.json present, or a failed/orphaned status — the orphan check
 * doubles as the exit path if the runner dies). Timer is unref'd: an
 * exiting server abandons the watch, which is exactly the point of
 * detached execution.
 *
 * `onEvent` gets the run's output as it lands in stdout.partial.log. The run
 * lives in another process, so the in-process event tap never fires for it —
 * progress notifications on the default path were documented, tested (in the
 * in-process mode the suite forces) and never sent. The partial log is the one
 * record of output every route writes, and it is already redacted.
 *
 * `signal` ends the watch early. The MCP dispatch path stops listening once its
 * grace window is over; before, this loop went on reading status.json every
 * 300 ms for up to 70 minutes per dispatch with nobody awaiting it.
 */
export async function watchUntilTerminal(
  jobDir: string,
  opts: {
    onEvent?: (event: DispatcherEvent) => void;
    signal?: AbortSignal;
    /**
     * Called, at most every WAITING_NUDGE_MS, while the job is queued and no
     * supervisor has claimed it. A released job used to read as orphaned
     * after 90 s, which ended this watch; it now reads as waiting, so a
     * caller awaiting the whole run (HTTP) needs something to start a
     * supervisor if every one has died.
     */
    onWaiting?: () => Promise<unknown>;
  } = {},
): Promise<void> {
  const deadline = Date.now() + JOB_DEFAULT_TIMEOUT_MS + 10 * 60 * 1000;
  const tail = opts.onEvent !== undefined ? partialLogTail(jobDir, opts.onEvent) : undefined;
  let lastNudge = Date.now();
  while (Date.now() < deadline && opts.signal?.aborted !== true) {
    await tail?.();
    // Waits for a terminal STATUS, deliberately not for result.json: runJob
    // writes result.json and then updates the status, so returning on
    // result.json alone resolves in the window between the two and a caller
    // can read `status: "running"` from the job it was just told had
    // finished. Because the status write comes last, a terminal status
    // implies the result is already on disk. A runner that dies between the
    // two writes is covered by withOrphanCheck below.
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
        await tail?.(); // Output written just before the terminal status.
        return;
      }
      if (
        opts.onWaiting !== undefined &&
        status.status === "queued" &&
        Date.now() - lastNudge >= WAITING_NUDGE_MS &&
        claimHolder(jobDir) === undefined
      ) {
        lastNudge = Date.now();
        await opts.onWaiting().catch(() => undefined);
      }
    } catch {
      // Transient read during an atomic rename — retry next tick.
    }
    await delay(TERMINAL_WATCH_INTERVAL_MS, undefined, { ref: false });
  }
}

/**
 * A reader that hands each call's new bytes of stdout.partial.log to `onEvent`
 * as one stdout event. Decoded across reads, so a multi-byte character split
 * between two appends is not mangled.
 */
function partialLogTail(
  jobDir: string,
  onEvent: (event: DispatcherEvent) => void,
): () => Promise<void> {
  const file = path.join(jobDir, "output", "stdout.partial.log");
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  return async () => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, "r");
      const { size } = await handle.stat();
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      offset += bytesRead;
      const chunk = decoder.write(buf.subarray(0, bytesRead));
      if (chunk === "") return;
      try {
        onEvent({ type: "stdout", chunk });
      } catch {
        // Progress forwarding is best-effort; the watch must go on.
      }
    } catch {
      // Not written yet: the next tick reads it.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
}
