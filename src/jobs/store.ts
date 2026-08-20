/**
 * The job store: where a job lives on disk and how it is written.
 *
 * Split out of jobs.ts. These are the primitives every other part of the job
 * system sits on — path resolution, atomic writes, status reads, retention —
 * and they depend on nothing above them, so they lift out cleanly and can be
 * reasoned about (and tested) without starting a dispatch.
 *
 * The atomicity here is load-bearing rather than incidental: a status file
 * half-written when a reader arrives is indistinguishable from a crashed
 * runner, which is why every write goes through tmp+rename with a retry for
 * Windows EPERM.
 */

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { stateRoot } from "../state-dir.js";
import type { JobManifest, JobStatus } from "./types.js";

/**
 * Dispatcher error strings are unbounded (a corrupted downstream config once
 * produced a 173KB parse error). Full text always lands in stderr.log; the
 * JSON surfaces returned over MCP carry a bounded copy.
 */
const MAX_JSON_ERROR_CHARS = 4000;

/** Suggested delay before an agent checks `job_status` again. */
export const SUGGESTED_POLL_SECONDS = 300;

/**
 * A "running" status whose updatedAt is older than this is a lie — the
 * process that owned the run is gone (several missed heartbeats), so
 * readers report the job as orphaned instead of keeping callers polling a
 * corpse forever. Generous multiple of the heartbeat so an event-loop
 * stall can't produce false orphans.
 */
export const ORPHAN_THRESHOLD_MS = 90_000;

/**
 * Compute-on-read orphan detection. Never writes the verdict back — the
 * status file stays whatever the (dead) owner last wrote, so a future
 * attach/recovery feature keeps its evidence intact.
 */
export function withOrphanCheck(status: JobStatus): JobStatus {
  // Waiting for a concurrency slot is not death: nothing is heartbeating for
  // it by design, so the staleness rule below would misreport every job that
  // waits longer than 90s. drainSlotQueue() is what moves it forward.
  if (status.slotQueued) return status;
  if (status.status !== "running" && status.status !== "queued") return status;
  const beat = Date.parse(status.updatedAt);
  if (Number.isFinite(beat) && Date.now() - beat <= ORPHAN_THRESHOLD_MS) return status;
  return {
    ...status,
    status: "orphaned",
    success: false,
    error:
      "The dispatch server that started this job exited before the run finished — " +
      "the background run died with it. Re-dispatch the task; this job will never complete.",
  };
}

export function boundedError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (error.length <= MAX_JSON_ERROR_CHARS) return error;
  return (
    error.slice(0, MAX_JSON_ERROR_CHARS) +
    ` … [truncated ${error.length - MAX_JSON_ERROR_CHARS} chars — full text in output/stderr.log]`
  );
}

export function pollInstructions(jobId: string): string {
  return (
    `Job runs in the background; CLI harnesses typically take 3-15 minutes. ` +
    `Wait ~${Math.round(SUGGESTED_POLL_SECONDS / 60)} minutes (e.g. sleep), then call ` +
    `job_status with jobId=${jobId}. While status is "running", partialOutput shows ` +
    `progress; check again until status is "completed" or "failed". Results persist ` +
    `on disk, so checking late loses nothing.`
  );
}

export function jobsRoot(): string {
  return process.env.HARNESS_DISPATCH_JOBS_DIR ?? path.join(stateRoot(), "jobs");
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
 * Nothing ever pruned old job directories — status.json/result.json/output
 * logs and every snapshotted context file accumulated under jobsRoot()
 * forever. Prune anything with no activity for the retention window
 * (default 7 days, override via HARNESS_DISPATCH_JOB_MAX_AGE_MS) each time a
 * new job is about to start. Job directory mtime is a reasonable proxy for
 * "last activity": writeJson's tmp-then-rename touches the job dir on every
 * status update, so a running (or freshly completed but unpolled) job keeps
 * bumping it — only genuinely abandoned jobs go stale. Best effort: a prune
 * failure must never block starting the job that was actually requested.
 */
export async function pruneStaleJobs(): Promise<void> {
  const maxAgeMs = jobMaxAgeMs();
  // 0 means KEEP FOREVER, not "prune immediately". The same config file
  // establishes `max_concurrent_runs: 0` as "disable the bound", inviting the
  // same reading here — and the old behaviour deleted RUNNING jobs out from
  // under their runners (a job dir's mtime only moves on a 15s heartbeat, so
  // at age 0 every beat gap was fatal): the runner's next write failed and
  // the caller's jobId turned into "No such job".
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
    const jobDir = path.join(root, entry.name);
    try {
      const info = await stat(jobDir);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      // mtime is a proxy for activity; never delete a job that is
      // demonstrably in flight. A live runner heartbeats status.json inside
      // the orphan window, so running/queued with a fresh beat means "working
      // right now", whatever retention says. An unreadable status file falls
      // through to the mtime rule — that is the abandoned case.
      try {
        const status = JSON.parse(
          await readFile(path.join(jobDir, "status.json"), "utf8"),
        ) as { status?: string; updatedAt?: string };
        const beat = Date.parse(status.updatedAt ?? "");
        if (
          (status.status === "running" || status.status === "queued") &&
          Number.isFinite(beat) &&
          now - beat <= ORPHAN_THRESHOLD_MS
        ) {
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

export function safeBaseName(filePath: string): string {
  return path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "_");
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

export async function updateStatus(jobDir: string, status: JobStatus): Promise<void> {
  await writeJson(path.join(jobDir, "status.json"), {
    ...status,
    updatedAt: timestamp(),
  });
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
 * Reject anything that isn't a jobId we generated, BEFORE it reaches
 * path.join.
 *
 * The MCP schema validates this too, but the check belongs here as well:
 * path.join(jobsRoot(), "../../etc/hosts") escapes the jobs root, and this
 * function is reachable from more than one caller. Validating only at the
 * schema would mean any future caller silently reintroduces the traversal.
 */
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
 * Killing a pid is not available here: jobs run inside pooled supervisors
 * (SUPERVISOR_POOL_SIZE), and one supervisor runs several jobs at once, so
 * the only pid recorded against a job belongs to a process that is also
 * running other people's work. Signalling it would cancel jobs nobody asked
 * to cancel.
 *
 * So the canceller writes a marker and the RUN tears itself down: it drops
 * out of its event stream, which triggers the dispatcher's own teardown
 * (killTree on the agent CLI and its children) and releases the workspace
 * lock through the same path a normal finish uses. The cost is that
 * cancellation is not instant — it lands within one poll interval.
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
