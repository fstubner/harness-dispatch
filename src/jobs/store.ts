/**
 * The job store: where a job lives on disk and how it is written.
 *
 * These are the primitives every other part of the job system sits on — path
 * resolution, atomic writes, status reads, retention — and they depend on
 * nothing above them.
 *
 * The atomicity is load-bearing: a status file half-written when a reader
 * arrives is indistinguishable from a crashed runner, so every write goes
 * through tmp+rename with a retry for Windows EPERM.
 */

import { existsSync, readFileSync } from "node:fs";
import { redact } from "../redaction.js";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { dirFromEnv, stateRoot } from "../state-dir.js";
import type { JobManifest, JobStatus } from "./types.js";

/**
 * Dispatcher error strings are unbounded — a corrupted downstream config can
 * produce a 173KB parse error. Full text always lands in stderr.log; the JSON
 * surfaces returned over MCP carry a bounded copy.
 */
const MAX_JSON_ERROR_CHARS = 4000;

/**
 * A job's answer text and per-attempt completions, one JSON event per line,
 * under output/. What a streaming caller follows — see jobs/read.ts
 * readJobEvents.
 */
export const JOB_EVENTS_LOG = "events.jsonl";

/** Bounds on the suggested delay before an agent checks `job_status` again. */
export const MIN_POLL_SECONDS = 15;
export const MAX_POLL_SECONDS = 300;

/**
 * How long to wait before checking a job again: about as long as it has
 * already been running, between 15 seconds and 5 minutes.
 *
 * A flat 300 s told an agent to wait five minutes for a job whose median real
 * run finished in under 15 s. Waiting as long as the job's age doubles the
 * interval at each check, so a quick job is picked up quickly and a long one
 * costs a handful of checks, never a poll every few seconds. It needs nothing
 * but the job's own start time, so every surface that reports a job agrees.
 */
export function suggestedPollSeconds(createdAt: string, now: number = Date.now()): number {
  const ageSeconds = (now - Date.parse(createdAt)) / 1000;
  if (!Number.isFinite(ageSeconds)) return MIN_POLL_SECONDS;
  const rounded = Math.round(ageSeconds / 5) * 5;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, rounded));
}

/**
 * A "running" status whose updatedAt is older than this is a lie — the process
 * that owned the run is gone (several missed heartbeats) — so readers report
 * the job as orphaned instead of keeping callers polling a corpse. A generous
 * multiple of the heartbeat, so an event-loop stall cannot produce false
 * orphans.
 */
export const ORPHAN_THRESHOLD_MS = 90_000;

/**
 * Compute-on-read orphan detection. This function itself writes nothing; the
 * readers go through `checkOrphan`, which records the verdict for a dead
 * `running` job.
 */
export function withOrphanCheck(status: JobStatus): JobStatus {
  // Waiting for a concurrency slot is not death: nothing is heartbeating for
  // it by design, so the staleness rule below would misreport every job that
  // waits longer than 90s. drainSlotQueue() is what moves it forward.
  if (status.slotQueued) return status;
  if (status.status !== "running" && status.status !== "queued") return status;
  const beat = Date.parse(status.updatedAt);
  if (Number.isFinite(beat) && Date.now() - beat <= ORPHAN_THRESHOLD_MS) {
    staleSeen.delete(status.jobId);
    return status;
  }
  // An old heartbeat alone is not death. A laptop that slept freezes the
  // supervisor with everything else, and on waking its next beat is up to 15 s
  // away: in that gap `job_status` said "nothing will advance it", and a
  // `retry_job` acting on that cancelled the live run. While the claiming
  // process is alive, the stale beat must stay unchanged under observation
  // before the job is called orphaned — the rule the workspace lock uses.
  const holder = claimHolder(status.jobDir);
  if (holder !== undefined && processAlive(holder)) {
    const seen = staleSeen.get(status.jobId);
    if (seen?.beat !== beat) {
      staleSeen.set(status.jobId, { beat, since: Date.now() });
      return status;
    }
    if (Date.now() - seen.since < LIVE_STALE_OBSERVE_MS) return status;
  }
  staleSeen.delete(status.jobId);
  // Released but never claimed: it has not started, and it WILL start once a
  // supervisor runs — so it is waiting, not dead. Reporting it `orphaned` made
  // it terminal (`completed: true`) while its own error said it would still
  // run, and re-dispatching it ran and billed the task twice. Polling it now
  // starts a supervisor when none is alive (see getAsyncJob).
  if (status.status === "queued" && holder === undefined) return status;
  return {
    ...status,
    status: "orphaned",
    success: false,
    // Says what is KNOWN, not which process died: the status file this is
    // derived from records a heartbeat and nothing about who was holding it,
    // so naming a culprit is a guess that sends anyone debugging to the wrong
    // process. A supervisor can die while the server stays up and serving.
    error:
      "This job stopped reporting progress and the process running it is gone — " +
      "either the run crashed or whatever was supervising it died. Nothing will " +
      "advance it now. Its partial output is on disk; `retry_job` re-runs the same " +
      "task, or re-dispatch it." +
      // Its agent CLI can outlive the supervisor, still editing the working
      // directory; this is the one place a caller learns that, and how to
      // stop it.
      (status.children !== undefined && status.children.length > 0
        ? ` Processes it started may still be running (${status.children
            .map((c) => `pid ${c.pid} ${c.command}`)
            .join(", ")}); \`cancel_job\` stops them, and \`retry_job\` does before re-running.`
        : ""),
  };
}

