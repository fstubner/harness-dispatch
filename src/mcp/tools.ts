/**
 * MCP tool registry for harness-dispatch.
 *
 * The public MCP surface is three tools, each doing exactly one thing:
 * `dispatch` starts routed work (single or fanout) and only ever starts —
 * `job_status` checks or lists it, `usage` reads route/quota state. Every
 * dispatch is job-backed from the first moment — dispatch races an inline
 * grace window against the background run, so a fast task returns its full
 * result in-call and a slow one degrades to a pollable jobId with NOTHING
 * lost to a timeout; job_status is how that jobId gets checked on later.
 * Status is also exposed as resources so clients can inspect state without
 * a tool call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  DispatchResult,
  DispatcherEvent,
  RoutePolicy,
  RouteHints,
  RouteSkip,
  TaskType,
  WorkspacePolicy,
  WorkspaceRun,
} from "../types.js";
import { setTimeout as delay } from "node:timers/promises";

import { nearMissHintKey, nearMissMessage } from "../near-miss.js";
import { withMcpToolSpan } from "../observability/spans.js";
import type { RuntimeHolder, ConfigHotReloader } from "./config-hot-reload.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import {
  cancelJob,
  getAsyncJob,
  listAsyncJobs,
  resolveJobWorkspace,
  retryJob,
  startAsyncJobTracked,
  type JobStatus,
} from "../jobs.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { buildStatus, buildUsage, redactEndpointHost } from "../status.js";
import { endpointUrl } from "../dispatchers/openai-compatible.js";

import {
  cancelJobInputShape,
  retryJobInputShape,
  workspaceInputShape,
  DEFAULT_GRACE_SECONDS,
  dispatchInputShape,
  JOB_ID_RE,
  jobStatusInputShape,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_JOBS,
  publicHintsSchema,
  safetyProfileSchema,
  usageInputShape,
  workspacePolicySchema,
} from "./tool-schemas.js";










/**
 * Exactly the shape jobs.ts:679 generates: `job-${Date.now()}-${8 hex}`.
 *
 * The schema was a bare z.string() and getAsyncJob does
 * `path.join(jobsRoot(), jobId)` with no validation, so a caller could read
 * manifest.json / status.json from anywhere on disk by passing `../..`
 * segments. Constrained to three filenames, but an MCP server's threat model
 * is "the calling agent may be steered by injected content", not "the caller
 * is trustworthy" — validating the format is a one-liner and removes the
 * question entirely.
 */


export const TOOL_NAMES = ["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"] as const;

export interface RouteResponse {
  success: boolean;
  output: string;
  error?: string;
  /** Set when workingDir was omitted and defaulted to the router's own cwd. */
  warning?: string;
  route: string;
  model?: string;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  skippedRoutes?: RouteSkip[];
  workspace?: WorkspaceRun;
  routing?: {
    tier: number;
    quotaScore: number;
    qualityScore: number;
    cliCapability: number;
    capabilityScore: number;
    taskType: TaskType;
    elo?: number;
    finalScore: number;
    reason: string;
    /**
     * Set only when hints.model was provided on this call. true if it
     * matched something the picked route statically declares; false if it
     * was passed through "blind" because nothing recognized it (still
     * forwarded to the dispatcher either way — hints.model is unvalidated
     * by design). Use this to tell "got exactly what I asked for" apart
     * from "might have a typo" without comparing strings yourself.
     */
    modelHintMatched?: boolean;
    /**
     * true when hints.model named the route that ran and was therefore NOT
     * sent on as a model — the route ran its own. `model` above is what
     * actually ran.
     *
     * Without this the only signal was modelHintMatched: false, documented as
     * "forwarded blind, treat with suspicion" — the opposite of what
     * happened. It was not forwarded at all.
     */
    modelHintDropped?: boolean;
    /**
     * What the picked route beat, best first, winner included — present only
     * when the router chose. `reason` counts the candidates ("tier 1 best (3
     * available)"); this says which three and by how much, so an automatic
     * choice can be argued with instead of taken on faith.
     */
    candidates?: Array<{ route: string; score: number }>;
  };
}

export interface FanoutItem {
  route: string;
  jobId: string;
  /** false = still running past the grace window; poll its jobId. */
  completed: boolean;
  success?: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
  capabilityScore: number;
  qualityScore: number;
  elo?: number;
  workspace?: WorkspaceRun;
  /** Tail of live output for a not-yet-completed item. */
  partialOutput?: string;
}

