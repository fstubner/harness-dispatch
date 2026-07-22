/**
 * Minimal async job bundle support.
 *
 * The MCP `job` tool returns quickly after creating a reproducible bundle on
 * disk, then runs the selected router dispatch in the background. This avoids
 * MCP client timeouts for slow CLI agents while preserving the exact prompt,
 * file list, copied context snapshots, stdout/stderr, and final result.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { RuntimeHolder } from "./mcp/config-hot-reload.js";
import type {
  DispatchResult,
  DispatcherEvent,
  RouteHints,
  RoutingDecision,
  WorkspacePolicy,
} from "./types.js";
import { resolveWorkingDir, workingDirWarning } from "./working-dir.js";

/**
 * Dispatcher error strings are unbounded (a corrupted downstream config once
 * produced a 173KB parse error). Full text always lands in stderr.log; the
 * JSON surfaces returned over MCP carry a bounded copy.
 */
const MAX_JSON_ERROR_CHARS = 4000;

/** Suggested delay before an agent polls `job action=get` again. */
const SUGGESTED_POLL_SECONDS = 300;

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

function boundedError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (error.length <= MAX_JSON_ERROR_CHARS) return error;
  return (
    error.slice(0, MAX_JSON_ERROR_CHARS) +
    ` … [truncated ${error.length - MAX_JSON_ERROR_CHARS} chars — full text in output/stderr.log]`
  );
}

function pollInstructions(jobId: string): string {
  return (
    `Job runs in the background; CLI harnesses typically take 3-15 minutes. ` +
    `Wait ~${Math.round(SUGGESTED_POLL_SECONDS / 60)} minutes (e.g. sleep), then call ` +
    `dispatch with jobId=${jobId}. While status is "running", partialOutput shows ` +
    `progress; poll again until status is "completed" or "failed". Results persist on ` +
    `disk, so a missed poll loses nothing.`
  );
}

export interface JobDeps {
  holder: RuntimeHolder;
}

export interface StartJobInput {
  prompt: string;
  files?: string[];
  workingDir?: string;
  hints?: RouteHints;
  workspacePolicy?: WorkspacePolicy;
  service?: string;
  /**
   * Live dispatcher-event tap, used by the `dispatch` tool to forward MCP
   * progress notifications during its inline grace window. Never serialized
   * (the manifest lists its fields explicitly), never awaited, and a throw
   * here must not fail the job.
   */
  onEvent?: (event: DispatcherEvent) => void;
}

export interface JobStatus {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  jobDir: string;
  service?: string;
  route?: string;
  success?: boolean;
  /** Bounded copy — full text in output/stderr.log. */
  error?: string;
  durationMs?: number;
  /** Suggested seconds to wait before polling action=get again. */
  nextPollSeconds?: number;
  /** Agent-facing guidance on how to collect the result. */
  instructions?: string;
  /** Set when workingDir was omitted and defaulted to the router's own cwd. */
  warning?: string;
}

export interface JobManifest {
  jobId: string;
  createdAt: string;
  workingDir: string;
  promptPath: string;
  files: Array<{
    originalPath: string;
    snapshotPath?: string;
    sizeBytes?: number;
    error?: string;
  }>;
  hints?: RouteHints;
  workspacePolicy?: WorkspacePolicy;
  service?: string;
  /** Set when workingDir was omitted and defaulted to the router's own cwd. */
  warning?: string;
}

export interface JobResultPayload {
  jobId: string;
  result: DispatchResult;
  decision: RoutingDecision | null;
}

function jobsRoot(): string {
  return (
    process.env.HARNESS_DISPATCH_JOBS_DIR ??
    path.join(homedir(), ".harness-dispatch", "jobs")
  );
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

function jobMaxAgeMs(): number {
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
async function pruneStaleJobs(): Promise<void> {
  const root = jobsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const maxAgeMs = jobMaxAgeMs();
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(root, entry.name);
    try {
      const info = await stat(jobDir);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(jobDir, { recursive: true, force: true });
      }
    } catch {
      // best effort — a locked/already-gone/permission-denied entry is skipped
    }
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function safeBaseName(filePath: string): string {
  return path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function updateStatus(jobDir: string, status: JobStatus): Promise<void> {
  await writeJson(path.join(jobDir, "status.json"), {
    ...status,
    updatedAt: timestamp(),
  });
}

async function snapshotFiles(jobDir: string, files: string[]): Promise<JobManifest["files"]> {
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

async function runJob(
  deps: JobDeps,
  jobDir: string,
  manifest: JobManifest,
  input: StartJobInput,
): Promise<void> {
  const started = Date.now();
  await updateStatus(jobDir, {
    jobId: manifest.jobId,
    status: "running",
    createdAt: manifest.createdAt,
    updatedAt: timestamp(),
    jobDir,
    ...(input.service !== undefined ? { service: input.service } : {}),
    ...(manifest.warning !== undefined ? { warning: manifest.warning } : {}),
  });

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
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(path.join(jobDir, "output", "stderr.log"), message, { encoding: "utf8", mode: 0o600 });
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
  }
}

export interface StartedJob {
  status: JobStatus;
  /**
   * Resolves once the background run has fully landed on disk (result.json +
   * final status for a normal run; failed status for a crashed one). Never
   * rejects — runJob catches everything. This is what lets the `dispatch`
   * tool race an inline grace window against the run without polling disk.
   */
  completion: Promise<void>;
}

export async function startAsyncJob(deps: JobDeps, input: StartJobInput): Promise<JobStatus> {
  return (await startAsyncJobTracked(deps, input)).status;
}

export async function startAsyncJobTracked(deps: JobDeps, input: StartJobInput): Promise<StartedJob> {
  await pruneStaleJobs();
  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const root = jobsRoot();
  const jobDir = path.join(root, jobId);
  await mkdir(path.join(jobDir, "context"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(jobDir, "output"), { recursive: true, mode: 0o700 });

  const promptPath = path.join(jobDir, "prompt.md");
  await writeFile(promptPath, input.prompt, { encoding: "utf8", mode: 0o600 });
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

  const completion = runJob(deps, jobDir, manifest, input);
  return { status, completion };
}

const MAX_PARTIAL_OUTPUT_CHARS = 4000;

export async function getAsyncJob(jobId: string): Promise<{
  manifest: JobManifest;
  status: JobStatus;
  result?: JobResultPayload;
  /** Tail of live stdout/stderr while the job is still running. */
  partialOutput?: string;
}> {
  const jobDir = path.join(jobsRoot(), jobId);
  const manifest = await readJson<JobManifest>(path.join(jobDir, "manifest.json"));
  const status = await readJson<JobStatus>(path.join(jobDir, "status.json"));
  const resultPath = path.join(jobDir, "output", "result.json");
  if (existsSync(resultPath)) {
    return { manifest, status, result: await readJson<JobResultPayload>(resultPath) };
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
      statuses.push(await readJson<JobStatus>(path.join(root, entry.name, "status.json")));
    } catch {
      // Ignore incomplete or manually edited job directories.
    }
  }
  return statuses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