/**
 * `withOrphanCheck`, and the first time it finds a RUNNING job dead, the
 * verdict is written to status.json too.
 *
 * Left unwritten, a dead run read `running` on disk for as long as retention
 * kept it. Nothing inside this program was fooled (the supervisor's counts and
 * retention both apply the staleness rule themselves), but anything reading the
 * file directly was.
 *
 * Only a `running` status, and only when no live process holds the claim:
 *   - `queued` stays as written. A released job whose claimant died is
 *     reclaimed and run by claimNextJob, which filters on the file.
 *   - A live claimant with a stale beat is a stall or a sleeping machine, not a
 *     death; the verdict then stays derived, as it was.
 * The file is read again right before the write and must still hold the
 * heartbeat the verdict came from, so a runner that beat or finished in
 * between is not overwritten. A runner that wakes later writes over the
 * verdict with its own state, as every status write does.
 *
 * `children` is kept in the written record: cancel_job and retry_job use it to
 * stop agent processes the dead supervisor left behind.
 */
export async function checkOrphan(jobDir: string, raw: JobStatus): Promise<JobStatus> {
  const verdict = withOrphanCheck(raw);
  if (verdict.status !== "orphaned" || raw.status !== "running") return verdict;
  try {
    const now = await readJson<JobStatus>(path.join(jobDir, "status.json"));
    if (now.status !== "running" || now.updatedAt !== raw.updatedAt) return verdict;
    if (newerFormatError(now, now.jobId) !== undefined) return verdict;
    const holder = claimHolder(jobDir);
    if (holder !== undefined && processAlive(holder)) return verdict;
    await updateStatus(jobDir, verdict);
  } catch {
    // Best effort: the verdict is still returned, and the next read tries again.
  }
  return verdict;
}

/** How long a live claimant's stale heartbeat is watched before "orphaned". */
const LIVE_STALE_OBSERVE_MS = 30_000;

/** Per job, the stale heartbeat this process first saw and when. */
const staleSeen = new Map<string, { beat: number; since: number }>();