/** A started dispatch: full inline result if it beat the grace window, else a pollable handle. */
export type DispatchResponse =
  | ({ mode: "single"; jobId: string; completed: true } & RouteResponse)
  | {
      mode: "single";
      jobId: string;
      completed: false;
      partialOutput?: string;
      nextPollSeconds?: number;
      instructions?: string;
      warning?: string;
    }
  | {
      mode: "fanout";
      /** true when every item finished within the grace window. */
      completed: boolean;
      results: FanoutItem[];
      skippedRoutes?: RouteSkip[];
      warning?: string;
    };

export interface DispatchPollResponse {
  jobId: string;
  completed: boolean;
  status: JobStatus;
  /** Present once the run completed or failed with a recorded result. */
  result?: RouteResponse;
  /** Tail of live output while still running. */
  partialOutput?: string;
}

export interface ToolDeps {
  holder: RuntimeHolder;
  reloader?: ConfigHotReloader;
}

export interface ToolExtra {
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

function jsonText(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toHints(h: z.infer<typeof publicHintsSchema> | undefined): RouteHints {
  if (!h) return {};
  const out: RouteHints = {};
  if (h.model !== undefined) out.model = h.model;
  if (h.taskType !== undefined) out.taskType = h.taskType;
  if (h.preferLargeContext !== undefined) out.preferLargeContext = h.preferLargeContext;
  if (h.safetyProfile !== undefined) out.safetyProfile = h.safetyProfile;
  if (h.workspacePolicy !== undefined) out.workspacePolicy = h.workspacePolicy;
  if (h.routePolicy !== undefined) out.routePolicy = h.routePolicy as RoutePolicy;
  if (h.timeoutMs !== undefined) out.timeoutMs = h.timeoutMs;
  return out;
}

/**
 * Exported for the parity test, which re-implemented this rule inline and so
 * would have stayed green if the real resolver flipped — the same
 * assert-the-derivation-not-the-behaviour shape that let a fanout fail-open
 * ship under two passing rows.
 */
export function workspacePolicyFromInput(input: {
  workspacePolicy?: WorkspacePolicy | undefined;
  hints?: { workspacePolicy?: WorkspacePolicy | undefined } | undefined;
}): WorkspacePolicy | undefined {
  return input.workspacePolicy ?? input.hints?.workspacePolicy;
}

async function ensureFreshConfig(reloader: ConfigHotReloader | undefined): Promise<void> {
  if (reloader) await reloader.maybeReload();
}

async function emitProgress(
  extra: ToolExtra | undefined,
  progressToken: string | number | undefined,
  counter: { value: number },
  event: DispatcherEvent,
  route?: string,
): Promise<void> {
  if (!extra?.sendNotification || progressToken === undefined) return;
  counter.value += 1;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: counter.value,
        message: summarizeEvent(event, route),
        _meta: { event, route },
      },
    });
  } catch {
    // Best effort only. A progress delivery failure should not fail the tool.
  }
}

