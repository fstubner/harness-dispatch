/**
 * Async job bundle support.
 *
 * `dispatch` returns quickly after creating a reproducible bundle on disk,
 * then the run executes in a DETACHED job-runner process (job-runner.ts) —
 * not inside the MCP server — so a server restart, session reconnect, or
 * client timeout never kills an in-flight run. The server (and any later
 * server instance) reads progress and results back from the job directory.
 * Set HARNESS_DISPATCH_INPROC_JOBS=1 to run jobs in-process instead (used
 * by the unit-test suite, which injects fake dispatchers a separate
 * process could not see).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { RuntimeHolder } from "./mcp/config-hot-reload.js";
import type {
  DispatchResult,
  DispatcherEvent,
  RouteHints,
  RouterConfig,
  RoutingDecision,
  WorkspacePolicy,
} from "./types.js";
import { resolveWorkingDir, validateWorkingDir, workingDirWarning } from "./working-dir.js";
import { acquireWorkspaceLock } from "./workspace-lock.js";
import { buildContextPreamble } from "./jobs/context.js";
import {
  assertValidJobId,
  boundedError,
  JOB_ID_RE,
  jobsRoot,
  newJobId,
  ORPHAN_THRESHOLD_MS,
  pollInstructions,
  pruneStaleJobs,
  readJson,
  safeBaseName,
  setJobRetentionDays,
  snapshotFiles,
  SUGGESTED_POLL_SECONDS,
  timestamp,
  updateStatus,
  withOrphanCheck,
  writeJson,
} from "./jobs/store.js";
import type {
  JobDeps,
  JobManifest,
  JobResultPayload,
  JobStatus,
  StartedJob,
  StartJobInput,
} from "./jobs/types.js";

// Re-exported so existing importers (mcp/tools.ts, http/server.ts, the job
// runner, and the tests) keep their current import paths through the split.
export { buildContextPreamble };
export { setJobRetentionDays };
export type { JobDeps, JobManifest, JobResultPayload, JobStatus, StartedJob, StartJobInput };
import { stateRoot } from "./state-dir.js";



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
const JOB_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;





















async function runJob(
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
        })
      : state.router.stream(input.prompt, files, workingDir, {
          hints,
          maxFallbacks: 2,
          defaultTimeoutMs: JOB_DEFAULT_TIMEOUT_MS,
        });

    let finalResult: DispatchResult | null = null;
    let finalDecision: RoutingDecision | null = null;
    for await (const { event, decision } of events) {
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
          await appendFile(partialPath, event.chunk, { encoding: "utf8", mode: 0o600 });
        } catch {
          // Progress mirroring is best-effort; the final result still lands.
        }
      } else if (event.type === "completion") {
        // Fallback chains yield one completion per attempt; last one wins.
        finalResult = event.result;
      }
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
    await writeFile(path.join(jobDir, "output", "stdout.log"), result.output, { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(jobDir, "output", "stderr.log"), result.error ?? "", { encoding: "utf8", mode: 0o600 });
    await writeJson(path.join(jobDir, "output", "result.json"), payload);
    await writeFile(
      path.join(jobDir, "output", "result.md"),
      result.output || result.error || "",
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
      await writeFile(path.join(jobDir, "output", "stderr.log"), message, {
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
function resolveRunnerPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "job-runner.js"),
    path.join(here, "..", "dist", "job-runner.js"),
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
async function watchUntilTerminal(jobDir: string): Promise<void> {
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
        status.status === "orphaned"
      ) {
        return;
      }
    } catch {
      // Transient read during an atomic rename — retry next tick.
    }
    await delay(TERMINAL_WATCH_INTERVAL_MS, undefined, { ref: false });
  }
}

/**
 * Default ceiling on agent CLIs running at once, machine-wide.
 *
 * 4 is a resource guard, not a throughput target. Measured 2026-08-03: 20
 * dispatches to one route, 13 running concurrently, 10 of the 20 failing, one
 * killed outright by a Rust OOM inside Codex. Agent CLIs each carry a model
 * runtime; the binding constraint is memory, not cores, so this does NOT
 * scale with CPU count. Override with `max_concurrent_runs:` in config.yaml
 * (0 disables the bound).
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

function maxConcurrentRuns(config: RouterConfig | undefined): number {
  const configured = config?.maxConcurrentRuns;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

/** Job dirs, oldest first by name — jobIds embed Date.now(), so name order is start order. */
async function readJobStatuses(): Promise<Array<{ jobDir: string; status: JobStatus }>> {
  const root = jobsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: Array<{ jobDir: string; status: JobStatus }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(root, entry.name);
    try {
      out.push({ jobDir, status: await readJson<JobStatus>(path.join(jobDir, "status.json")) });
    } catch {
      // Half-written or pruned mid-scan — not a live run either way.
    }
  }
  return out;
}

