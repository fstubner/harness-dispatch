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

import { withMcpToolSpan } from "../observability/spans.js";
import type { RuntimeHolder, ConfigHotReloader } from "./config-hot-reload.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import { getAsyncJob, listAsyncJobs, startAsyncJobTracked, type JobStatus } from "../jobs.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { buildStatus, buildUsage, redactEndpointHost } from "../status.js";
import { endpointUrl } from "../dispatchers/openai-compatible.js";

const taskTypeSchema = z.enum(["execute", "plan", "review", "local"]);
const safetyProfileSchema = z.enum(["read_only", "workspace_edit", "full_auto"]);
const workspacePolicySchema = z.enum(["shared", "shared_locked", "copy", "git_worktree"]);
const routePolicySchema = z.enum(["standard", "local_only", "approval_required", "blocked"]);

const publicHintsSchema = z
  .object({
    model: z
      .string()
      .optional()
      .describe(
        "Preferred route or model name (e.g. a route id like 'codex' or a model like " +
          "'gpt-5.6-sol'). Routes that statically declare this model get a scoring " +
          "boost; the model is ALWAYS passed to the harness as an override either way, " +
          "even on a route that doesn't recognize it — NOT validated, so an unfamiliar " +
          "or misspelled name can still fail at dispatch time if the harness doesn't " +
          "support it. Check the response's routing.modelHintMatched: true means the " +
          "picked route actually declares this model; false means it was forwarded " +
          "blind and you should treat the result with more suspicion (or check why). " +
          "Call the `usage` tool first to see valid route ids, their default models, " +
          "and a modelHint per route pointing to where that harness's real model " +
          "catalog is documented (or how to list it) — use it to pick correctly up " +
          "front or self-correct after an unfamiliar-model failure. In fanout mode " +
          "this field is ignored entirely — use `models` (top-level, not under " +
          "hints) to select fanout candidates instead.",
      ),
    taskType: taskTypeSchema
      .optional()
      .describe(
        "Kind of work: 'execute' (write/modify code, run commands), 'plan' " +
          "(architecture/design, no edits), 'review' (critique code, no edits), 'local' " +
          "(trivial/mechanical — prefers free local endpoints). ALWAYS set this: when " +
          "omitted, per-task capability weighting and model escalation are disabled and " +
          "routing quality degrades.",
      ),
    preferLargeContext: z
      .boolean()
      .optional()
      .describe("Boost routes with very large context windows (for huge-codebase reads)."),
    safetyProfile: safetyProfileSchema
      .optional()
      .describe(
        "Maximum permission the routed harness may use: 'read_only' (inspect only — use " +
          "for review/plan), 'workspace_edit' (default; may edit files in workingDir), " +
          "'full_auto' (unrestricted shell — only when explicitly needed). Routes that " +
          "cannot honor the requested profile are skipped.",
      ),
    workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
    routePolicy: routePolicySchema
      .optional()
      .describe(
        "Operational routing policy: 'standard' (default), 'local_only' (never leave the " +
          "machine), 'approval_required' (BLOCKS non-local routes — it is a restriction, " +
          "not an approval grant), 'blocked' (dry-run: block everything).",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Override the background run's hard ceiling (milliseconds). Every dispatch " +
          "runs as a background job with a generous 60-minute default meant to catch a " +
          "genuinely hung process, not to cap a slow-but-healthy run — raise this for " +
          "a task you expect to run past an hour. This changes when the harness itself " +
          "gives up, not how long the inline grace window waits (that's `graceSeconds`).",
      ),
  })
  // STRICT, and this is a safety control, not tidiness.
  //
  // zod drops unknown keys by default. The same setting is spelled
  // `safety_profile` in config.yaml and `safetyProfile` here, so the obvious
  // slip was silently discarded — `hints: { safety_profile: "read_only" }` ran
  // a full_auto route at full_auto, while the correctly-spelled key refused
  // it. A caller asking to be restricted got no restriction and no warning.
  //
  // config.ts already treats this class as a root cause (it warns on ANY
  // unrecognised route key). This is the same fix at the MCP boundary, which
  // PRODUCT.md calls the actual product surface.
  .strict()
  .describe("Public routing hints.");

const workingDirDescription =
  "Absolute path to the project the task is about. EFFECTIVELY REQUIRED: when omitted, " +
  "the task runs in the router server's own working directory — almost never the " +
  "project you mean. Always pass the caller's project root.";

/** Inline grace window: how long `dispatch` waits for the background run before returning a pollable jobId instead of the full result. */
const DEFAULT_GRACE_SECONDS = 25;

