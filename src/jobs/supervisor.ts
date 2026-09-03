/**
 * Admission control and the supervisor pool: who runs, when, and in which
 * process.
 *
 * The concurrency cap here exists because of a measured OOM, and the pool
 * exists because a runner process per job costs ~76 MB of wrapper. Both are
 * load-bearing; see the comments on DEFAULT_MAX_CONCURRENT_RUNS.
 */

import { spawn } from "node:child_process";
import { executeJobDir, resolveRunnerPath } from "./run.js";
import { listAsyncJobs } from "./read.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { ConfigHotReloader } from "../mcp/config-hot-reload.js";
import type { RouterConfig } from "../types.js";
import { acquireWorkspaceLock } from "../workspace-lock.js";
import {
  cancelRequested,
  jobsRoot,
  ORPHAN_THRESHOLD_MS,
  pollInstructions,
  readJson,
  timestamp,
  updateStatus,
} from "./store.js";
import type { JobDeps, JobStatus } from "./types.js";
/**
 * Default ceiling on agent CLIs running at once, machine-wide.
 *
 * 4 is a resource guard, not a throughput target. Measured 2026-08-03: 20
 * dispatches to one route, 13 running concurrently, 10 of the 20 failing, one
 * killed outright by a Rust OOM inside Codex. Agent CLIs each carry a model
 * runtime; the binding constraint is memory, not cores, so this does NOT
 * scale with CPU count. Override with `max_concurrent_runs:` in config.yaml.
 *
 * `0` does more than lift the cap: it takes the whole slot queue and
 * supervisor pool out of the path, so every job gets its own detached runner
 * process. Measured under load: 8 concurrent dispatches became 8 runner
 * processes at ~76 MB each, which is the per-job wrapper cost the pool was
 * introduced to remove. That is the opposite of harmless on the memory-bound
 * machine this cap exists for, so `0` is for a machine with room to spare and
 * a reason, not a way to "turn off a limit". Routing the unbounded case
 * through the pool instead would be better and is not done here: the pool
 * sizes itself by dividing the limit, so an infinite one provisions zero
 * supervisors, and getting that right needs its own load run rather than a
 * guess.
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** A CLI harness is a whole agent process; an endpoint call is one HTTP request. */
const DEFAULT_CLI_WEIGHT = 1.0;
const DEFAULT_ENDPOINT_WEIGHT = 0.1;

/**
 * The cap, or `null` for "no cap".
 *
 * `null` rather than `0`, and rather than `Infinity`, because both of those
 * were wrong in a way that mattered. `0` used to short-circuit the whole slot
 * queue and supervisor pool, so `max_concurrent_runs: 0` — documented as
 * lifting a limit — silently gave every job its own runner process at ~76 MB,
 * which is the per-job cost the pool exists to remove, on the memory-bound
 * machine the cap exists for. And `Infinity` divides badly: the pool sizes
 * itself with `outstanding / jobsPerSupervisor(limit)`, so an infinite limit
 * asked for ZERO supervisors. An explicit `null` makes each site say what it
 * means about the unbounded case.
 */