/** The pid in a job's claim, if it has one. */
export function claimHolder(jobDir: string | undefined): number | undefined {
  if (jobDir === undefined) return undefined;
  try {
    const claim = JSON.parse(readFileSync(path.join(jobDir, "claim.json"), "utf8")) as { pid?: unknown };
    return typeof claim.pid === "number" && claim.pid > 0 ? claim.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Does this pid exist? EPERM means it does, under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function boundedError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (error.length <= MAX_JSON_ERROR_CHARS) return error;
  return (
    error.slice(0, MAX_JSON_ERROR_CHARS) +
    ` … [truncated ${error.length - MAX_JSON_ERROR_CHARS} chars — full text in output/stderr.log]`
  );
}

export function pollInstructions(jobId: string, nextPollSeconds: number): string {
  return (
    `Job runs in the background. Call job_status with jobId=${jobId} in about ` +
    `${nextPollSeconds} seconds; do other work meanwhile if you have any. While status ` +
    `is "running", partialOutput shows progress and nextPollSeconds says when to check ` +
    `next (it grows with the job's age, up to ${MAX_POLL_SECONDS} seconds); stop when ` +
    `status is "completed" or "failed". Results persist on disk, so checking late ` +
    `loses nothing.`
  );
}

export function jobsRoot(): string {
  return dirFromEnv("HARNESS_DISPATCH_JOBS_DIR", () => path.join(stateRoot(), "jobs"));
}

const DEFAULT_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let configuredJobMaxAgeMs: number | undefined;

/**
 * Config-driven retention (`retention: { jobs_days: N }` in config.yaml) —
 * set at runtime bootstrap and on every hot reload. Precedence:
 * HARNESS_DISPATCH_JOB_MAX_AGE_MS env > config > 7-day default.
 */
export function setJobRetentionDays(days: number | undefined): void {
  configuredJobMaxAgeMs =
    days !== undefined && Number.isFinite(days) && days >= 0
      ? days * 24 * 60 * 60 * 1000
      : undefined;
}

export function jobMaxAgeMs(): number {
  const raw = process.env.HARNESS_DISPATCH_JOB_MAX_AGE_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return configuredJobMaxAgeMs ?? DEFAULT_JOB_MAX_AGE_MS;
}

/**
 * Prune job directories with no activity for the retention window (default 7
 * days, override via HARNESS_DISPATCH_JOB_MAX_AGE_MS), each time a new job is
 * about to start — otherwise every status file, result and snapshotted context
 * file accumulates under jobsRoot() forever. Directory mtime is a reasonable
 * proxy for "last activity": writeJson's tmp-then-rename touches the job dir on
 * every status update. Best effort — a prune failure must never block starting
 * the job that was actually requested.
 */
export async function pruneStaleJobs(): Promise<void> {
  const maxAgeMs = jobMaxAgeMs();
  // 0 means KEEP FOREVER, not "prune immediately" — the same config file
  // establishes `max_concurrent_runs: 0` as "disable the bound". Pruning at
  // age 0 deletes RUNNING jobs out from under their runners: a job dir's mtime
  // only moves on a 15s heartbeat, so every beat gap is fatal, the runner's
  // next write fails, and the caller's jobId turns into "No such job".
  if (maxAgeMs === 0) return;
  const root = jobsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only directories we named. This sweep deletes recursively, and the jobs
    // root is relocatable — HARNESS_DISPATCH_JOBS_DIR, and
    // HARNESS_DISPATCH_STATE_DIR which moves it too — so it is not guaranteed
    // to be ours alone. Without this, a root pointed at a directory holding
    // unrelated files removes anything stale sitting there.
    //
    // A name check suffices: `job-<digits>-<8 hex>` is what newJobId generates
    // and is specific enough that a foreign directory would have to be named
    // deliberately to collide.
    if (!JOB_ID_RE.test(entry.name)) continue;
    const jobDir = path.join(root, entry.name);
    try {
      const info = await stat(jobDir);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      // Never delete a job that is demonstrably in flight: a live runner
      // heartbeats status.json inside the orphan window, so running/queued with
      // a fresh beat means "working right now", whatever retention says. An
      // unreadable status file falls through to the mtime rule.
      try {
        const status = JSON.parse(
          await readFile(path.join(jobDir, "status.json"), "utf8"),
        ) as JobStatus;
        const beat = Date.parse(status.updatedAt ?? "");
        if (
          (status.status === "running" || status.status === "queued") &&
          Number.isFinite(beat) &&
          now - beat <= ORPHAN_THRESHOLD_MS
        ) {
          continue;
        }
        // Still in the slot queue: a request nobody has acted on, not a
        // finished record. Deleting it made a waiting job vanish into "No such
        // job"; running it after this long would start a task nobody is
        // watching. It is reported instead, like a queue a dead server left
        // behind, and ages out from here.
        if (status.slotQueued === true && status.status === "queued") {
          const { slotQueued: _cleared, ...rest } = status;
          await updateStatus(jobDir, {
            ...rest,
            status: "orphaned",
            updatedAt: timestamp(),
            success: false,
            error:
              "This job waited for a concurrency slot for longer than the job retention " +
              "window and never started. It is NOT run now: a task queued that long ago " +
              "should not start with nobody watching. Use retry_job to run it.",
          });
          continue;
        }
      } catch {
        // Fall through to the mtime rule.
      }
      await rm(jobDir, { recursive: true, force: true });
    } catch {
      // best effort — a locked/already-gone/permission-denied entry is skipped
    }
  }
}