/**
 * Occupied slots: jobs actually executing right now. Counts `running` (and
 * plain `queued` — a runner spawned but not yet started) only while the
 * heartbeat is fresh, so a crashed runner's slot is reclaimed by the same
 * ORPHAN_THRESHOLD_MS rule that already frees its status. Slot-queued jobs
 * are waiting for a slot, not holding one.
 */
function countActiveRuns(statuses: Array<{ status: JobStatus }>): number {
  let active = 0;
  for (const { status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "running" && status.status !== "queued") continue;
    const beat = Date.parse(status.updatedAt);
    if (Number.isFinite(beat) && Date.now() - beat > ORPHAN_THRESHOLD_MS) continue;
    active += 1;
  }
  return active;
}


// ---------------------------------------------------------------------------
// Supervisor pool
// ---------------------------------------------------------------------------

/**
 * How many supervisor PROCESSES may exist, regardless of how many jobs run.
 *
 * Previously every job got its own detached Node process. Measured on Windows
 * with Node 24: a bare node process is 52 MB RSS and one that has bootstrapped
 * a runtime is 65 MB, against ~54 MB for the agent CLI it exists to supervise.
 * So more than half the memory of a concurrent run was wrapper, and it scaled
 * linearly — 13 concurrent jobs meant 845 MB of supervision before any agent
 * had read a file. That is the concurrency ceiling.
 *
 * A supervisor is almost entirely idle: it waits on a child process and writes
 * the result. One can watch several at once for the cost of async I/O, so
 * wrapper memory becomes O(1) in the number of jobs instead of O(N), capped
 * here at ~260 MB.
 *
 * Four rather than one purely to bound blast radius: a supervisor crash strands
 * only the jobs it held. Those are recoverable anyway — the job directory is
 * the source of truth and the heartbeat check already marks stranded jobs
 * orphaned — but losing a quarter of in-flight work beats losing all of it.
 */
export const SUPERVISOR_POOL_SIZE = 4;

/** Poll interval while a supervisor waits for claimable work. */
const SUPERVISOR_POLL_MS = 250;

/** How long a supervisor stays alive with nothing to do before exiting. */
const SUPERVISOR_IDLE_EXIT_MS = 5_000;

/** Jobs one supervisor may run at once, so the pool can reach the global limit. */
function jobsPerSupervisor(limit: number): number {
  return Math.max(1, Math.ceil(limit / SUPERVISOR_POOL_SIZE));
}

/**
 * Take exclusive ownership of a job directory.
 *
 * `wx` fails if the file exists, atomically, on both Windows and POSIX — which
 * is what stops two supervisors racing onto the same job. A claim left behind
 * by a crashed supervisor is reclaimed once that job's heartbeat has gone
 * stale, by the same ORPHAN_THRESHOLD_MS rule used everywhere else.
 *
 * Exported for tests: the one-winner property under concurrent reclaim is the
 * invariant, and it is only checkable by calling this directly.
 */
