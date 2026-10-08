/**
 * Admission control and the supervisor pool: who runs, when, and in which
 * process. The concurrency cap bounds memory, and the pool exists because a
 * runner process per job costs ~76 MB of wrapper.
 */

import { executeJobDir, resolveRunnerPath } from "./run.js";
import { fallbackWarning, launchDetached } from "./detach.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { ConfigHotReloader } from "../mcp/config-hot-reload.js";
import type { RouterConfig } from "../types.js";
import { acquireWorkspaceLock } from "../workspace-lock.js";
import { staleCodeWarning } from "../status.js";
import {
  cancelRequested,
  claimHolder,
  clearPending,
  JOB_ID_RE,
  mapBounded,
  markPending,
  mayHavePendingJobs,
  newerFormatError,
  pendingIndexDir,
  jobMaxAgeMs,
  jobsRoot,
  ORPHAN_THRESHOLD_MS,
  pollInstructions,
  suggestedPollSeconds,
  processAlive,
  readJson,
  timestamp,
  updateStatus,
} from "./store.js";
import type { JobDeps, JobStatus } from "./types.js";
/**
 * Default ceiling on agent CLIs running at once, machine-wide.
 *
 * 4 is a resource guard, not a throughput target: 13 agent CLIs running
 * concurrently exhausts memory, one killed outright by a Rust OOM inside
 * Codex. Each carries a model runtime, so the binding constraint is memory,
 * not cores, and this does NOT scale with CPU count. Override with
 * `max_concurrent_runs:` in config.yaml.
 *
 * `0` lifts the cap without leaving the pool, and the uncapped case sizes the
 * pool by outstanding work rather than by dividing the limit. Jobs are
 * unbounded; runner processes are not.
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** A CLI harness is a whole agent process; an endpoint call is one HTTP request. */
const DEFAULT_CLI_WEIGHT = 1.0;
const DEFAULT_ENDPOINT_WEIGHT = 0.1;

/**
 * The cap, or `null` for "no cap".
 *
 * `null` rather than `0` or `Infinity`: `0` invites short-circuiting the pool,
 * and `Infinity` divides badly — the pool sizes itself with `outstanding /
 * jobsPerSupervisor(limit)`, so an infinite limit asks for ZERO supervisors.
 * An explicit `null` makes each site say what it means about the unbounded
 * case.
 */
export function maxConcurrentRuns(config: RouterConfig | undefined): number | null {
  const configured = config?.maxConcurrentRuns;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return configured === 0 ? null : configured;
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

/** Job dirs, oldest first by name — jobIds embed Date.now(), so name order is start order. */
export async function readJobStatuses(): Promise<Array<{ jobDir: string; status: JobStatus }>> {
  const root = jobsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && JOB_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(root, name));
  const read = await mapBounded(dirs, async (jobDir) => {
    try {
      return { jobDir, status: await readJson<JobStatus>(path.join(jobDir, "status.json")) };
    } catch {
      return undefined; // Half-written or pruned mid-scan — not a live run either way.
    }
  });
  return read.filter((r): r is { jobDir: string; status: JobStatus } => r !== undefined);
}

/**
 * What one run of a route costs against the concurrency budget.
 *
 * Unknown routes count as a full 1.0: a job not yet routed has no weight to
 * look up, and the budget bounds memory, so "might be anything" has to mean
 * "might be heavy".
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
 * With every weight at 1.0 this is exactly a job count, so a plain
 * `max_concurrent_runs` means what it reads as.
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


/**
 * How many supervisor PROCESSES may exist, regardless of how many jobs run.
 *
 * A Node process per job is expensive wrapper: on Windows with Node 24, a bare
 * node process is 52 MB RSS and one that has bootstrapped a runtime is 65 MB,
 * against ~54 MB for the agent CLI it supervises — 845 MB of supervision at 13
 * concurrent jobs. A supervisor is almost entirely idle, so one can watch
 * several at once for the cost of async I/O, making wrapper memory O(1) in the
 * number of jobs and capping it at ~260 MB.
 *
 * Four rather than one purely to bound blast radius: a supervisor crash
 * strands only the jobs it held, and those are recoverable anyway — the job
 * directory is the source of truth and the heartbeat check marks stranded jobs
 * orphaned.
 */