export function timestamp(): string {
  return new Date().toISOString();
}

/**
 * How many status files a scan reads at once. Every scan of the jobs root used
 * to read them one after another: measured on 2,000 retained jobs, 1,009 ms
 * sequential against 132 ms 16 at a time.
 */
const STATUS_READ_WIDTH = 16;

/**
 * `fn` over `items` with at most STATUS_READ_WIDTH in flight, results in input
 * order. A bounded pool rather than Promise.all: a jobs root holds thousands of
 * directories for a busy HTTP or CI user, and opening them all at once runs
 * into the per-process file-handle limit.
 */
export async function mapBounded<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_READ_WIDTH, items.length) }, worker));
  return out;
}

/**
 * Index of jobs that may still need a supervisor: one empty file per job
 * id, written when a job joins the slot queue and removed when a supervisor
 * claims it. Only a hint that lets the drain and the claim loop skip their
 * full scan of every retained job directory when nothing is waiting — which
 * is almost always, and each supervisor pass did two such scans. Any scan that
 * does run reconciles it with the job directories, so a stale or missing entry
 * costs one extra scan, never a lost job.
 */
const PENDING_DIR = ".pending";

export function pendingIndexDir(): string {
  return path.join(jobsRoot(), PENDING_DIR);
}

export async function markPending(jobId: string): Promise<void> {
  await mkdir(pendingIndexDir(), { recursive: true, mode: 0o700 });
  await writeFile(path.join(pendingIndexDir(), jobId), "", { encoding: "utf8", mode: 0o600 });
}

export async function clearPending(jobId: string): Promise<void> {
  await rm(path.join(pendingIndexDir(), jobId), { force: true }).catch(() => undefined);
}

/**
 * False only when the index exists and is empty. A missing index — a jobs
 * root written by a build that predates it — rules nothing out.
 */
export async function mayHavePendingJobs(): Promise<boolean> {
  try {
    return (await readdir(pendingIndexDir())).length > 0;
  } catch {
    return true;
  }
}