function summarizeEvent(event: DispatcherEvent, route?: string): string {
  const prefix = route ? `[${route}] ` : "";
  switch (event.type) {
    case "stdout":
      return `${prefix}stdout: ${truncate(event.chunk, 60)}`;
    case "stderr":
      return `${prefix}stderr: ${truncate(event.chunk, 60)}`;
    case "tool_use":
      return `${prefix}tool_use: ${event.name}`;
    case "thinking":
      return `${prefix}thinking: ${truncate(event.chunk, 60)}`;
    case "completion":
      return `${prefix}completion: ${event.result.success ? "ok" : "fail"}`;
    case "error":
      return `${prefix}error: ${event.error}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

function routeResponse(
  result: DispatchResult,
  decision: import("../types.js").RoutingDecision | null,
  workingDirWarningMessage?: string,
): RouteResponse {
  const response: RouteResponse = {
    success: result.success,
    output: result.output,
    route: result.service,
  };
  if (workingDirWarningMessage !== undefined) response.warning = workingDirWarningMessage;
  if (result.error !== undefined) response.error = result.error;
  if (result.durationMs !== undefined) response.durationMs = result.durationMs;
  if (result.tokensUsed !== undefined) response.tokensUsed = result.tokensUsed;
  if (result.skippedRoutes !== undefined) response.skippedRoutes = result.skippedRoutes;
  if (result.workspace !== undefined) response.workspace = result.workspace;
  if (decision) {
    if (decision.model !== undefined) response.model = decision.model;
    response.routing = {
      tier: decision.tier,
      quotaScore: decision.quotaScore,
      qualityScore: decision.qualityScore,
      cliCapability: decision.cliCapability,
      capabilityScore: decision.capabilityScore,
      taskType: decision.taskType,
      finalScore: decision.finalScore,
      reason: decision.reason,
    };
    if (decision.elo !== undefined) response.routing.elo = decision.elo;
    if (decision.modelHintMatched !== undefined) {
      response.routing.modelHintMatched = decision.modelHintMatched;
    }
    if (decision.modelHintDropped !== undefined) {
      response.routing.modelHintDropped = decision.modelHintDropped;
    }
    if (decision.candidates !== undefined && decision.candidates.length > 0) {
      response.routing.candidates = decision.candidates;
    }
    if (decision.skippedRoutes !== undefined && decision.skippedRoutes.length > 0) {
      response.skippedRoutes = decision.skippedRoutes;
    }
  }
  return response;
}

/**
 * Wait up to `graceMs` for the background run, then report disk truth. The
 * race only decides when we STOP waiting — completion state is always read
 * back from the job artifacts, so the inline path and a later poll can
 * never disagree about the same run. The grace timer is unref'd so a
 * short-lived process (tests, one-shot CLI) never hangs on it.
 */
async function waitGrace(completion: Promise<void>, graceMs: number): Promise<void> {
  if (graceMs <= 0) return;
  await Promise.race([completion, delay(graceMs, undefined, { ref: false })]);
}

function jobCompleted(job: Awaited<ReturnType<typeof getAsyncJob>>): boolean {
  return (
    job.result !== undefined ||
    job.status.status === "completed" ||
    job.status.status === "failed" ||
    // Orphaned (owner process died mid-run) is terminal: it will never
    // complete, so callers must stop polling and re-dispatch.
    job.status.status === "orphaned" ||
    // Cancelled is terminal too, and was missing. `completed` is the field the
    // tool descriptions tell an agent to branch on, so an orchestrator that
    // cancelled a job and then polled it was told `completed: false` with
    // `nextPollSeconds: 300` and "check again until status is completed or
    // failed" — forever, for a job that had already stopped at its own
    // request.
    job.status.status === "cancelled"
  );
}

/**
 * Build the RouteResponse view of a finished job. Covers the crash path
 * too: a runJob failure writes a final "failed" status but no result.json,
 * which must still surface as a completed-and-failed dispatch, not as
 * something to keep polling.
 */
function jobRouteResponse(job: Awaited<ReturnType<typeof getAsyncJob>>): RouteResponse {
  if (job.result) {
    return routeResponse(job.result.result, job.result.decision, job.status.warning);
  }
  const response: RouteResponse = {
    success: false,
    output: "",
    route: job.status.route ?? job.status.service ?? "none",
  };
  if (job.status.error !== undefined) response.error = job.status.error;
  if (job.status.warning !== undefined) response.warning = job.status.warning;
  if (job.status.durationMs !== undefined) response.durationMs = job.status.durationMs;
  return response;
}

/** Progress forwarder for the inline grace window — goes quiet once the MCP call has returned. */
function makeProgressTap(
  extra: ToolExtra | undefined,
  live: { value: boolean },
  counter: { value: number },
  route?: string,
): ((event: DispatcherEvent) => void) | undefined {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra?.sendNotification) return undefined;
  return (event: DispatcherEvent): void => {
    if (!live.value) return;
    void emitProgress(extra, progressToken, counter, event, route);
  };
}

async function startSingle(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof dispatchInputShape>>,
  extra?: ToolExtra,
): Promise<DispatchResponse> {
  await ensureFreshConfig(deps.reloader);
  // Reject an unknown forced route BEFORE a job directory exists. Fanout
  // rejects unknown `models` at the boundary; single mode let the same
  // mistake through, burned a job dir, and returned a success-shaped
  // completed:true / success:false — one input, two behaviours.
  if (input.service !== undefined && !(input.service in deps.holder.state.config.services)) {
    throw new Error(
      `Unknown service: ${input.service}. Valid route ids: ` +
        `${Object.keys(deps.holder.state.config.services).join(", ")}. ` +
        `Call the \`usage\` tool to see each route's current model and quota.`,
    );
  }
  const hints = toHints(input.hints);
  const workspacePolicy = workspacePolicyFromInput(input);
  if (workspacePolicy !== undefined) hints.workspacePolicy = workspacePolicy;

  const live = { value: true };
  const counter = { value: 0 };
  const onEvent = makeProgressTap(extra, live, counter, input.service);

  const { status, completion } = await startAsyncJobTracked(
    { holder: deps.holder },
    {
      prompt: input.prompt,
      files: input.files ?? [],
      ...(input.contextJobs !== undefined ? { contextJobs: input.contextJobs } : {}),
      ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
      hints,
      ...(input.workspacePolicy !== undefined ? { workspacePolicy: input.workspacePolicy } : {}),
      ...(input.service !== undefined ? { service: input.service } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    },
  );

  const graceMs = (input.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000;
  await waitGrace(completion, graceMs);
  live.value = false;

  const job = await getAsyncJob(status.jobId);
  if (jobCompleted(job)) {
    return { mode: "single", jobId: status.jobId, completed: true, ...jobRouteResponse(job) };
  }
  const pending: DispatchResponse = {
    mode: "single",
    jobId: status.jobId,
    completed: false,
  };
  if (job.partialOutput !== undefined) pending.partialOutput = job.partialOutput;
  if (job.status.nextPollSeconds !== undefined) pending.nextPollSeconds = job.status.nextPollSeconds;
  if (job.status.instructions !== undefined) pending.instructions = job.status.instructions;
  if (job.status.warning !== undefined) pending.warning = job.status.warning;
  return pending;
}

function matchesRequestedModel(
  routeName: string,
  svc: { model?: string; leaderboardModel?: string },
  requested: Set<string>,
): boolean {
  if (requested.size === 0) return true;
  const lower = new Set([...requested].map((s) => s.toLowerCase()));
  return [routeName, svc.model, svc.leaderboardModel]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .some((v) => lower.has(v.toLowerCase()));
}

async function startFanout(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof dispatchInputShape>>,
  extra?: ToolExtra,
): Promise<DispatchResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const hints = toHints(input.hints);
  const workspacePolicy = workspacePolicyFromInput(input);
  if (workspacePolicy !== undefined) hints.workspacePolicy = workspacePolicy;
  const fanoutSafetyProfile = hints.safetyProfile ?? "read_only";
  if (
    fanoutSafetyProfile !== "read_only" &&
    (hints.workspacePolicy === undefined || !isIsolatedWorkspacePolicy(hints.workspacePolicy))
  ) {
    // A refusal must not be success-shaped. This used to return
    // completed:true with empty results and the reason tucked into
    // skippedRoutes, so an agent skimming for `completed` read "done". The
    // HTTP surface has returned 400 for the same input all along; the two
    // must agree.
    throw new Error(
      "write-capable fanout requires workspacePolicy=copy or workspacePolicy=git_worktree; " +
        "use read_only fanout or run single-route workspace_edit (workspace_isolation_required)",
    );
  }
  hints.safetyProfile = fanoutSafetyProfile;
  // Contract: hints.model is ignored entirely in fanout mode — `models` is
  // the only selection mechanism. The job runner would forward it to every
  // arm otherwise.
  delete hints.model;
  const taskType: TaskType = hints.taskType ?? "plan";
  const requested = new Set(input.models ?? []);
  const counter = { value: 0 };
  const skippedRoutes: RouteSkip[] = [];

  // Every requested name must match SOMETHING. A name that matches nothing was
  // silently dropped: `models: ["fake_fast", "ghost_route"]` fanned out to one
  // arm with no skippedRoutes entry and no error, and
  // `models: ["ghost_a", "ghost_b"]` returned
  // `{ completed: true, results: [] }` — success-shaped, zero explanation,
  // because `completed` is `every()` over an empty array. Single mode already
  // rejects an unknown `service` by name; fanout should not be looser about
  // the same mistake.
  const matchedRequests = new Set<string>();
  for (const [routeName, svc] of Object.entries(state.config.services)) {
    for (const want of requested) {
      if (matchesRequestedModel(routeName, svc, new Set([want]))) matchedRequests.add(want);
    }
  }
  const unmatched = [...requested].filter((r) => !matchedRequests.has(r));
  if (unmatched.length > 0) {
    throw new Error(
      `Unknown fanout target(s): ${unmatched.join(", ")}. ` +
        `Valid route ids: ${Object.keys(state.config.services).join(", ")}. ` +
        `models: accepts route ids or model names.`,
    );
  }

  const candidates: string[] = [];
  for (const [routeName, svc] of Object.entries(state.config.services)) {
    if (!matchesRequestedModel(routeName, svc, requested)) continue;
    const breaker = state.router.getBreaker(routeName);
    const dispatcher = state.dispatchers[routeName];
    const policy = evaluateRoutePolicy(routeName, svc, {
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      circuitBroken: Boolean(breaker?.isTripped),
      ...(hints.safetyProfile !== undefined ? { requestedSafetyProfile: hints.safetyProfile } : {}),
      ...(hints.routePolicy !== undefined ? { routePolicy: hints.routePolicy } : {}),
    });
    if (policy.skipped) skippedRoutes.push(policy.skipped);
    if (policy.blocked) continue;
    candidates.push(routeName);
  }

  // Nothing can run. Same rule as the two refusals above — a refusal must not
  // be success-shaped — and this was the one case still taking the vacuous
  // path: `completed` is `every()` over an empty array, so an all-blocked
  // fanout answered `{ completed: true, results: [] }` with the reasons tucked
  // into `skippedRoutes`, on the field the tool description tells agents to
  // branch on.
  //
  // The unmatched-name guard above throws for a name matching NO route, so the
  // same user mistake produced two opposite shapes depending on whether the
  // route they named happens to exist and be disabled. Both are "you asked for
  // routes and none of them can run".
  if (candidates.length === 0) {
    const why = skippedRoutes.map((s) => `${s.route}: ${s.message}`).join("; ");
    throw new Error(
      `No fanout route can run this request${why ? ` — ${why}` : ""}. ` +
        `Check \`usage\` for route readiness, or adjust models/safetyProfile/routePolicy.`,
    );
  }

  const prompt = input.prompt;
  const files = input.files ?? [];
  const live = { value: true };

  // Start every candidate as its own background job up front, then wait ONE
  // shared grace window for all of them — a route that beats the deadline
  // reports inline, the rest hand back their jobIds. Per-route job dirs also
  // give each fanout arm its own artifacts, which the blocking version never
  // had.
  const started = await Promise.all(
    candidates.map(async (routeName) => {
      const svc = state.config.services[routeName]!;
      const cap = svc.capabilities[taskType as "execute" | "plan" | "review"] ?? 1.0;
      const quality = await state.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const onEvent = makeProgressTap(extra, live, counter, routeName);
      const job = await startAsyncJobTracked(
        { holder: deps.holder },
        {
          prompt,
          files,
          // Forwarded per arm, same as single mode. It used to be dropped
          // here silently, so a chained fanout ("get three opinions building
          // on job A") ran every arm WITHOUT the context and never said so.
          ...(input.contextJobs !== undefined ? { contextJobs: input.contextJobs } : {}),
          ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
          hints,
          service: routeName,
          ...(onEvent !== undefined ? { onEvent } : {}),
        },
      );
      return { routeName, cap, quality, job };
    }),
  );

  const graceMs = (input.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000;
  await waitGrace(Promise.all(started.map((s) => s.job.completion)).then(() => undefined), graceMs);
  live.value = false;

  let warning: string | undefined;
  const results = await Promise.all(
    started.map(async ({ routeName, cap, quality, job }): Promise<FanoutItem> => {
      const current = await getAsyncJob(job.status.jobId);
      if (current.status.warning !== undefined) warning = current.status.warning;
      const item: FanoutItem = {
        route: routeName,
        jobId: job.status.jobId,
        completed: jobCompleted(current),
        capabilityScore: cap,
        qualityScore: quality.qualityScore,
      };
      if (quality.elo !== null) item.elo = quality.elo;
      if (item.completed) {
        const response = jobRouteResponse(current);
        item.success = response.success;
        item.output = response.output;
        if (response.error !== undefined) item.error = response.error;
        if (response.durationMs !== undefined) item.durationMs = response.durationMs;
        if (response.workspace !== undefined) item.workspace = response.workspace;
      } else if (current.partialOutput !== undefined) {
        item.partialOutput = current.partialOutput;
      }
      return item;
    }),
  );

  results.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? -1 : 1;
    if (a.success !== b.success) return a.success ? -1 : 1;
    return b.capabilityScore - a.capabilityScore;
  });
  const response: DispatchResponse = {
    mode: "fanout",
    completed: results.every((r) => r.completed),
    results,
  };
  if (skippedRoutes.length > 0) response.skippedRoutes = skippedRoutes;
  if (warning !== undefined) response.warning = warning;
  return response;
}

