/**
 * Reading a job back: one with its partial output, or the recent list.
 *
 * Separate from start.ts because the supervisor reads jobs while deciding
 * what to run, and start.ts needs the supervisor — keeping the reads beside
 * the start verbs closed that loop.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertValidJobId,
  jobsRoot,
  pollInstructions,
  readJson,
  SUGGESTED_POLL_SECONDS,
  withOrphanCheck,
} from "./store.js";
import type { JobManifest, JobResultPayload, JobStatus } from "./types.js";
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
  // Terminal: no poll guidance — polling will never resolve an orphaned job.
  // But it still gets its partial output, which is the whole point of the
  // record surviving the runner.
  //
  // This branch used to `return` here, ABOVE the partial-output read below, so
  // an orphaned job handed back nothing at all while its progress sat in
  // output/stdout.partial.log. PRODUCT.md's success criterion is explicit that
  // a dispatch must never die returning nothing — "at worst it fails and hands
  // back its latest progress… a wasted attempt with no trail is the defining
  // failure" — and orphaning is exactly the case that criterion was written
  // for: the supervisor died, so there is no result.json and the partial log
  // is all that survived. An acceptance pass measured eight chunks of progress
  // on disk and an empty response.
  const terminalOrphan = status.status === "orphaned";
  const out: { manifest: JobManifest; status: JobStatus; partialOutput?: string } = {
    manifest,
    status: terminalOrphan
      ? status
      : {
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