export async function claimJobDir(jobDir: string, status: JobStatus): Promise<boolean> {
  const claimPath = path.join(jobDir, "claim.json");
  try {
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, at: timestamp() }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch {
    const beat = Date.parse(status.updatedAt);
    if (!Number.isFinite(beat) || Date.now() - beat <= ORPHAN_THRESHOLD_MS) return false;
    // Reclaiming a crashed supervisor's claim must pick exactly ONE winner.
    // This path used to rewrite claim.json WITHOUT `wx`, so two supervisors
    // deciding "stale" in the same window both succeeded — the job ran twice,
    // a duplicate CLI execution billed twice. Renaming the stale claim aside
    // is atomic: the loser gets ENOENT and leaves the job alone, and the
    // winner still has to win the `wx` create below like any first claimant.
    const tomb = path.join(
      path.dirname(claimPath),
      `claim.stale-${process.pid}-${Date.now().toString(36)}`,
    );
    try {
      await rename(claimPath, tomb);
    } catch {
      return false; // Another supervisor reclaimed it first.
    }
    await rm(tomb, { force: true }).catch(() => undefined);
    try {
      await writeFile(claimPath, JSON.stringify({ pid: process.pid, at: timestamp() }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Oldest released-but-unstarted job this supervisor can take, or undefined.
 *
 * "Released" means drainSlotQueue already granted it a slot and cleared
 * slotQueued; it is waiting for a supervisor rather than for capacity. A job
 * that is still slotQueued is deliberately NOT claimable here — that would let
 * a supervisor jump the FIFO order the drainer exists to enforce.
 */
async function claimNextJob(): Promise<string | undefined> {
  const statuses = await readJobStatuses();
  for (const { jobDir, status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "queued") continue;
    if (!(await claimJobDir(jobDir, status))) continue;
    return jobDir;
  }
  return undefined;
}

/**
 * Supervisor main loop: claim work, run several jobs at once, exit when idle.
 *
 * Exiting on idle keeps the no-jobs steady state at zero processes, same as
 * before — the pool is a way to share supervision cost while work exists, not
 * a daemon.
 */
export async function runSupervisor(deps: JobDeps, supervisorId?: string): Promise<void> {
  const inflight = new Set<Promise<unknown>>();
  let idleSince = Date.now();

  // Heartbeat so drainSlotQueue can tell how many supervisors already exist
  // and avoid piling on. Same staleness rule as jobs, so a killed supervisor
  // stops being counted without anything having to clean up after it.
  const beatDir = path.join(jobsRoot(), ".supervisors");
  // Adopt the file the spawning process already created for this slot, so the
  // slot is continuously accounted for rather than briefly disappearing
  // between the parent's registration and the child's first beat.
  const beatFile = path.join(beatDir, `${supervisorId ?? process.pid}.txt`);
  await mkdir(beatDir, { recursive: true, mode: 0o700 });
  const beat = async (): Promise<void> => {
    try {
      await writeFile(beatFile, timestamp(), { encoding: "utf8", mode: 0o600 });
    } catch {
      // A missing heartbeat only risks an extra supervisor, which exits idle.
    }
  };
  await beat();
  const beatTimer = setInterval(() => void beat(), SUPERVISOR_POLL_MS * 4);
  const cleanup = async (): Promise<void> => {
    clearInterval(beatTimer);
    try {
      await rm(beatFile, { force: true });
    } catch {
      // Stale file ages out of the liveness count on its own.
    }
  };

  try {

    for (;;) {
      const limit = maxConcurrentRuns(deps.holder.state.config);
      if (limit === 0) return;

      // Exit at once if the jobs root has gone. A per-job runner died with its
      // job, so a deleted jobs directory could never strand one; a pooled
      // supervisor outlives individual jobs and would otherwise sit polling a
      // path that no longer exists — spinning in the field, and in tests
      // interfering with whatever creates the next jobs root.
      if (!existsSync(jobsRoot())) return;

      if (inflight.size < jobsPerSupervisor(limit)) {
        // Promote waiting jobs into released ones first. The old per-job
        // runner called drainSlotQueue as it exited, which is what kept the
        // queue moving; a pooled supervisor outlives individual jobs, so it
        // has to do the same thing on every pass or a slot freed by a job it
        // just finished never reaches the next job in line.
        try {
          await drainSlotQueue(deps.holder.state.config, deps.holder.state.configPath);
        } catch {
          // Next pass retries; a drain failure must not kill the supervisor.
        }
        const jobDir = await claimNextJob();
        if (jobDir !== undefined) {
          idleSince = Date.now();
          const run = executeJobDir(deps, jobDir)
            .catch(() => undefined)
            .finally(() => inflight.delete(run));
          inflight.add(run);
          continue; // Try to fill the remaining slots before waiting.
        }
      }

      if (inflight.size === 0) {
        if (Date.now() - idleSince > SUPERVISOR_IDLE_EXIT_MS) return;
        await new Promise((r) => setTimeout(r, SUPERVISOR_POLL_MS));
        continue;
      }
      idleSince = Date.now();
      await Promise.race([...inflight, new Promise((r) => setTimeout(r, SUPERVISOR_POLL_MS))]);
    }
  } finally {
    await cleanup();
  }
}

/**
 * Start slot-queued jobs, oldest first, until the machine is at its limit.
 *
 * Deliberately has no daemon behind it: this runs on every new dispatch and
 * again as each runner exits, which between them covers every moment a slot
 * can free. The cost of that choice is that if every runner dies while jobs
 * are queued, the queue resumes on the next dispatch rather than immediately.
 * Bounded waiting was the explicit alternative and was not chosen — a queued
 * job keeps its jobId and its artifacts either way, so nothing is lost.
 */
export async function drainSlotQueue(
  config: RouterConfig | undefined,
  configPath: string | undefined,
): Promise<void> {
  const limit = maxConcurrentRuns(config);
  if (limit === 0) return;
  const runnerPath = resolveRunnerPath();
  if (runnerPath === undefined) return;

  // ONE drainer at a time, across processes. The body below is a
  // read-count-release: two drainers (every dispatch AND every runner exit
  // calls this) whose reads interleaved with each other's releases could
  // each release a job at active = limit-1 and exceed the cap — the cap that
  // exists because of a measured OOM. The FIFO comment below also assumes a
  // single drainer decides the order; this is what enforces that assumption.
  let releaseDrainLock: (() => void) | undefined;
  try {
    releaseDrainLock = await acquireWorkspaceLock(
      path.join(jobsRoot(), ".slot-drain"),
      DRAIN_LOCK_TIMEOUT_MS,
    );
  } catch {
    // Another process is mid-drain and sees the same queue; this call's
    // trigger is covered by that drain or by the next one (every dispatch and
    // every runner exit re-runs this), so skipping is safe — waiting is not
    // worth blocking a dispatch for.
    return;
  }
  try {
    await drainSlotQueueLocked(limit, runnerPath, configPath);
  } finally {
    releaseDrainLock();
  }
}

/** How long a drain waits for a concurrent drainer before ceding to it. */
const DRAIN_LOCK_TIMEOUT_MS = 5_000;

async function drainSlotQueueLocked(
  limit: number,
  runnerPath: string,
  configPath: string | undefined,
): Promise<void> {
  const statuses = await readJobStatuses();
  let active = countActiveRuns(statuses);
  const waiting = statuses.filter((s) => s.status.slotQueued);

  // Release stays HERE, synchronously and oldest-first, even though a
  // supervisor is what will actually run the job. Two reasons: the caller's
  // returned status must still distinguish "got a slot" from "waiting", which
  // it cannot if clearing the flag is deferred to whichever supervisor wakes
  // first; and FIFO across concurrent dispatches is only guaranteed while one
  // drainer decides the order. Supervisors then pick up released work.
  let released = 0;
  for (const { jobDir, status } of waiting) {
    if (active >= limit) break;
    const { slotQueued: _dropped, ...cleared } = status;
    await updateStatus(jobDir, {
      ...cleared,
      updatedAt: timestamp(),
      instructions: pollInstructions(status.jobId),
    });
    active += 1;
    released += 1;
  }
  if (released === 0) return;

  // Size the pool against ALL outstanding work, not just the jobs released on
  // this call. Dispatches arrive one at a time, so `released` is usually 1;
  // sizing on that gave a single supervisor for twelve jobs, which then ran
  // them three at a time because each supervisor takes only
  // jobsPerSupervisor(limit). The cap must come from the pool size, never from
  // how the work happened to arrive.
  const outstanding = active;
  const wanted = Math.min(SUPERVISOR_POOL_SIZE, Math.ceil(outstanding / jobsPerSupervisor(limit)));
  const running = await countLiveSupervisors();
  for (let i = running; i < wanted; i += 1) {
    spawnDetachedSupervisor(runnerPath, configPath);
  }
}

/**
 * Supervisors currently alive, counted from their heartbeat files.
 *
 * Approximate on purpose: over-counting briefly means the pool runs one short
 * until the next drain, and under-counting means one extra supervisor that
 * finds no work and exits within SUPERVISOR_IDLE_EXIT_MS. Neither warrants a
 * lock, and both self-correct.
 */
async function countLiveSupervisors(): Promise<number> {
  const dir = path.join(jobsRoot(), ".supervisors");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let live = 0;
  for (const entry of entries) {
    try {
      const beat = await readFile(path.join(dir, entry), "utf8");
      if (Date.now() - Date.parse(beat) <= ORPHAN_THRESHOLD_MS) live += 1;
    } catch {
      // Vanished mid-read: it is not live.
    }
  }
  return live;
}

/**
 * Start one detached supervisor; it finds its own work.
 *
 * Output goes to a log beside the heartbeats, for the same reason the per-job
 * runner logged to its job dir: a supervisor that dies during bootstrap (bad
 * config, missing module) is otherwise completely silent, and the only symptom
 * is jobs that never start.
 */
function spawnDetachedSupervisor(runnerPath: string, configPath: string | undefined): void {
  const dir = path.join(jobsRoot(), ".supervisors");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Register the slot HERE, before spawning, and hand the id to the child.
  //
  // Letting the supervisor write its own first heartbeat looks tidier and does
  // not work: booting a Node process takes a few hundred ms, so a burst of
  // dispatches all counted zero live supervisors and each spawned another.
  // Measured at 12 concurrent jobs: 12 supervisors, 748 MB — the pool capping
  // nothing at all. The parent claiming the slot synchronously is what makes
  // the cap real.
  writeFileSync(path.join(dir, `${id}.txt`), timestamp(), { encoding: "utf8", mode: 0o600 });

  const logFd = openSync(path.join(dir, `spawn-${id}.log`), "a");
  try {
    const child = spawn(process.execPath, [runnerPath, "--supervisor", id], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        ...(configPath !== undefined ? { HARNESS_DISPATCH_CONFIG: configPath } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function spawnDetachedRunner(runnerPath: string, jobDir: string, configPath: string | undefined): void {
  // The runner's own stdout/stderr go to a log inside the job dir so a
  // bootstrap crash (bad config, missing module) leaves evidence.
  const logFd = openSync(path.join(jobDir, "output", "runner.log"), "a");
  try {
    const child = spawn(process.execPath, [runnerPath, jobDir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        ...(configPath !== undefined ? { HARNESS_DISPATCH_CONFIG: configPath } : {}),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}



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




const MAX_PARTIAL_OUTPUT_CHARS = 4000;

export async function getAsyncJob(jobId: string): Promise<{
  manifest: JobManifest;
  status: JobStatus;
  result?: JobResultPayload;
  /** Tail of live stdout/stderr while the job is still running. */
  partialOutput?: string;
}> {
  assertValidJobId(jobId);
  const jobDir = path.join(jobsRoot(), jobId);
  // A well-formed id for a job that is gone is the ORDINARY case, not an
  // internal error: retention prunes finished jobs, so any caller holding an
  // id long enough will hit this. It used to surface as a raw Node ENOENT
  // quoting an absolute path inside the jobs directory, which tells the caller
  // nothing actionable and leaks the layout.
  const noSuchJob = () =>
    new Error(
      `No such job: ${jobId}. It may have been pruned by the retention window, ` +
        `or it was never started on this machine.`,
    );
  if (!existsSync(path.join(jobDir, "manifest.json"))) throw noSuchJob();
  let manifest: JobManifest;
  let status: JobStatus;
  let result: JobResultPayload | undefined;
  try {
    manifest = await readJson<JobManifest>(path.join(jobDir, "manifest.json"));
    status = withOrphanCheck(await readJson<JobStatus>(path.join(jobDir, "status.json")));
    const resultPath = path.join(jobDir, "output", "result.json");
    result = existsSync(resultPath) ? await readJson<JobResultPayload>(resultPath) : undefined;
  } catch (err) {
    // existsSync-then-read is a TOCTOU window: retention pruning can delete
    // the directory between the two calls, resurfacing the exact raw-ENOENT-
    // with-an-absolute-path error this function's message exists to replace.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw noSuchJob();
    throw err;
  }
  if (result !== undefined) {
    return { manifest, status, result };
  }
  if (status.status === "orphaned") {
    // Terminal: no poll guidance — polling will never resolve this job.
    return { manifest, status };
  }

  const out: { manifest: JobManifest; status: JobStatus; partialOutput?: string } = {
    manifest,
    status: {
      ...status,
      nextPollSeconds: SUGGESTED_POLL_SECONDS,
      instructions: pollInstructions(jobId),
    },
  };
  const partialPath = path.join(jobDir, "output", "stdout.partial.log");
  if (existsSync(partialPath)) {
    try {
      const partial = await readFile(partialPath, "utf8");
      out.partialOutput =
        partial.length <= MAX_PARTIAL_OUTPUT_CHARS
          ? partial
          : `… [${partial.length - MAX_PARTIAL_OUTPUT_CHARS} chars omitted] …` +
            partial.slice(-MAX_PARTIAL_OUTPUT_CHARS);
    } catch {
      // Best-effort; absence of partial output isn't an error.
    }
  }
  return out;
}

export async function listAsyncJobs(): Promise<JobStatus[]> {
  const root = jobsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const statuses: JobStatus[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      statuses.push(
        withOrphanCheck(await readJson<JobStatus>(path.join(root, entry.name, "status.json"))),
      );
    } catch {
      // Ignore incomplete or manually edited job directories.
    }
  }
  return statuses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