async function pollDispatch(jobId: string): Promise<DispatchPollResponse> {
  const job = await getAsyncJob(jobId);
  const completed = jobCompleted(job);
  const response: DispatchPollResponse = { jobId, completed, status: job.status };
  if (completed) {
    response.result = jobRouteResponse(job);
  } else if (job.partialOutput !== undefined) {
    response.partialOutput = job.partialOutput;
  }
  return response;
}

export async function handleDispatch(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof dispatchInputShape>>,
  extra?: ToolExtra,
): Promise<unknown> {
  return withMcpToolSpan({ "tool.name": "dispatch" }, async () => {
    if ((input.mode ?? "single") === "fanout") {
      if (input.service !== undefined) {
        throw new Error(
          "dispatch: `service` forces a single route and is incompatible with mode='fanout' — use `models` to select fanout routes",
        );
      }
      return startFanout(deps, input, extra);
    }
    return startSingle(deps, input, extra);
  });
}

/** Most-recent jobs returned by the list view. */
const LIST_LIMIT = 20;

export async function handleCancelJob(args: { jobId: string; reason?: string | undefined }) {
  return cancelJob(args.jobId, args.reason);
}

export async function handleRetryJob(
  deps: ToolDeps,
  args: { jobId: string; service?: string | undefined },
) {
  await ensureFreshConfig(deps.reloader);
  return retryJob(args.jobId, { holder: deps.holder }, args.service !== undefined ? { service: args.service } : {});
}