export function safeBaseName(filePath: string): string {
  return path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "_");
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  // Sink: every job JSON on disk — status.json, result.json, manifest.json.
  await writeFile(tmpPath, `${redact(JSON.stringify(value, null, 2))}\n`, { encoding: "utf8", mode: 0o600 });
  await renameWithRetry(tmpPath, filePath);
}

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (err) {
      const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      await delay(25 * (attempt + 1));
    }
  }
  await rename(tmpPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

/**
 * The on-disk shape of status.json and manifest.json, written into both as
 * `v`. Compatibility was by tolerant parsing alone, so a file written by a
 * newer build was read by an older one as if it meant the same thing. Bump it
 * when a field changes meaning, not when one is added; a missing `v` is 1.
 */
export const JOB_FORMAT_VERSION = 1;

/** Why this build must not act on a job record, or undefined if it may. */
export function newerFormatError(record: { v?: unknown }, jobId: string): string | undefined {
  const v = record.v;
  if (typeof v !== "number" || v <= JOB_FORMAT_VERSION) return undefined;
  return (
    `Job ${jobId} was written by a newer harness-dispatch (job format v${v}; this build ` +
    `understands v${JOB_FORMAT_VERSION}). Upgrade harness-dispatch to read or run it.`
  );
}

export async function updateStatus(jobDir: string, status: JobStatus): Promise<void> {
  try {
    await writeJson(path.join(jobDir, "status.json"), {
      ...status,
      v: JOB_FORMAT_VERSION,
      updatedAt: timestamp(),
    });
  } catch (err) {
    // A job directory that no longer exists is not an error worth throwing.
    //
    // Retention can prune a bundle, and a user can delete one, while its
    // runner is still alive — and a status write is a RECORD of the run, not
    // the run itself. Throwing here takes the runner down with an unhandled
    // rejection from the heartbeat, over a file nobody was going to read.
    //
    // Narrow on purpose: only a missing directory is swallowed. A full disk, a
    // permission fault or a corrupt write still surfaces, because those mean
    // the record is being lost while somewhere to put it still exists.
    const code =
      typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT" && !existsSync(jobDir)) return;
    throw err;
  }
}

export async function snapshotFiles(jobDir: string, files: string[]): Promise<JobManifest["files"]> {
  const out: JobManifest["files"] = [];
  const filesDir = path.join(jobDir, "context", "files");
  await mkdir(filesDir, { recursive: true, mode: 0o700 });

  for (const [index, originalPath] of files.entries()) {
    const item: JobManifest["files"][number] = { originalPath };
    try {
      const fileStat = await stat(originalPath);
      if (!fileStat.isFile()) {
        item.error = "not a regular file";
        out.push(item);
        continue;
      }
      const snapshotName = `${String(index + 1).padStart(3, "0")}-${safeBaseName(originalPath)}`;
      const snapshotPath = path.join(filesDir, snapshotName);
      await copyFile(originalPath, snapshotPath);
      await chmod(snapshotPath, 0o600);
      item.snapshotPath = snapshotPath;
      item.sizeBytes = fileStat.size;
    } catch (err) {
      item.error = err instanceof Error ? err.message : String(err);
    }
    out.push(item);
  }

  await writeJson(path.join(jobDir, "context", "files.json"), out);
  return out;
}

/**
 * The only jobId shape this module ever produces. Kept adjacent to
 * `assertValidJobId` so the two cannot drift.
 */
export function newJobId(): string {
  return `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export const JOB_ID_RE = /^job-\d+-[0-9a-f]{8}$/;

/**
 * Reject anything that isn't a jobId we generated, BEFORE it reaches path.join.
 *
 * The MCP schema validates this too, but the check belongs here as well:
 * path.join(jobsRoot(), "../../etc/hosts") escapes the jobs root, and this
 * function is reachable from more than one caller. Validating only at the
 * schema would mean any future caller silently reintroduces the traversal.
 */
/**
 * The same test as `assertValidJobId`, as a predicate, for the caller that must
 * REFUSE an id without failing the whole call: `buildContextPreamble` takes a
 * list, and one unusable entry should not kill the dispatch.
 */
export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

export function assertValidJobId(jobId: string): void {
  if (!JOB_ID_RE.test(jobId)) {
    throw new Error(
      `Invalid jobId ${JSON.stringify(jobId)} — expected job-<timestamp>-<8 hex chars>.`,
    );
  }
}

/**
 * Cancellation is COOPERATIVE, by a marker file rather than a signal.
 *
 * Killing a pid is not available here: one pooled supervisor runs several jobs
 * at once, so the only pid recorded against a job belongs to a process also
 * running other people's work, and signalling it would cancel jobs nobody asked
 * to cancel.
 *
 * So the canceller writes a marker and the RUN tears itself down: it drops out
 * of its event stream, which triggers the dispatcher's own teardown (killTree
 * on the agent CLI and its children) and releases the workspace lock through
 * the same path a normal finish uses. The cost is that cancellation lands
 * within one poll interval rather than instantly.
 */
const CANCEL_MARKER = "cancel.json";

export async function requestCancel(jobDir: string, reason?: string): Promise<void> {
  await writeFile(
    path.join(jobDir, CANCEL_MARKER),
    JSON.stringify({ at: timestamp(), ...(reason !== undefined ? { reason } : {}) }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/** True once a cancel has been requested for this job. Cheap enough to poll. */
export function cancelRequested(jobDir: string): boolean {
  return existsSync(path.join(jobDir, CANCEL_MARKER));
}

/** The reason recorded with a cancel request, if one was given. */
export async function cancelReason(jobDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(jobDir, CANCEL_MARKER), "utf8");
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}
