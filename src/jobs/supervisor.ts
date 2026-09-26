/**
 * Admission control and the supervisor pool: who runs, when, and in which
 * process. The concurrency cap bounds memory, and the pool exists because a
 * runner process per job costs ~76 MB of wrapper.
 */

import { spawn } from "node:child_process";
import { executeJobDir, resolveRunnerPath } from "./run.js";
import { listAsyncJobs } from "./read.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
    return true;
  } catch {
    const beat = Date.parse(status.updatedAt);
    if (!Number.isFinite(beat) || Date.now() - beat <= ORPHAN_THRESHOLD_MS) return false;
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
  const statuses = await readJobStatuses();
  for (const { jobDir, status } of statuses) {
    if (status.slotQueued) continue;
    if (status.status !== "queued") continue;
    // Claiming a cancelled job would start work someone already asked to stop.
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

  try {

    for (;;) {
      const limit = maxConcurrentRuns(deps.holder.state.config);

      // A supervisor outlives individual jobs, so a deleted jobs root would
      // otherwise leave it polling a path that no longer exists.
      if (!existsSync(jobsRoot())) return;

      if (inflight.size < jobsPerSupervisor(limit)) {
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
 * The one status this writes back. Orphan detection elsewhere is
 * compute-on-read and never persists its verdict, because the owner might
 * still be alive; here the owner is definitionally gone.
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
  const jobs = await listAsyncJobs().catch(() => []);
  let marked = 0;
  for (const listed of jobs) {
    if (listed.slotQueued !== true) continue;
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
 */
export async function drainSlotQueue(
  config: RouterConfig | undefined,
  configPath: string | undefined,
): Promise<void> {
  const limit = maxConcurrentRuns(config);
  const runnerPath = resolveRunnerPath();
  if (runnerPath === undefined) return;

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
    // no heartbeat until a supervisor claims it, so after 90 s it reads as
    // `orphaned — Nothing will advance it now`, which is false and invites a
    // retry that runs the same task twice. Held here, the excess stays
    // slotQueued — reported as waiting — until supervisors free up.
    if (limit !== null && activeJobs >= SUPERVISOR_POOL_SIZE * jobsPerSupervisor(limit)) break;
    const now = await stillWaiting(jobDir);
    if (now === undefined) continue;
    const { slotQueued: _dropped, ...cleared } = now;
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
  // this call: dispatches arrive one at a time, so `released` is usually 1 and
  // sizing on it would give a single supervisor for twelve jobs. The cap comes
  // from the pool size, never from how the work happened to arrive.
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
 * Delete a spawn log that recorded nothing.
 *
 * Non-empty logs are kept — see the sweep below — because a supervisor that
 * died is the one that left a stale heartbeat, and its bootstrap output is the
 * only explanation of why. An EMPTY log explains nothing and is what a clean
 * exit leaves behind; they would otherwise accumulate indefinitely in a
 * directory the sweep reads on every drain.
 *
 * Only past the staleness threshold, so a live supervisor that has not yet
 * written anything keeps its log.
 */
async function dropEmptySpawnLog(dir: string, entry: string): Promise<void> {
  if (!entry.startsWith("spawn-") || !entry.endsWith(".log")) return;
  try {
    const info = await stat(path.join(dir, entry));
    if (info.size > 0) return;
    if (Date.now() - info.mtimeMs <= ORPHAN_THRESHOLD_MS) return;
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
      await dropEmptySpawnLog(dir, entry);
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
 * Exported for the cleanup test, which must exercise the REAL sweep: it pins
 * that a stale heartbeat is removed, and a reimplementation in the test would
 * pin nothing.
 */
export const countLiveSupervisorsForTest = countLiveSupervisors;

/**
 * Start one detached supervisor; it finds its own work.
 *
 * Output goes to a log beside the heartbeats: a supervisor that dies during
 * bootstrap (bad config, missing module) is otherwise completely silent, and
 * the only symptom is jobs that never start.
 */
function spawnDetachedSupervisor(runnerPath: string, configPath: string | undefined): void {
  const dir = path.join(jobsRoot(), ".supervisors");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Register the slot HERE, before spawning, and hand the id to the child.
  // Booting a Node process takes a few hundred ms, so if the supervisor wrote
  // its own first heartbeat a burst of dispatches would all count zero live
  // supervisors and each spawn another — 12 concurrent jobs becoming 12
  // supervisors at 748 MB. The parent claiming the slot synchronously is what
  // makes the cap real.
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