export function maxConcurrentRuns(config: RouterConfig | undefined): number | null {
  const configured = config?.maxConcurrentRuns;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return configured === 0 ? null : configured;
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
/**
 * What one run of a route costs against the concurrency budget.
 *
 * Unknown routes count as a full 1.0 on purpose. A job that has not been
 * routed yet (no forced `service`) has no weight to look up, and this bound
 * exists because a measured burst of 13 concurrent CLIs exhausted memory —
 * so the safe assumption for "might be anything" is "might be heavy".
 */
export function resourceWeightFor(status: JobStatus, config: RouterConfig | undefined): number {
  const routeId = status.route ?? status.service;
  const svc = routeId !== undefined ? config?.services?.[routeId] : undefined;
  if (svc?.resourceWeight !== undefined && Number.isFinite(svc.resourceWeight) && svc.resourceWeight >= 0) {
    return svc.resourceWeight;
  }
  if (svc?.type === "openai_compatible") return DEFAULT_ENDPOINT_WEIGHT;
  return DEFAULT_CLI_WEIGHT;
}

/** In-flight jobs, counted. Used for supervisor pool sizing, not for the budget. */
function countActiveJobs(statuses: Array<{ status: JobStatus }>): number {
  let n = 0;
  for (const { status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "running" && status.status !== "queued") continue;
    const beat = Date.parse(status.updatedAt);
    if (Number.isFinite(beat) && Date.now() - beat > ORPHAN_THRESHOLD_MS) continue;
    n += 1;
  }
  return n;
}

/**
 * Capacity currently in use, as a weighted sum rather than a job count.
 *
 * With every weight at 1.0 this is exactly the old count, so an existing
 * `max_concurrent_runs` keeps its previous meaning.
 */
export function activeCapacity(
  statuses: Array<{ status: JobStatus }>,
  config: RouterConfig | undefined,
): number {
  let active = 0;
  for (const { status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "running" && status.status !== "queued") continue;
    const beat = Date.parse(status.updatedAt);
    if (Number.isFinite(beat) && Date.now() - beat > ORPHAN_THRESHOLD_MS) continue;
    active += resourceWeightFor(status, config);
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

/**
 * Jobs one supervisor may run at once, so the pool can reach the global limit.
 *
 * Uncapped, a supervisor takes whatever it can claim: the pool size is then
 * the only bound, which is the point — processes stay bounded even when jobs
 * do not.
 */
function jobsPerSupervisor(limit: number | null): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
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
    // Cancelled before a supervisor ever picked it up: claiming it would
    // start work someone has already asked not to happen.
    if (cancelRequested(jobDir)) continue;
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
  // Static now. This was a runtime import to dodge a cycle: config-hot-reload
  // imported setJobRetentionDays from THIS file rather than from
  // jobs/store.ts, where it is defined. Pointing that import at the
  // definition removed the cycle, so the workaround went with it.
  const reloader = new ConfigHotReloader(deps.holder, deps.holder.state.configPath);

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

      // Exit at once if the jobs root has gone. A per-job runner died with its
      // job, so a deleted jobs directory could never strand one; a pooled
      // supervisor outlives individual jobs and would otherwise sit polling a
      // path that no longer exists — spinning in the field, and in tests
      // interfering with whatever creates the next jobs root.
      if (!existsSync(jobsRoot())) return;

      if (inflight.size < jobsPerSupervisor(limit)) {
        // Pick up config edits before claiming anything.
        //
        // A supervisor OUTLIVES the server that spawned it, by design and by
        // up to SUPERVISOR_IDLE_EXIT_MS. Without this it also outlived the
        // server's CONFIG: restart with a route removed and dispatch inside
        // that window, and the old supervisor claimed the job and ran the
        // removed route, reporting plain success. `disabled:`,
        // `allow_paid_usage` and safety profiles are meant to be controls, and
        // for those few seconds they were not — against this product's own
        // "never spend money silently".
        //
        // maybeReload is mtime-gated, so the steady-state cost is one stat per
        // poll, and it keeps the old state when an edit is malformed.
        await reloader.maybeReload();

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
 *
 * NOT called at server start, which was tried and reverted: it silently ran
 * jobs abandoned by a dead session. `orphanStrandedSlotQueue` runs there
 * instead and reports them. See its comment for why reporting beats resuming.
 */
/**
 * Mark jobs stranded in the slot queue by a server that is gone.
 *
 * Called once at server start, where the reasoning holds unconditionally: this
 * process has not queued anything yet, so anything still slot-queued was
 * queued by a session that no longer exists and nothing will ever drain it —
 * a new dispatch would, but the caller is asking about THIS job, and until
 * they happen to send unrelated work it reads `queued` forever.
 *
 * Deliberately reports rather than runs. Resuming was tried and is worse: a
 * job queued days ago would execute at the next server start, in its original
 * workingDir, at up to `full_auto`, with nobody watching. The job keeps its id
 * and artifacts, so `retry_job` re-runs it as a decision rather than a side
 * effect of opening an editor.
 *
 * The one status this writes back. Orphan detection elsewhere is
 * compute-on-read and never persists its verdict, because the owner might
 * still be alive; here the owner is definitionally gone.
 */
export async function orphanStrandedSlotQueue(): Promise<number> {
  // Only when nothing is left to work the queue.
  //
  // The first version of this reasoned "a server is starting, so anything
  // already slot-queued belongs to a session that is gone". That is false in
  // the configuration this product ships by default: `connect` registers with
  // Claude Code AND Cursor, and `serve` is a third — several servers routinely
  // share one jobs root. An acceptance pass measured the consequence: with
  // server A alive and holding a legitimately queued job, starting server B
  // marked that job orphaned within about a second, and because orphaning
  // clears `slotQueued` the drainer then skipped it forever. Live work,
  // killed, with an error stating a cause that was not true.
  //
  // A supervisor heartbeat answers the question the comment was guessing at.
  // If any supervisor is alive, the queue is being worked and nothing is
  // stranded — a waiting job is waiting, which is what
  // `ux-walkthrough.md` promises it stays.
  if ((await countLiveSupervisors()) > 0) return 0;
  const jobs = await listAsyncJobs().catch(() => []);
  let marked = 0;
  for (const status of jobs) {
    if (status.slotQueued !== true) continue;
    const { slotQueued: _cleared, ...rest } = status;
    await updateStatus(status.jobDir, {
      ...rest,
      status: "orphaned",
      updatedAt: timestamp(),
      success: false,
      error:
        "This job was still waiting for a concurrency slot when the dispatch server " +
        "exited, so it never started. It is NOT resumed automatically — re-running " +
        "an abandoned job unattended, in its original working directory, is not " +
        "something a server restart should decide. Use retry_job to run it.",
    }).catch(() => undefined);
    marked += 1;
  }
  return marked;
}

export async function drainSlotQueue(
  config: RouterConfig | undefined,
  configPath: string | undefined,
): Promise<void> {
  const limit = maxConcurrentRuns(config);
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
    await drainSlotQueueLocked(limit, runnerPath, configPath, config);
  } finally {
    releaseDrainLock();
  }
}

/** How long a drain waits for a concurrent drainer before ceding to it. */
const DRAIN_LOCK_TIMEOUT_MS = 5_000;

async function drainSlotQueueLocked(
  limit: number | null,
  runnerPath: string,
  configPath: string | undefined,
  config: RouterConfig | undefined,
): Promise<void> {
  const statuses = await readJobStatuses();
  let active = activeCapacity(statuses, config);
  // Supervisors are sized by how many JOBS there are, not by how much budget
  // they consume. Once `active` became a weighted sum these had to part
  // company: ten endpoint calls are 1.0 of capacity but still ten jobs, and
  // sizing the pool off the weight would hand all ten to one supervisor that
  // runs them a few at a time.
  let activeJobs = countActiveJobs(statuses);
  const waiting = statuses.filter((s) => s.status.slotQueued);

  // Release stays HERE, synchronously and oldest-first, even though a
  // supervisor is what will actually run the job. Two reasons: the caller's
  // returned status must still distinguish "got a slot" from "waiting", which
  // it cannot if clearing the flag is deferred to whichever supervisor wakes
  // first; and FIFO across concurrent dispatches is only guaranteed while one
  // drainer decides the order. Supervisors then pick up released work.
  let released = 0;
  for (const { jobDir, status } of waiting) {
    const weight = resourceWeightFor(status, config);
    // The `active > 0` guard prevents a deadlock the plain count could not
    // produce: a single job heavier than the whole budget (weight 1.0 against
    // a capacity of 0.5) would otherwise wait forever for room that can never
    // exist. When nothing is running, the next job always goes — the same
    // reasoning as the earlier fix for a job whose own queued status counted
    // against its own admission.
    if (limit !== null && active > 0 && active + weight > limit) break;
    const { slotQueued: _dropped, ...cleared } = status;
    await updateStatus(jobDir, {
      ...cleared,
      updatedAt: timestamp(),
      instructions: pollInstructions(status.jobId),
    });
    active += weight;
    activeJobs += 1;
    released += 1;
  }
  if (released === 0) return;

  // Size the pool against ALL outstanding work, not just the jobs released on
  // this call. Dispatches arrive one at a time, so `released` is usually 1;
  // sizing on that gave a single supervisor for twelve jobs, which then ran
  // them three at a time because each supervisor takes only
  // jobsPerSupervisor(limit). The cap must come from the pool size, never from
  // how the work happened to arrive.
  const outstanding = activeJobs;
  const wanted =
    limit === null
      ? Math.min(SUPERVISOR_POOL_SIZE, outstanding)
      : Math.min(SUPERVISOR_POOL_SIZE, Math.ceil(outstanding / jobsPerSupervisor(limit)));
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
    // Heartbeats only. This directory also holds `spawn-<id>.log`, the
    // bootstrap output of each supervisor — and those exist precisely to
    // explain a supervisor that DIED, which is the same supervisor that left
    // a stale heartbeat. A sweep that treated every file as a heartbeat would
    // delete the diagnostic for the failure it was cleaning up after.
    // Counting was already ignoring them only by accident: a log body does
    // not Date.parse, so it read as not-live.
    if (!entry.endsWith(".txt")) continue;
    try {
      const beat = await readFile(path.join(dir, entry), "utf8");
      if (Date.now() - Date.parse(beat) <= ORPHAN_THRESHOLD_MS) {
        live += 1;
        continue;
      }
      // Dead: remove it rather than only declining to count it.
      //
      // A supervisor that exits cleanly deletes its own file; one that is
      // KILLED cannot, so its heartbeat stopped being counted but stayed on
      // disk forever — and this loop reads every file in the directory on
      // every drain, so the cost of each hard kill was permanent and paid by
      // every dispatch afterwards. Safe to delete: the file is already past
      // the staleness threshold, and a supervisor that somehow revives simply
      // writes it again on its next beat.
      await rm(path.join(dir, entry), { force: true });
    } catch {
      // Vanished mid-read, or another drain removed it first: not live, and
      // nothing here needs to succeed for the count to be usable.
    }
  }
  return live;
}

/**
 * Exported for the cleanup test, which must exercise the REAL sweep rather
 * than a copy of its logic — the bug being pinned is that a stale heartbeat
 * was never removed, and a reimplementation in the test would pin nothing.
 */
export const countLiveSupervisorsForTest = countLiveSupervisors;

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

export function spawnDetachedRunner(runnerPath: string, jobDir: string, configPath: string | undefined): void {
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


/**
 * Why a detached runner would fail to bootstrap from this config path, if it
 * would. `undefined` means the file loads (or there is none, which is the
 * auto-detect case and always fine).
 *
 * Deliberately re-reads rather than trusting the server's in-memory config:
 * the two disagreeing is exactly the condition being detected.
 */
export async function configLoadError(configPath: string | undefined): Promise<string | undefined> {
  if (configPath === undefined) return undefined;
  try {
    await loadConfig(configPath);
    return undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return (
      `cannot start a background run: ${configPath} no longer loads, so the detached ` +
      `runner this dispatch needs cannot start — ${detail}. This server is still using the ` +
      `last config that loaded cleanly, which is why it accepted the request at all. Fix the ` +
      `file (harness-dispatch doctor --config "${configPath}" reports the problem) and retry.`
    );
  }
}
