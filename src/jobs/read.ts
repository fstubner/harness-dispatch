/**
 * Reading a job back: one with its partial output, or the recent list.
 *
 * Separate from start.ts because the supervisor reads jobs while deciding what
 * to run and start.ts needs the supervisor: keeping the reads beside the start
 * verbs would close that loop.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { queueStanding, startSupervisorIfNoneAlive } from "./supervisor.js";
import {
  assertValidJobId,
  claimHolder,
  JOB_EVENTS_LOG,
  JOB_ID_RE,
  jobsRoot,
  mapBounded,
  pollInstructions,
  readJson,
  SUGGESTED_POLL_SECONDS,
  withOrphanCheck,
} from "./store.js";
import type { JobManifest, JobResultPayload, JobStatus } from "./types.js";
import type { DispatcherEvent } from "../types.js";
const MAX_PARTIAL_OUTPUT_CHARS = 4000;

export async function getAsyncJob(
  jobId: string,
  opts: {
    /**
     * Start a supervisor if this job is waiting and nothing alive will run it
     * (see startSupervisorIfNoneAlive). On for a caller asking after the job;
     * off for cancel and retry, which must never start work.
     */
    recover?: boolean;
  } = {},
): Promise<{
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
  // id long enough will hit this. A raw Node ENOENT quoting an absolute path
  // inside the jobs directory tells the caller nothing actionable and leaks
  // the layout.
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
    // A failed result with no output of its own — a cancelled isolated run,
    // or a fallback chain whose last attempt printed nothing — says nothing
    // about what the delegate DID write. That is in the partial log, and
    // returning only the result dropped it: the durability rule held or not
    // depending on the workspace policy.
    const bare = result.result?.success === false && !result.result.output;
    const partialOutput = bare ? await readPartial(jobDir) : undefined;
    return { manifest, status, result, ...(partialOutput !== undefined ? { partialOutput } : {}) };
  }
  // Terminal: no poll guidance — polling will never resolve an orphaned job.
  // But it still falls through to the partial-output read below, which is the
  // whole point of the record surviving the runner. PRODUCT.md's success
  // criterion is explicit that a dispatch must never die returning nothing —
  // "at worst it fails and hands back its latest progress… a wasted attempt
  // with no trail is the defining failure" — and orphaning is exactly that
  // case: the supervisor died, so there is no result.json and the partial log
  // is all that survived.
  const out: { manifest: JobManifest; status: JobStatus; partialOutput?: string } = {
    manifest,
    status: await withProgressGuidance(status, manifest, jobDir, opts.recover ?? true),
  };
  const partial = await readPartial(jobDir);
  if (partial !== undefined) out.partialOutput = partial;
  return out;
}

/**
 * Poll guidance for a job still in progress, and only for one: a cancelled or
 * failed job with no result told its caller to "check again until completed",
 * which it never would be.
 *
 * A WAITING job — queued and not claimed by any supervisor — also says where
 * it stands and what it waits on, and, if nothing alive would ever run it,
 * gets a supervisor started (when `recover`).
 */
async function withProgressGuidance(
  status: JobStatus,
  manifest: JobManifest,
  jobDir: string,
  recover: boolean,
): Promise<JobStatus> {
  const { nextPollSeconds: _n, instructions: _i, ...bare } = status;
  if (status.status !== "queued" && status.status !== "running") return bare;
  const poll = pollInstructions(status.jobId);
  if (status.status !== "queued" || claimHolder(jobDir) !== undefined) {
    return { ...bare, nextPollSeconds: SUGGESTED_POLL_SECONDS, instructions: poll };
  }
  const launchError = recover ? await startSupervisorIfNoneAlive(manifest.configPath) : undefined;
  const { queuePosition, waitingOn } = await queueStanding(status.jobId);
  const where = status.slotQueued
    ? `Waiting for a concurrency slot (max_concurrent_runs): ` +
      `${(queuePosition ?? 1) - 1} job(s) ahead of it, ` +
      `${waitingOn.length} running${waitingOn.length > 0 ? ` (${waitingOn.join(", ")})` : ""}. ` +
      `It starts by itself when a slot frees; do not re-dispatch it. `
    : `Released to run; waiting for a supervisor process to pick it up. `;
  const failed =
    launchError !== undefined
      ? `Starting a supervisor for it failed: ${launchError} (details in ` +
        `${path.join(jobsRoot(), ".supervisors")}). `
      : "";
  return {
    ...bare,
    ...(queuePosition !== undefined ? { queuePosition } : {}),
    waitingOn,
    nextPollSeconds: SUGGESTED_POLL_SECONDS,
    instructions: where + failed + poll,
  };
}

/** The tail of a job's live output log, if it wrote one. */
async function readPartial(jobDir: string): Promise<string | undefined> {
  const partialPath = path.join(jobDir, "output", "stdout.partial.log");
  if (!existsSync(partialPath)) return undefined;
  try {
    const partial = await readFile(partialPath, "utf8");
    return partial.length <= MAX_PARTIAL_OUTPUT_CHARS
      ? partial
      : `… [${partial.length - MAX_PARTIAL_OUTPUT_CHARS} chars omitted] …` +
          partial.slice(-MAX_PARTIAL_OUTPUT_CHARS);
  } catch {
    return undefined; // Best-effort; absence of partial output isn't an error.
  }
}

export async function listAsyncJobs(): Promise<JobStatus[]> {
  const root = jobsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.filter((e) => e.isDirectory() && JOB_ID_RE.test(e.name)).map((e) => e.name);
  const read = await mapBounded(names, async (name) => {
    try {
      return withOrphanCheck(await readJson<JobStatus>(path.join(root, name, "status.json")));
    } catch {
      return undefined; // Ignore incomplete or manually edited job directories.
    }
  });
  return read
    .filter((s): s is JobStatus => s !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Where a job ran and how its prompt starts, for the job list — what lets a
 * caller whose dispatch reply was lost pick out ITS job, since every session
 * on the machine lists the same jobs. Empty for a job that predates the
 * preview, or whose manifest cannot be read.
 */
export async function jobListingContext(
  jobId: string,
): Promise<{ workingDir?: string; promptPreview?: string; client?: string; session?: string }> {
  try {
    const manifest = await readJson<JobManifest>(path.join(jobsRoot(), jobId, "manifest.json"));
    const caller = manifest.caller;
    return {
      ...(typeof manifest.workingDir === "string" ? { workingDir: manifest.workingDir } : {}),
      ...(typeof manifest.promptPreview === "string" ? { promptPreview: manifest.promptPreview } : {}),
      // Which client and connection started it: a session that lost its
      // dispatch reply can match its own session id instead of guessing.
      ...(typeof caller?.client === "string" ? { client: caller.client } : {}),
      ...(typeof caller?.session === "string" ? { session: caller.session } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Events a job has recorded since `offset` (a byte position in its events
 * log), and the offset to continue from. Only whole lines are returned, so a
 * line being written while this reads is picked up on the next call.
 */
export async function readJobEvents(
  jobId: string,
  offset: number,
): Promise<{ events: DispatcherEvent[]; offset: number }> {
  assertValidJobId(jobId);
  let buf: Buffer;
  try {
    buf = await readFile(path.join(jobsRoot(), jobId, "output", JOB_EVENTS_LOG));
  } catch {
    return { events: [], offset };
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < offset) return { events: [], offset };
  const events: DispatcherEvent[] = [];
  for (const line of buf.subarray(offset, end).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as DispatcherEvent);
    } catch {
      // A line that does not parse is skipped rather than ending the stream.
    }
  }
  return { events, offset: end + 1 };
}