/**
 * Cap on `files` per dispatch.
 *
 * Not a performance limit — each entry's parent directory becomes an
 * `--add-dir` grant on CLI routes (generic-cli.ts includedDirectories ->
 * {{file_dirs}}), so an unbounded list is an unbounded set of directories
 * handed to a coding agent. 64 is far above any real prompt and low enough
 * that a runaway caller is stopped at the boundary rather than at the CLI.
 */
/** The only jobId shape jobs.ts produces; shared by both tools. */
const JOB_ID_RE = /^job-\d+-[0-9a-f]{8}$/;

const MAX_CONTEXT_FILES = 64;

/**
 * Cap on prior jobs referenced by one dispatch.
 *
 * Each one costs a disk read and a slice of the delegate's context window.
 * jobs.ts caps the rendered TEXT as well; this bounds the work done to produce
 * it, so a caller naming hundreds of jobs is stopped at the boundary rather
 * than after the reads.
 */
const MAX_CONTEXT_JOBS = 16;

/**
 * Keys that mean nothing at the top level, trapped IN THE SCHEMA.
 *
 * `hints` is .strict(), so `hints: { safety_profile: ... }` is rejected — but
 * the OUTER object was still permissive, so moving the same key up one level
 * made it vanish silently instead:
 *
 *   hints.safetyProfile = read_only      -> honoured
 *   TOP-LEVEL safetyProfile = read_only  -> dropped, ran with write access
 *
 * WHY SCHEMA FIELDS AND NOT A GUARD FUNCTION. The MCP SDK validates arguments
 * against this shape in strip mode BEFORE the registered handler runs, so no
 * code inside a handler can ever see a misplaced key — it is already gone. A
 * previous version of this trap was a guard function, and it guarded a path
 * nothing shipped: the registered tools stripped the key silently while only
 * the test-only entry point rejected it. z.never() fields make the SDK's own
 * validation throw the guidance message on every surface that parses this
 * shape, and advertise as {"not":{}} in the tool's JSON schema, so a client
 * reading the schema sees the key as unacceptable rather than merely absent.
 *
 * Full .strict() on the outer object is deliberately NOT used: MCP clients may
 * attach their own fields (_meta and similar) and rejecting those would break
 * legitimate callers. Naming the specific misplaced keys closes the trap
 * without guessing at what else may legitimately arrive.
 */
function misplacedKeyTrap(message: string) {
  return z.never({ error: message }).optional().describe(message);
}

function hintKeyTrap(key: string) {
  return misplacedKeyTrap(
    `${key} belongs inside \`hints\`, not at the top level — e.g. hints: { ${key}: ... }. ` +
      `At the top level it does nothing, which for a safety setting means the dispatch ` +
      `runs with MORE access than you asked for.`,
  );
}

const misplacedTopLevelKeys = {
  safetyProfile: hintKeyTrap("safetyProfile"),
  routePolicy: hintKeyTrap("routePolicy"),
  taskType: hintKeyTrap("taskType"),
  preferLargeContext: hintKeyTrap("preferLargeContext"),
  timeoutMs: hintKeyTrap("timeoutMs"),
  model: misplacedKeyTrap(
    "model belongs inside `hints` for single mode — hints: { model: ... }. " +
      "In fanout mode use the top-level `models` array instead. At the top " +
      "level it does nothing.",
  ),
  escalate: misplacedKeyTrap(
    "escalate is not a dispatch field — escalation is configured per route in " +
      "config.yaml (escalate_model / escalate_on), not per call.",
  ),
};

