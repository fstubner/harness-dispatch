/**
 * MCP tool registry for harness-router.
 *
 * The public MCP surface is intentionally small: one `code` tool for both
 * single-route and fanout routing. Status is exposed as resources so clients
 * can inspect state without adding more tool choices.
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
import { withMcpToolSpan } from "../observability/spans.js";
import type { RuntimeHolder, ConfigHotReloader } from "./config-hot-reload.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import { getAsyncJob, listAsyncJobs, startAsyncJob } from "../jobs.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { buildStatus, buildUsage } from "../status.js";
import { resolveWorkingDir, workingDirWarning } from "../working-dir.js";

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
          "front or self-correct after an unfamiliar-model failure.",
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
  })
  .describe("Public routing hints.");

const workingDirDescription =
  "Absolute path to the project the task is about. EFFECTIVELY REQUIRED: when omitted, " +
  "the task runs in the router server's own working directory — almost never the " +
  "project you mean. Always pass the caller's project root.";

const codeInputShape = {
  mode: z
    .enum(["single", "fanout"])
    .optional()
    .default("single")
    .describe(
      "'single' routes to one best harness and blocks until it finishes — fine for " +
        "quick (under ~1-2 min) tasks. For anything slower, prefer the `job` tool instead " +
        "so the MCP call doesn't time out mid-run. 'fanout' runs the prompt on MULTIPLE " +
        "routes in parallel for independent perspectives — without `models` it hits every " +
        "eligible route and consumes quota on each; prefer passing an explicit `models` " +
        "list. Write-capable fanout requires workspacePolicy 'copy' or 'git_worktree'.",
    ),
  prompt: z.string().describe("The coding task or question."),
  files: z.array(z.string()).optional().describe("Absolute file paths to include as context."),
  workingDir: z.string().optional().describe(workingDirDescription),
  workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
  hints: publicHintsSchema.optional(),
  models: z
    .array(z.string())
    .optional()
    .describe(
      "Route ids or model names to fan out to (fanout mode). Get valid ids from the " +
        "`usage` tool.",
    ),
} as const;

const jobInputShape = {
  action: z.enum(["start", "get", "list"]).describe("Async job action."),
  prompt: z.string().optional().describe("The coding task or question for action=start."),
  files: z
    .array(z.string())
    .optional()
    .describe("Absolute file paths to snapshot and include as context."),
  workingDir: z.string().optional().describe(workingDirDescription),
  workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
  hints: publicHintsSchema.optional(),
  service: z
    .string()
    .optional()
    .describe(
      "Optional explicit route id to run (e.g. 'codex', 'cursor', 'local_inference' — " +
        "see the `usage` tool for valid ids). Omit to let the router pick.",
    ),
  jobId: z.string().optional().describe("Job id for action=get."),
} as const;

export const TOOL_NAMES = ["code", "job", "usage"] as const;

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
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  capabilityScore: number;
  qualityScore: number;
  elo?: number;
  workspace?: WorkspaceRun;
}

export type CodeResponse =
  | ({ mode: "single" } & RouteResponse)
  | { mode: "fanout"; results: FanoutItem[]; skippedRoutes?: RouteSkip[]; warning?: string };

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

async function runSingle(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof codeInputShape>>,
  extra?: ToolExtra,
): Promise<CodeResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const progressToken = extra?._meta?.progressToken;
  const hints = toHints(input.hints);
  const workspacePolicy = workspacePolicyFromInput(input);
  if (workspacePolicy !== undefined) hints.workspacePolicy = workspacePolicy;
  const resolvedWorkingDir = resolveWorkingDir(input.workingDir);
  const { workingDir } = resolvedWorkingDir;
  const warning = workingDirWarning(resolvedWorkingDir);
  const files = input.files ?? [];

  if (progressToken === undefined) {
    const { result, decision } = await state.router.route(input.prompt, files, workingDir, {
      hints,
      maxFallbacks: 2,
    });
    return { mode: "single", ...routeResponse(result, decision, warning) };
  }

  const counter = { value: 0 };
  let finalResult: DispatchResult | null = null;
  let finalDecision: import("../types.js").RoutingDecision | null = null;
  for await (const { event, decision } of state.router.stream(input.prompt, files, workingDir, {
    hints,
    maxFallbacks: 2,
  })) {
    if (decision) finalDecision = decision;
    await emitProgress(extra, progressToken, counter, event, decision?.service);
    if (event.type === "completion") finalResult = event.result;
  }
  const result =
    finalResult ??
    ({
      output: "",
      service: "none",
      success: false,
      error: "Router stream ended without a completion event",
    } satisfies DispatchResult);
  return { mode: "single", ...routeResponse(result, finalDecision, warning) };
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

async function runFanout(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof codeInputShape>>,
  extra?: ToolExtra,
): Promise<CodeResponse> {
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
  const taskType: TaskType = hints.taskType ?? "plan";
  const requested = new Set(input.models ?? []);
  const progressToken = extra?._meta?.progressToken;
  const counter = { value: 0 };
  const skippedRoutes: RouteSkip[] = [];

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
  const resolvedWorkingDir = resolveWorkingDir(input.workingDir);
  const { workingDir } = resolvedWorkingDir;
  const warning = workingDirWarning(resolvedWorkingDir);

  const results = await Promise.all(
    candidates.map(async (routeName): Promise<FanoutItem> => {
      const svc = state.config.services[routeName]!;
      const cap = svc.capabilities[taskType as "execute" | "plan" | "review"] ?? 1.0;
      const quality = await state.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const t0 = Date.now();
      let result: DispatchResult;
      if (progressToken !== undefined) {
        let captured: DispatchResult | null = null;
        for await (const { event } of state.router.streamTo(routeName, prompt, files, workingDir, {
          ...(hints.safetyProfile !== undefined ? { safetyProfile: hints.safetyProfile } : {}),
          ...(hints.workspacePolicy !== undefined ? { workspacePolicy: hints.workspacePolicy } : {}),
          ...(hints.routePolicy !== undefined ? { routePolicy: hints.routePolicy } : {}),
          ...(hints.taskType !== undefined ? { taskType: hints.taskType } : {}),
        })) {
          await emitProgress(extra, progressToken, counter, event, routeName);
          if (event.type === "completion") captured = event.result;
        }
        result =
          captured ??
          ({
            output: "",
            service: routeName,
            success: false,
            error: "Stream ended without completion",
          } satisfies DispatchResult);
      } else {
        result = (
          await state.router.routeTo(routeName, prompt, files, workingDir, {
            ...(hints.safetyProfile !== undefined ? { safetyProfile: hints.safetyProfile } : {}),
            ...(hints.workspacePolicy !== undefined ? { workspacePolicy: hints.workspacePolicy } : {}),
            ...(hints.routePolicy !== undefined ? { routePolicy: hints.routePolicy } : {}),
            ...(hints.taskType !== undefined ? { taskType: hints.taskType } : {}),
          })
        ).result;
      }

      const item: FanoutItem = {
        route: routeName,
        success: result.success,
        output: result.output,
        durationMs: Date.now() - t0,
        capabilityScore: cap,
        qualityScore: quality.qualityScore,
      };
      if (result.error !== undefined) item.error = result.error;
      if (result.workspace !== undefined) item.workspace = result.workspace;
      if (quality.elo !== null) item.elo = quality.elo;
      return item;
    }),
  );

  results.sort((a, b) => {
    if (a.success !== b.success) return a.success ? -1 : 1;
    return b.capabilityScore - a.capabilityScore;
  });
  const response: {
    mode: "fanout";
    results: FanoutItem[];
    skippedRoutes?: RouteSkip[];
    warning?: string;
  } = {
    mode: "fanout",
    results,
  };
  if (skippedRoutes.length > 0) response.skippedRoutes = skippedRoutes;
  if (warning !== undefined) response.warning = warning;
  return response;
}

export async function handleCode(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof codeInputShape>>,
  extra?: ToolExtra,
): Promise<CodeResponse> {
  return withMcpToolSpan({ "tool.name": "code" }, async () => {
    if ((input.mode ?? "single") === "fanout") {
      return runFanout(deps, input, extra);
    }
    return runSingle(deps, input, extra);
  });
}

async function handleJob(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof jobInputShape>>,
): Promise<unknown> {
  return withMcpToolSpan({ "tool.name": "job" }, async () => {
    switch (input.action) {
      case "start": {
        if (!input.prompt) throw new Error("job action=start requires prompt");
        const hints = toHints(input.hints);
        const workspacePolicy = workspacePolicyFromInput(input);
        if (workspacePolicy !== undefined) hints.workspacePolicy = workspacePolicy;
        return startAsyncJob(deps, {
          prompt: input.prompt,
          files: input.files ?? [],
          ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
          hints,
          ...(input.workspacePolicy !== undefined ? { workspacePolicy: input.workspacePolicy } : {}),
          ...(input.service !== undefined ? { service: input.service } : {}),
        });
      }
      case "get":
        if (!input.jobId) throw new Error("job action=get requires jobId");
        return getAsyncJob(input.jobId);
      case "list":
        return listAsyncJobs();
    }
  });
}

async function handleUsage(deps: ToolDeps) {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const status = await buildStatus(
    state.config,
    state.dispatchers,
    state.quota,
    state.router,
    state.leaderboard,
  );
  return buildUsage(status);
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "code",
    {
      title: "Route code task",
      description:
        "Delegate a bounded coding task (implement, fix, review, plan, or investigate — " +
        "not general Q&A) to the best-fit harness (Claude Code, Codex, Cursor, " +
        "Antigravity, or a configured endpoint), or fan out to several for independent " +
        "opinions. BLOCKS until the harness finishes — only use for tasks you expect to " +
        "finish in under ~1-2 minutes; for anything slower (most real coding work), use " +
        "the `job` tool instead so the call can't time out mid-run. Always pass " +
        "`workingDir` (the caller's project root) and `hints.taskType`.",
      inputSchema: codeInputShape,
    },
    async (args, extra) => jsonText(await handleCode(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "job",
    {
      title: "Start or check an async route job",
      description:
        "Preferred way to delegate coding work that may take minutes. action=start " +
        "returns a jobId immediately (the work runs in the background) along with " +
        "nextPollSeconds/instructions telling you how long to wait. action=get with that " +
        "jobId returns partialOutput while still running, and the full result once " +
        "status is 'completed' or 'failed' — nothing is lost if you poll late. " +
        "action=list shows all known jobs. Always pass `workingDir` (the caller's " +
        "project root) and `hints.taskType` on start.",
      inputSchema: jobInputShape,
    },
    async (args) => jsonText(await handleJob(deps, args)),
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
        "Each route also includes modelHint: a pointer to where that harness's real model " +
        "catalog is documented, or a command/endpoint to list it live (e.g. run " +
        "`cursor-agent --list-models`, or GET {baseUrl}/models for OpenAI-compatible " +
        "endpoints) — use it to pick a real model up front or self-correct after a " +
        "dispatch failure caused by an unsupported model name.",
      inputSchema: {},
    },
    async () => jsonText(await handleUsage(deps)),
  );
}

export type InvokeResult = { kind: "json"; data: unknown };

export async function invokeTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<InvokeResult> {
  if (name === "code") {
    const parsed = z.object(codeInputShape).parse(args);
    return { kind: "json", data: await handleCode(deps, parsed) };
  }
  if (name === "job") {
    const parsed = z.object(jobInputShape).parse(args);
    return { kind: "json", data: await handleJob(deps, parsed) };
  }
  if (name === "usage") {
    return { kind: "json", data: await handleUsage(deps) };
  }
  throw new Error(`Unknown tool: ${name}`);
}
