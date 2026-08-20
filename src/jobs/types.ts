/**
 * The shapes a job is written and read as.
 *
 * Split out of jobs.ts so the store, the supervisor and the dispatch path can
 * share them without importing each other. These types are the actual
 * contract between processes — a detached runner rebuilds its whole input
 * from JobManifest, and every reader of a job's state goes through JobStatus
 * — so they are the one part of the job system that must stay stable.
 */

import type { DispatchResult, DispatcherEvent, RouteHints, RoutingDecision, WorkspacePolicy } from "../types.js";
import type { RuntimeHolder } from "../mcp/config-hot-reload.js";

export interface JobDeps {
  holder: RuntimeHolder;
}

export interface StartJobInput {
  prompt: string;
  /**
   * Earlier jobs whose results this one should be able to see.
   *
   * A delegate previously received a prompt and a file list and nothing else,
   * so a second delegated step could not see what the first produced. The only
   * way to chain work was for the orchestrator to read job A's output into its
   * OWN context and re-summarise it into job B's prompt — spending exactly the
   * context that delegating was meant to save, and losing detail in the
   * retelling.
   *
   * Naming the prior jobs instead moves that transfer into the tool: their
   * prompts and outputs are rendered into B's prompt directly, at full
   * fidelity, without passing through the orchestrator.
   */
  contextJobs?: string[];
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
  /**
   * "orphaned" is never written to disk — it's computed on read: a job
   * whose status file says "running" but whose heartbeat (updatedAt) has
   * gone stale means the server process that owned the background run
   * exited (session restart, crash) and the run died with it. Reporting it
   * as still "running" forever is a lie that makes callers poll a corpse.
   */
  status: "queued" | "running" | "completed" | "failed" | "orphaned";
  createdAt: string;
  updatedAt: string;
  jobDir: string;
  service?: string;
  route?: string;
  success?: boolean;
  /** Bounded copy — full text in output/stderr.log. */
  error?: string;
  /**
   * END-TO-END milliseconds for the run: routing, workspace preparation and
   * any workspace-lock wait included. Deliberately NOT the same number as
   * result.durationMs, which times the harness attempt alone — one job
   * legitimately reports 116ms there and 15s here when it queued behind a
   * shared_locked workspace. Both are real; they answer different questions.
   */
  durationMs?: number;
  /** Suggested seconds to wait before polling action=get again. */
  nextPollSeconds?: number;
  /** Agent-facing guidance on how to collect the result. */
  instructions?: string;
  /** Set when workingDir was omitted and defaulted to the router's own cwd. */
  warning?: string;
  /**
   * Queued because the machine is at `max_concurrent_runs`, NOT because its
   * owner died. Load-bearing for orphan detection: a slot-queued job has no
   * process heartbeating for it, so without this flag the 90s staleness rule
   * would report a job that is merely waiting its turn as a dead one.
   * Cleared the moment a slot frees and its runner is spawned.
   */
  slotQueued?: true;
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

export interface StartedJob {
  status: JobStatus;
  /**
   * Resolves once the run has reached a terminal state on disk (result.json
   * or a failed/orphaned status). Never rejects. In detached mode this is a
   * disk watcher on the job directory — the run itself lives in a separate
   * job-runner process; in in-process mode (HARNESS_DISPATCH_INPROC_JOBS=1,
   * used by unit tests with injected fakes) it is the runJob promise itself.
   */
  completion: Promise<void>;
}