export async function handleWorkspace(args: {
  jobId: string;
  action: "diff" | "apply" | "discard";
  force?: boolean | undefined;
}) {
  return resolveJobWorkspace(args.jobId, args.action, args.force !== undefined ? { force: args.force } : {});
}

export async function handleJobStatus(
  input: z.infer<z.ZodObject<typeof jobStatusInputShape>>,
): Promise<unknown> {
  return withMcpToolSpan({ "tool.name": "job_status" }, async () => {
    if (input.jobId !== undefined) return pollDispatch(input.jobId);
    // Compact list: full detail (jobDir, warnings, instructions, errors)
    // lives behind a per-job check — dumping it for every job ever was a
    // several-KB token tax on each list call.
    const all = await listAsyncJobs();
    const jobs = all.slice(0, LIST_LIMIT).map((j) => ({
      jobId: j.jobId,
      status: j.status,
      createdAt: j.createdAt,
      ...(j.route !== undefined ? { route: j.route } : {}),
      ...(j.service !== undefined && j.service !== j.route ? { service: j.service } : {}),
      ...(j.success !== undefined ? { success: j.success } : {}),
      ...(j.durationMs !== undefined ? { durationMs: j.durationMs } : {}),
    }));
    return {
      jobs,
      ...(all.length > LIST_LIMIT ? { omitted: all.length - LIST_LIMIT } : {}),
    };
  });
}