const dispatchInputShape = {
  prompt: z
    .string()
    // Rejected here rather than at the harness. An empty prompt used to reach
    // a real CLI, which spawned, failed with its own usage message, and left a
    // consumed route call behind — a wasted dispatch for something the schema
    // can refuse for free.
    .min(1, "prompt must not be empty")
    // A NUL byte passed the schema and failed deep inside cross-spawn with
    // "The argument 'args[2]' must be a string without null bytes" — caught,
    // never a crash, and correctly not charged to the route's failure count,
    // but a raw Node internal message where a boundary rejection belongs.
    .refine((v) => !v.includes("\u0000"), "prompt must not contain NUL bytes")
    .describe(
      "The coding task or question. Every dispatch starts as a background job " +
        "immediately; if it finishes within the grace window you get the full result " +
        "inline, otherwise you get a jobId — check on it with the `job_status` tool. " +
        "Either way nothing is ever lost to a timeout.",
    ),
  mode: z
    .enum(["single", "fanout"])
    .optional()
    .default("single")
    .describe(
      "'single' routes to the one best-fit harness. 'fanout' runs the prompt on " +
        "MULTIPLE routes in parallel for independent perspectives — without `models` it " +
        "hits every eligible route and consumes quota on each; prefer passing an " +
        "explicit `models` list. Write-capable fanout requires workspacePolicy 'copy' " +
        "or 'git_worktree'. Fanout results that outlive the grace window each return " +
        "their own jobId to poll individually.",
    ),
  contextJobs: z
    .array(z.string().regex(JOB_ID_RE, "must look like job-<timestamp>-<8 hex chars>"))
    .max(MAX_CONTEXT_JOBS)
    .optional()
    .describe(
      "jobIds of earlier dispatches whose results this one should build on. Their " +
        "prompts and outputs are rendered into this prompt directly, so a follow-up " +
        "step can see what came before WITHOUT you reading it into your own context " +
        "and re-summarising it. Use this to chain delegated work.",
    ),
  files: z
    .array(z.string())
    .max(MAX_CONTEXT_FILES)
    .optional()
    .describe(
      `Absolute file paths to snapshot and include as context (max ` +
        `${MAX_CONTEXT_FILES}). A path outside workingDir is still sent, but ` +
        `for CLI routes its PARENT DIRECTORY is also granted to the agent via ` +
        `--add-dir, so it escapes an isolated workspace — the response carries ` +
        `a warning naming the directories when that happens.`,
    ),
  workingDir: z.string().optional().describe(workingDirDescription),
  workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
  hints: publicHintsSchema.optional(),
  ...misplacedTopLevelKeys,
  models: z
    .array(z.string())
    .optional()
    .describe(
      "Route ids or model names to fan out to (fanout mode only). This is the ONLY " +
        "field that narrows which routes fanout hits — `hints.model` is ignored " +
        "entirely in fanout mode (not used for selection, not forwarded to any " +
        "dispatch); it only does anything in single mode. Get valid ids from the " +
        "`usage` tool.",
    ),
  service: z
    .string()
    .optional()
    .describe(
      "Optional explicit route id to run (e.g. 'codex', 'cursor', 'local_inference' — " +
        "see the `usage` tool for valid ids). Omit to let the router pick. Single " +
        "mode only — incompatible with mode='fanout' (use `models` there).",
    ),
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .optional()
    .describe(
      `Seconds to wait for the run inline before returning a pollable jobId (default ` +
        `${DEFAULT_GRACE_SECONDS}). 0 returns the jobId immediately (pure async). ` +
        `Raising it past your MCP client's own request timeout buys nothing — the run ` +
        `continues in the background either way and the result stays collectible via ` +
        `\`job_status\`, so a client timeout on this call loses nothing but the inline reply.`,
    ),
} as const;

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

const jobStatusInputShape = {
  jobId: z
    .string()
    .regex(JOB_ID_RE, "jobId must look like job-<timestamp>-<8 hex chars>")
    .optional()
    .describe(
      "Check a previously started dispatch: returns partialOutput while running and " +
        "the full result once completed or failed. Omit to list every known background " +
        "dispatch instead.",
    ),
} as const;

export const TOOL_NAMES = ["dispatch", "job_status", "usage"] as const;

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

function workspacePolicyFromInput(input: {
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
    job.status.status === "orphaned"
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
    return {
      mode: "fanout",
      completed: true,
      results: [],
      skippedRoutes: [
        {
          route: "fanout",
          code: "workspace_isolation_required",
          message:
            "write-capable fanout requires workspacePolicy=copy or workspacePolicy=git_worktree; use read_only fanout or run single-route workspace_edit",
        },
      ],
    };
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

const usageInputShape = {
  listModels: z
    .string()
    .optional()
    .describe(
      "Route id of an OpenAI-compatible endpoint (e.g. an entry from `endpoints:` " +
        "like nvidia_nim or ollama). If the route declares a `models:` list in " +
        "config, that operator-curated list is returned as-is — declaring it is " +
        "how you override live discovery (e.g. to pin specific ids, or the " +
        "endpoint's /models listing is noisy/untrustworthy). Otherwise fetches the " +
        "endpoint's live GET /models catalog server-side — the API key never " +
        "leaves the router. Either way, results come back under `liveModels`. CLI " +
        "harness routes don't support this; use their modelHint instead.",
    ),
};

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

export async function invokeTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<InvokeResult> {
  if (name === "dispatch") {
    const parsed = z.object(dispatchInputShape).parse(args);
    return { kind: "json", data: await handleDispatch(deps, parsed) };
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