export const SUPERVISOR_POOL_SIZE = 4;

/** Poll interval while a supervisor waits for claimable work. */
const SUPERVISOR_POLL_MS = 250;

/** How long a supervisor stays alive with nothing to do before exiting. */
const SUPERVISOR_IDLE_EXIT_MS = 5_000;

/**
 * Jobs one supervisor may run at once, so the pool can reach the global limit.
 * Uncapped, a supervisor takes whatever it can claim and the pool size is the
 * only bound — processes stay bounded even when jobs do not.
 */
function jobsPerSupervisor(limit: number | null): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(limit / SUPERVISOR_POOL_SIZE));
}

/**
 * Take exclusive ownership of a job directory.
 *
 * `wx` fails if the file exists, atomically, on both Windows and POSIX — which
 * is what stops two supervisors racing onto the same job. A claim left by a
 * crashed supervisor is reclaimed once that job's heartbeat has gone stale, by
 * the same ORPHAN_THRESHOLD_MS rule used everywhere else.
 *
 * Exported for tests: the one-winner property under concurrent reclaim is only
 * checkable by calling this directly.
 */
export async function claimJobDir(jobDir: string, status: JobStatus): Promise<boolean> {
  const claimPath = path.join(jobDir, "claim.json");
  try {
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, at: timestamp() }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await clearPending(path.basename(jobDir));
    return true;
  } catch {
    const beat = Date.parse(status.updatedAt);
    if (!Number.isFinite(beat) || Date.now() - beat <= ORPHAN_THRESHOLD_MS) return false;
    // The job's heartbeat is stale, but that is the RELEASE time for a job not
    // yet running — so any released job older than 90 s let a second
    // supervisor steal a claim made a moment ago, and both ran it. A claim
    // whose holder is alive is not stale, however old the job.
    const holder = claimHolder(jobDir);
    if (holder !== undefined && processAlive(holder)) return false;
    // Reclaiming a crashed supervisor's claim must pick exactly ONE winner, or
    // two supervisors deciding "stale" in the same window both run the job —
    // a duplicate CLI execution billed twice. Renaming the stale claim aside
    // is atomic: the loser gets ENOENT, and the winner still has to win the
    // `wx` create below like any first claimant.
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
      await clearPending(path.basename(jobDir));
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
 * slotQueued; it waits for a supervisor rather than for capacity. A job still
 * slotQueued is NOT claimable here — that would let a supervisor jump the FIFO
 * order the drainer enforces.
 */
async function claimNextJob(): Promise<string | undefined> {
  if (!(await mayHavePendingJobs())) return undefined;
  const statuses = await readJobStatuses();
  for (const { jobDir, status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "queued") continue;
    // A job a newer build wrote may mean something this code does not know.
    if (newerFormatError(status, status.jobId) !== undefined) continue;
    // Claiming a cancelled job would start work someone already asked to stop.
    // Checked before the claim, so a cancel landing between the two still
    // gets claimed; runJob's first cancel poll (1 s) then stops it.
    if (cancelRequested(jobDir)) continue;
    if (!(await claimJobDir(jobDir, status))) continue;
    return jobDir;
  }
  return undefined;
}

/**
 * Supervisor main loop: claim work, run several jobs at once, exit when idle.
 *
 * Exiting on idle keeps the no-jobs steady state at zero processes — the pool
 * is a way to share supervision cost while work exists, not a daemon.
 */
export async function runSupervisor(deps: JobDeps, supervisorId?: string): Promise<void> {
  const inflight = new Set<Promise<unknown>>();
  let idleSince = Date.now();
  const reloader = new ConfigHotReloader(deps.holder, deps.holder.state.configPath);

  // Heartbeat so drainSlotQueue can tell how many supervisors already exist
  // and avoid piling on. Same staleness rule as jobs, so a killed supervisor
  // stops being counted without anything having to clean up after it. The file
  // the spawning process already created for this slot is adopted, so the slot
  // is accounted for continuously rather than disappearing between the
  // parent's registration and the child's first beat.
  const beatDir = path.join(jobsRoot(), ".supervisors");
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

  // Set once the installed build is newer than this process's code.
  let outdated = false;
  try {

    for (;;) {
      const limit = maxConcurrentRuns(deps.holder.state.config);

      // A supervisor outlives individual jobs, so a deleted jobs root would
      // otherwise leave it polling a path that no longer exists. Claim nothing
      // more, but let runs already going finish: returning here exits the
      // process, which on Windows kills their agent CLIs mid-edit.
      if (!existsSync(jobsRoot())) {
        await Promise.allSettled(inflight);
        return;
      }

      // A supervisor outlives the server that started it, and keeps claiming
      // while work keeps arriving — so after an upgrade, jobs a NEW server
      // submitted ran on this OLD code, for as long as it stayed busy
      // (observed comparing two installs). Once the build on disk is newer,
      // claim nothing more, finish what is running, and hand over to a
      // supervisor started from the new build.
      outdated ||= staleCodeWarning() !== undefined;

      if (!outdated && inflight.size < jobsPerSupervisor(limit)) {
        // Pick up config edits before claiming anything. A supervisor outlives
        // the server that spawned it by up to SUPERVISOR_IDLE_EXIT_MS, and
        // without this it also outlives its CONFIG: restart with a route
        // removed, dispatch inside that window, and the old supervisor runs
        // the removed route and reports success. `disabled:`,
        // `allow_paid_usage` and safety profiles are controls, and for those
        // few seconds they would not be.
        //
        // maybeReload is mtime-gated, so the steady-state cost is one stat per
        // poll, and it keeps the old state when an edit is malformed.
        await reloader.maybeReload();

        // Promote waiting jobs into released ones first. A supervisor
        // outlives individual jobs, so it has to drain on every pass or a slot
        // freed by a job it just finished never reaches the next job in line.
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
        if (outdated) {
          // The runner path is the installed one, so this starts the new
          // build. If there is no work it finds none and exits when idle.
          const runnerPath = resolveRunnerPath();
          if (runnerPath !== undefined) await spawnDetachedSupervisor(runnerPath, deps.holder.state.configPath);
          return;
        }
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
 * Mark jobs stranded in the slot queue by a server that is gone.
 *
 * Called once at server start: this process has queued nothing yet, so a job
 * still slot-queued was queued by a session that no longer exists and reads
 * `queued` forever until some unrelated dispatch happens to drain it.
 *
 * Deliberately reports rather than runs. Resuming is worse: a job queued days
 * ago would execute at the next server start, in its original workingDir, at
 * up to `full_auto`, with nobody watching. The job keeps its id and artifacts,
 * so `retry_job` re-runs it as a decision rather than a side effect.
 *
 * Orphan detection elsewhere (checkOrphan) writes its verdict only for a
 * `running` job whose claimant is gone, because the owner might still be
 * alive; here the owner is definitionally gone.
 */
/**
 * Still waiting for a slot, as the job's status file says NOW.
 *
 * The drainer and the orphan sweep act on a list read earlier, and a cancel,
 * another server's drain or another server's sweep can change a job in
 * between. Writing back the earlier copy undid that change: a cancelled job
 * came back as `queued`, and a job another server had just released was
 * marked orphaned and never ran. Read again right before writing, the window
 * is the gap between one read and one write.
 */
async function stillWaiting(jobDir: string): Promise<JobStatus | undefined> {
  const now = await readJson<JobStatus>(path.join(jobDir, "status.json")).catch(() => undefined);
  // Not released or written back by this build if a newer one wrote it:
  // rewriting it would stamp it with this build's older format.
  if (now !== undefined && newerFormatError(now, now.jobId) !== undefined) return undefined;
  return now?.slotQueued === true && now.status === "queued" ? now : undefined;
}

export async function orphanStrandedSlotQueue(): Promise<number> {
  // Only when nothing is left to work the queue. Several servers routinely
  // share one jobs root (`connect` registers with Claude Code AND Cursor, and
  // `serve` is a third), so "a server is starting" alone does not mean the
  // queue's owner is gone: starting server B would orphan server A's
  // legitimate queued job, and orphaning clears `slotQueued`, so the drainer
  // would then skip it forever. A live supervisor heartbeat means the queue is
  // being worked and nothing is stranded.
  if ((await countLiveSupervisors()) > 0) return 0;
  const jobs = await readJobStatuses().catch(() => []);
  let marked = 0;
  for (const listed of jobs) {
    if (listed.status.slotQueued !== true) continue;
    const status = await stillWaiting(listed.jobDir);
    if (status === undefined) continue;
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

/**
 * Start slot-queued jobs, oldest first, until the machine is at its limit.
 *
 * No daemon behind it: this runs on every new dispatch and again as each
 * runner exits, which between them covers every moment a slot can free. The
 * cost is that if every runner dies while jobs are queued, the queue resumes
 * on the next dispatch rather than immediately.
 *
 * NOT called at server start: that would silently run jobs abandoned by a dead
 * session. `orphanStrandedSlotQueue` runs there instead and reports them.
 *
 * Returns a warning when a supervisor it started only came up through the
 * plain-spawn fallback (see detach.ts): the dispatch that triggered the drain
 * passes it on, since that job may not survive its session.
 */
export async function drainSlotQueue(
  config: RouterConfig | undefined,
  configPath: string | undefined,
): Promise<string | undefined> {
  const limit = maxConcurrentRuns(config);
  const runnerPath = resolveRunnerPath();
  if (runnerPath === undefined) return undefined;
  // Nothing waiting and nothing released-but-unclaimed: no scan, no lock.
  if (!(await mayHavePendingJobs())) return undefined;

  // ONE drainer at a time, across processes. The body below is a
  // read-count-release, so two drainers whose reads interleave with each
  // other's releases could each release a job at active = limit-1 and exceed
  // the memory cap. The FIFO ordering below also assumes a single drainer.
  let releaseDrainLock: (() => void) | undefined;
  try {
    releaseDrainLock = await acquireWorkspaceLock(
      path.join(jobsRoot(), ".slot-drain"),
      DRAIN_LOCK_TIMEOUT_MS,
    );
  } catch {
    // Another process is mid-drain and sees the same queue, so this call's
    // trigger is covered by that drain or the next one; waiting is not worth
    // blocking a dispatch for.
    return undefined;
  }
  let slots: string[];
  try {
    slots = await drainSlotQueueLocked(limit, config);
  } finally {
    releaseDrainLock();
  }
  // Launched OUTSIDE the lock: on Windows a launch goes through PowerShell and
  // WMI and takes over a second, and every other dispatch waits on this lock.
  // The slots themselves were registered inside it, which is what the count
  // depends on.
  const fallbacks: string[] = [];
  await Promise.all(slots.map((id) => launchSupervisor(id, runnerPath, configPath, fallbacks)));
  return fallbacks[0];
}

/**
 * Make the pending index match the scan just taken: an entry for every job
 * that is queued and unclaimed, and none for anything else (claimed,
 * cancelled, orphaned, finished, pruned). Under the drain lock, so the only
 * writers it can race are a dispatch adding an entry (harmless) and a claim
 * removing one (it re-reads before deleting nothing it did not see).
 */
async function reconcilePendingIndex(statuses: Array<{ jobDir: string; status: JobStatus }>): Promise<void> {
  const waiting = new Set<string>();
  for (const { jobDir, status } of statuses) {
    if (status.status === "queued" && claimHolder(jobDir) === undefined) waiting.add(status.jobId);
  }
  let indexed: string[];
  try {
    indexed = await readdir(pendingIndexDir());
  } catch {
    indexed = [];
  }
  for (const jobId of indexed) {
    if (!waiting.has(jobId)) await clearPending(jobId);
  }
  for (const jobId of waiting) {
    if (!indexed.includes(jobId)) await markPending(jobId).catch(() => undefined);
  }
}

/** How long a drain waits for a concurrent drainer before ceding to it. */
const DRAIN_LOCK_TIMEOUT_MS = 5_000;

/** Release what fits, and return the supervisor slots registered to run it. */
async function drainSlotQueueLocked(
  limit: number | null,
  config: RouterConfig | undefined,
): Promise<string[]> {
  const statuses = await readJobStatuses();
  await reconcilePendingIndex(statuses);
  let active = activeCapacity(statuses, config);
  // Supervisors are sized by how many JOBS there are, not by how much budget
  // they consume: ten endpoint calls are 1.0 of capacity but still ten jobs,
  // and sizing the pool off the weight would hand all ten to one supervisor
  // that runs them a few at a time.
  let activeJobs = countActiveJobs(statuses);
  const waiting = statuses.filter((s) => s.status.slotQueued);

  // Release stays HERE, synchronously and oldest-first, even though a
  // supervisor is what runs the job: the caller's returned status must
  // distinguish "got a slot" from "waiting", and FIFO across concurrent
  // dispatches only holds while one drainer decides the order.
  let released = 0;
  for (const { jobDir, status } of waiting) {
    const weight = resourceWeightFor(status, config);
    // `active > 0` prevents a deadlock: a job heavier than the whole budget
    // (weight 1.0 against a capacity of 0.5) would otherwise wait forever for
    // room that can never exist. When nothing is running, the next job goes.
    if (limit !== null && active > 0 && active + weight > limit) break;
    // Never release more jobs than the pool can actually pick up.
    //
    // The budget above is WEIGHTED, so ten 0.1-weight endpoint jobs cost 1.0 of
    // a limit of 4 — but each supervisor runs only jobsPerSupervisor(limit)
    // jobs at once (ceil(4/4) = 1 at the default) across SUPERVISOR_POOL_SIZE
    // of them, so the drainer would release up to forty jobs that only four
    // processes can run. A released job loses its slotQueued exemption and has
    // no heartbeat until a supervisor claims it. Held here, the excess stays
    // slotQueued — reported as waiting — until supervisors free up.
    if (limit !== null && activeJobs >= SUPERVISOR_POOL_SIZE * jobsPerSupervisor(limit)) break;
    const now = await stillWaiting(jobDir);
    if (now === undefined) continue;
    const { slotQueued: _dropped, ...cleared } = now;
    await updateStatus(jobDir, {
      ...cleared,
      updatedAt: timestamp(),
      instructions: pollInstructions(status.jobId, suggestedPollSeconds(now.createdAt)),
    });
    active += weight;
    activeJobs += 1;
    released += 1;
  }
  // Released work nobody has claimed needs a supervisor even when this call
  // released nothing: a launch that failed, or a supervisor killed between
  // release and claim, otherwise left the job waiting for the next release —
  // which, with nothing else queued, never came.
  const unclaimed = statuses.filter(
    ({ jobDir, status }) =>
      status.status === "queued" && !status.slotQueued && claimHolder(jobDir) === undefined,
  ).length;
  if (released === 0 && unclaimed === 0) return [];

  // Size the pool against ALL outstanding work, not just the jobs released on
  // this call: dispatches arrive one at a time, so `released` is usually 1 and
  // sizing on it would give a single supervisor for twelve jobs. The cap comes
  // from the pool size, never from how the work happened to arrive.
  const outstanding = Math.max(activeJobs, unclaimed);
  const wanted =
    limit === null
      ? Math.min(SUPERVISOR_POOL_SIZE, outstanding)
      : Math.min(SUPERVISOR_POOL_SIZE, Math.ceil(outstanding / jobsPerSupervisor(limit)));
  const running = await countLiveSupervisors();
  const slots: string[] = [];
  for (let i = running; i < wanted; i += 1) slots.push(registerSupervisorSlot());
  return slots;
}

/**
 * Delete a spawn log once it has nothing left to explain.
 *
 * An EMPTY log explains nothing and is what a clean exit leaves behind; it
 * goes once past the staleness threshold, so a live supervisor that has not
 * yet written anything keeps its log.
 *
 * A non-empty one is kept, because a supervisor that died is the one that left
 * a stale heartbeat, and its bootstrap output is the only explanation of why —
 * but only for as long as the jobs it could explain are kept. Past the job
 * retention window there is no job left to explain, and without an age limit
 * these accumulated forever in a directory every drain reads.
 */
async function pruneSpawnLog(dir: string, entry: string): Promise<void> {
  if (!entry.startsWith("spawn-") || !entry.endsWith(".log")) return;
  try {
    const info = await stat(path.join(dir, entry));
    const age = Date.now() - info.mtimeMs;
    if (age <= ORPHAN_THRESHOLD_MS) return;
    const retention = jobMaxAgeMs();
    if (info.size > 0 && (retention === 0 || age <= retention)) return;
    await rm(path.join(dir, entry), { force: true });
  } catch {
    // Vanished mid-sweep, or another drain got there first. Either way it is
    // gone, which is the outcome this wanted.
  }
}

/**
 * Supervisors currently alive, counted from their heartbeat files.
 *
 * Approximate on purpose: over-counting runs the pool one short until the next
 * drain, under-counting spawns one extra supervisor that finds no work and
 * exits within SUPERVISOR_IDLE_EXIT_MS. Both self-correct, so no lock.
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
    // Heartbeats only. This directory also holds each supervisor's
    // `spawn-<id>.log`, which exists to explain a supervisor that DIED — the
    // same one that left a stale heartbeat. Treating every file as a heartbeat
    // would delete the diagnostic for the failure being cleaned up after.
    if (!entry.endsWith(".txt")) {
      await pruneSpawnLog(dir, entry);
      continue;
    }
    try {
      const beat = await readFile(path.join(dir, entry), "utf8");
      if (Date.now() - Date.parse(beat) <= ORPHAN_THRESHOLD_MS) {
        live += 1;
        continue;
      }
      // Dead: remove it rather than only declining to count it. A supervisor
      // that exits cleanly deletes its own file; one that is KILLED cannot, so
      // its heartbeat would stay forever in a directory this loop reads on
      // every drain. Safe to delete — it is already past the staleness
      // threshold, and a supervisor that somehow revives writes it again on
      // its next beat.
      await rm(path.join(dir, entry), { force: true });
    } catch {
      // Vanished mid-read, or another drain removed it first: not live, and
      // nothing here needs to succeed for the count to be usable.
    }
  }
  return live;
}

/**
 * Where a waiting job stands: its place in the slot queue (1 = next), and the
 * jobs holding the slots it waits for. Computed on read and never written —
 * a queued job used to say nothing beyond "queued", so one stuck behind two
 * silent runs looked exactly like one about to start.
 */
export async function queueStanding(
  jobId: string,
): Promise<{ queuePosition?: number; waitingOn: string[] }> {
  const statuses = await readJobStatuses();
  const waiting = statuses.filter((s) => s.status.slotQueued && s.status.status === "queued");
  const index = waiting.findIndex((s) => s.status.jobId === jobId);
  const waitingOn = statuses
    .filter(({ status }) => {
      if (status.slotQueued || status.jobId === jobId) return false;
      if (status.status !== "running" && status.status !== "queued") return false;
      const beat = Date.parse(status.updatedAt);
      return !Number.isFinite(beat) || Date.now() - beat <= ORPHAN_THRESHOLD_MS;
    })
    .map(({ status }) => status.jobId);
  return { ...(index >= 0 ? { queuePosition: index + 1 } : {}), waitingOn };
}

/**
 * Start a supervisor for a waiting job when nothing else will.
 *
 * The queue has no daemon: it moves when something drains it, and drains
 * happen on a dispatch and in a supervisor's loop. Once every supervisor had
 * died, a queued job — slot-queued or released — sat until some unrelated
 * dispatch came along, while its own polls kept saying "wait". A supervisor
 * started here drains with its own config first, so the cap still decides
 * what runs; this only supplies the process that applies it.
 *
 * Only when no supervisor is alive and no run is in progress: a live run frees
 * its slot by draining when it ends, and starting supervisors next to it would
 * just spin up processes that find nothing they may run.
 *
 * Not called at server start, which deliberately reports abandoned queues
 * instead (orphanStrandedSlotQueue): this runs when someone asks about, or is
 * waiting on, this job. Returns why it could not start one, if it tried and
 * failed.
 */
export async function startSupervisorIfNoneAlive(
  configPath: string | undefined,
): Promise<string | undefined> {
  // In-process mode runs jobs inside the server; there is no pool to start.
  if (process.env.HARNESS_DISPATCH_INPROC_JOBS === "1") return undefined;
  const runnerPath = resolveRunnerPath();
  if (runnerPath === undefined) return undefined;
  if ((await countLiveSupervisors()) > 0) return undefined;
  const running = (await readJobStatuses()).some(({ status }) => {
    if (status.status !== "running") return false;
    const beat = Date.parse(status.updatedAt);
    return Number.isFinite(beat) && Date.now() - beat <= ORPHAN_THRESHOLD_MS;
  });
  if (running) return undefined;
  return launchSupervisor(registerSupervisorSlot(), runnerPath, configPath);
}

/**
 * Exported for the cleanup test, which must exercise the REAL sweep: it pins
 * that a stale heartbeat is removed, and a reimplementation in the test would
 * pin nothing.
 */
export const countLiveSupervisorsForTest = countLiveSupervisors;

/**
 * Register a supervisor slot: the heartbeat file the new process will adopt.
 *
 * HERE, synchronously and under the drain lock, before anything is spawned.
 * Booting a Node process takes a few hundred ms (and starting it through WMI on
 * Windows over a second), so if the supervisor wrote its own first heartbeat a
 * burst of dispatches would all count zero live supervisors and each spawn
 * another — 12 concurrent jobs becoming 12 supervisors at 748 MB. The parent
 * claiming the slot synchronously is what makes the cap real.
 */
function registerSupervisorSlot(): string {
  const dir = path.join(jobsRoot(), ".supervisors");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  writeFileSync(path.join(dir, `${id}.txt`), timestamp(), { encoding: "utf8", mode: 0o600 });
  return id;
}

/**
 * Start the supervisor for a registered slot; it finds its own work.
 *
 * Through `launchDetached`, so it survives the session that started it even
 * behind a launcher that kills its descendants (see detach.ts). Output goes to
 * a log beside the heartbeats: a supervisor that dies during bootstrap (bad
 * config, missing module) is otherwise completely silent, and the only symptom
 * is jobs that never start.
 *
 * Never throws. A launch that fails gives the slot back — its heartbeat would
 * otherwise count a supervisor that does not exist for 90 s — and says why in
 * the log, which the next drain's top-up then retries. A launch that only
 * worked through the plain-spawn fallback is reported to `fallbacks`, so the
 * dispatch that caused it can tell its caller.
 */
async function launchSupervisor(
  id: string,
  runnerPath: string,
  configPath: string | undefined,
  fallbacks?: string[],
): Promise<string | undefined> {
  const dir = path.join(jobsRoot(), ".supervisors");
  const logPath = path.join(dir, `spawn-${id}.log`);
  // Without the launching process's nesting depth. A supervisor serves whoever
  // dispatches next, but `job_status` (not gated by depth) can start one from a
  // delegate, and a supervisor carrying HARNESS_DISPATCH_DEPTH=1 refuses every
  // later user's CLI job as nested. Matched ignoring case: on Windows the
  // variable's name arrives in whatever case the launcher set it.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "HARNESS_DISPATCH_DEPTH"),
  );
  const outcome = await launchDetached({
    execPath: process.execPath,
    args: [runnerPath, "--supervisor", id],
    env: {
      ...inherited,
      ...(configPath !== undefined ? { HARNESS_DISPATCH_CONFIG: configPath } : {}),
    },
    logPath,
  });
  if (outcome.ok) {
    if (outcome.wmiError !== undefined) fallbacks?.push(fallbackWarning(outcome.wmiError));
    return undefined;
  }
  await rm(path.join(dir, `${id}.txt`), { force: true }).catch(() => undefined);
  await writeFile(logPath, `harness-dispatch: could not start a supervisor: ${outcome.error}
`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  }).catch(() => undefined);
  return outcome.error;
}

async function spawnDetachedSupervisor(runnerPath: string, configPath: string | undefined): Promise<void> {
  await launchSupervisor(registerSupervisorSlot(), runnerPath, configPath);
}

/**
 * Why a detached runner would fail to bootstrap from this config path, if it
 * would. `undefined` means the file loads, or there is none (auto-detect).
 *
 * Re-reads rather than trusting the server's in-memory config: the two
 * disagreeing is exactly the condition being detected.
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