/**
 * Model catalog for one OpenAI-compatible route. An operator-declared
 * `models:` list is an override, not a supplement — if present it's
 * returned as-is with NO network call, so a curated/pinned list stays
 * authoritative even if the endpoint's live /models changes or is noisy.
 * `source` distinguishes the two so a caller can tell which happened.
 */
async function fetchEndpointModels(
  route: string,
  svc: { type: string; baseUrl?: string; apiKey?: string; models?: string[] } | undefined,
): Promise<{ route: string; models?: string[]; source?: "declared" | "live"; error?: string }> {
  if (!svc) {
    return { route, error: `unknown route '${route}' — call usage without listModels to see valid route ids` };
  }
  if (svc.models && svc.models.length > 0) {
    return { route, models: svc.models, source: "declared" };
  }
  if (svc.type !== "openai_compatible" || !svc.baseUrl) {
    return {
      route,
      error:
        "listModels only works for openai_compatible endpoint routes (or any route " +
        "with a declared models: list) — CLI harnesses publish their catalog via " +
        "this route's modelHint instead",
    };
  }
  const url = endpointUrl(svc.baseUrl, "/models");
  const headers: Record<string, string> = {};
  if (svc.apiKey) headers["Authorization"] = `Bearer ${svc.apiKey}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { route, error: `GET ${redactEndpointHost(url)} -> HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return { route, models, source: "live" };
  } catch (err) {
    return {
      route,
      error: `GET ${redactEndpointHost(url)} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleUsage(deps: ToolDeps, args: { listModels?: string | undefined } = {}) {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const status = await buildStatus(
    state.config,
    state.dispatchers,
    state.quota,
    state.router,
    state.leaderboard,
  );
  const usage = buildUsage(status);
  if (args.listModels) {
    const svc = state.config.services[args.listModels];
    return { ...usage, liveModels: await fetchEndpointModels(args.listModels, svc) };
  }
  return usage;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "dispatch",
    {
      title: "Dispatch a coding task",
      description:
        "Delegate a bounded coding task (implement, fix, review, plan, or investigate — " +
        "not general Q&A) to the best-fit harness (Claude Code, Codex, Cursor, " +
        "Antigravity, or a configured endpoint), or fan out to several for independent " +
        "opinions. Always starts new work — every dispatch runs as a background job " +
        "from the first moment: if it finishes within the grace window (default " +
        `${DEFAULT_GRACE_SECONDS}s, see graceSeconds) you get the full result inline ` +
        "(completed: true); otherwise you get completed: false plus a jobId — check on " +
        "it with the `job_status` tool, which returns partialOutput while it runs and " +
        "the full result once done. NOTHING is ever lost to a timeout, including this " +
        "MCP call's own: the run executes in a detached process that survives even a " +
        "server restart, and results " +
        "persist on disk — if THIS call times out client-side, the jobId was lost with " +
        "the reply, so call `job_status` with no arguments and pick the newest running " +
        "entry (it is yours). Keep graceSeconds under your MCP client's own request " +
        "timeout, or skip the inline wait entirely with graceSeconds: 0. Always pass " +
        "`workingDir` (the caller's project root) and `hints.taskType`.",
      inputSchema: dispatchInputShape,
    },
    async (args, extra) => jsonText(await handleDispatch(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "job_status",
    {
      title: "Check or list background dispatches",
      description:
        "Check on work started by `dispatch`. Pass the `jobId` it returned: while " +
        "running you get `partialOutput` (a live tail), and once `completed` is true " +
        "you get the full `result` — same shape as an inline dispatch reply. Omit " +
        "`jobId` to list recent background dispatches instead (compact, newest first). "
        + "Nothing is lost by " +
        "checking late; results persist on disk.",
      inputSchema: jobStatusInputShape,
    },
    async (args) => jsonText(await handleJobStatus(args)),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Stop a running or queued dispatch",
      description:
        "Stop work started by `dispatch` — use it when a run is going the wrong way, " +
        "was sent to the wrong directory, or has been superseded. A job still waiting " +
        "for a slot stops outright; a running one is asked to tear down and stops " +
        "within about a second (poll `job_status` to see it land), killing the agent " +
        "CLI and its child processes. TWO THINGS TO KNOW: files the agent already " +
        "changed are NOT reverted — this stops further work, it is not a rollback; and " +
        "a cancelled run is not counted as a route failure, so cancelling costs the " +
        "route nothing. Cancelling an already-finished job is a harmless no-op that " +
        "reports what it found.",
      inputSchema: cancelJobInputShape,
    },
    async (args) => jsonText(await handleCancelJob(args)),
  );

  server.registerTool(
    "retry_job",
    {
      title: "Run a finished job's task again",
      description:
        "Re-runs a finished job's task from its own record — the same prompt (as the " +
        "delegate actually saw it, context preamble included), files, working " +
        "directory, hints and workspace policy — so you do not have to reconstruct " +
        "any of it. Pass `service` to send the retry to a DIFFERENT route, which is " +
        "the usual reason to retry: the task was fine and the route was not (quota " +
        "limit, a harness that got stuck). Returns a NEW jobId; the original job and " +
        "its workspace are left untouched. Refuses while the original is still " +
        "running — cancel it first, or two attempts race on one directory.",
      inputSchema: retryJobInputShape,
    },
    async (args) => jsonText(await handleRetryJob(deps, args)),
  );

  server.registerTool(
    "workspace",
    {
      title: "Inspect, keep or discard isolated work",
      description:
        "For a job that ran with workspacePolicy 'copy' or 'git_worktree', the agent's " +
        "changes live in an isolated workspace and were NEVER applied to your project. " +
        "This is how you deal with them. 'diff' returns the real patch of what changed " +
        "(review this before keeping it). 'apply' applies that patch to the original " +
        "project — it refuses when the project has uncommitted changes, since the patch " +
        "was built against a clean base, and force: true overrides. 'discard' deletes " +
        "the workspace and leaves the project untouched. The full patch is always " +
        "written to the job directory, so `git apply` by hand is available even when " +
        "the automatic apply declines.",
      inputSchema: workspaceInputShape,
    },
    async (args) => jsonText(await handleWorkspace(args)),
  );

  server.registerTool(
    "usage",
    {
      title: "Check current usage",
      description:
        "Per-route call counts (success/failure), quota remaining, billing kind, and " +
        "circuit-breaker state for this session. Call this before using an unfamiliar " +
        "`hints.model`/`service`/`models` value to see valid route ids and their " +
        "current models — those fields are not validated and silently ignore unknown names. " +
        "Each route also includes modelHint (where that harness's real model catalog " +
        "is documented or listed live) and, when the operator declared one, models: " +
        "a list of known-good ids. For OpenAI-compatible endpoint routes, pass " +
        "listModels: <route id> to fetch the endpoint's live GET /models catalog " +
        "server-side and get the real ids back under liveModels — use these to pick " +
        "a real model up front or self-correct after a dispatch failure caused by an " +
        "unsupported model name.",
      inputSchema: usageInputShape,
    },
    async (args) => jsonText(await handleUsage(deps, args)),
  );
}

export type InvokeResult = { kind: "json"; data: unknown };

/**
 * Near-miss top-level keys are caught by `mcp/near-miss-guard.ts`, not here.
 *
 * This is where the gap used to be documented. The MCP SDK validates against
 * `z.object(dispatchInputShape)` before any code in this file runs, and zod
 * STRIPS unknown keys — so by the time a handler sees the arguments, a
 * misspelled key is already gone, and nothing in the registered-tool path can
 * see what the caller actually sent. `hints` is `.strict()`, which is why the
 * nested form was always rejected; the outer object cannot be, because MCP
 * carries `_meta` there.
 *
 * An acceptance pass measured what that cost: `safteyProfile: "read_only"` was
 * accepted in silence and the dispatch ran at the `workspace_edit` default,
 * writing a file. Asking for read-only by way of a typo got you write access,
 * while the HTTP surface refused the same input — one input, two opposite
 * answers, which is the class the parity suite exists to end.
 *
 * The guard wraps the CallTool handler the SDK installs and inspects the raw
 * arguments before delegating, so the SDK's routing, validation and `extra`
 * plumbing are untouched. Both surfaces now run the same check from
 * `near-miss.ts`, and `surface-parity.test.ts` asserts it on both.
 */

export async function invokeTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<InvokeResult> {
  if (name === "dispatch") {
    const parsed = z.object(dispatchInputShape).parse(args);
    return { kind: "json", data: await handleDispatch(deps, parsed) };
  }
  if (name === "retry_job") {
    const parsed = z.object(retryJobInputShape).parse(args ?? {});
    return { kind: "json", data: await handleRetryJob(deps, parsed) };
  }
  if (name === "workspace") {
    const parsed = z.object(workspaceInputShape).parse(args ?? {});
    return { kind: "json", data: await handleWorkspace(parsed) };
  }
  if (name === "cancel_job") {
    const parsed = z.object(cancelJobInputShape).parse(args ?? {});
    return { kind: "json", data: await handleCancelJob(parsed) };
  }
  if (name === "job_status") {
    const parsed = z.object(jobStatusInputShape).parse(args ?? {});
    return { kind: "json", data: await handleJobStatus(parsed) };
  }
  if (name === "usage") {
    const parsed = z.object(usageInputShape).parse(args ?? {});
    return { kind: "json", data: await handleUsage(deps, parsed) };
  }
  throw new Error(`Unknown tool: ${name} (valid: ${TOOL_NAMES.join(", ")})`);
}
