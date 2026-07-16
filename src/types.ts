/**
 * Core types for harness-router.
 *
 * These are the cross-cutting types used by dispatchers, the router, the
 * quota tracker, and the MCP surface. Downstream modules (R2/R3/R4) import
 * from here.
 */

export type TaskType = "execute" | "plan" | "review" | "local" | "";

export type ThinkingLevel = "low" | "medium" | "high";

export type SafetyProfile = "read_only" | "workspace_edit" | "full_auto";

export type RoutePolicy = "standard" | "local_only" | "approval_required" | "blocked";

export type BillingProvider =
  | "anthropic"
  | "openai"
  | "cursor"
  | "google"
  | "local"
  | "custom";

export type BillingSurface =
  | "claude_code"
  | "claude_agent_sdk"
  | "anthropic_api"
  | "codex_cli"
  | "codex_sdk"
  | "openai_api"
  | "cursor_agent_cli"
  | "antigravity_cli"
  | "gemini_api"
  | "vertex_ai"
  | "openai_compatible"
  | "local_endpoint"
  | "custom";

export type AuthSource =
  | "product_login"
  | "api_key"
  | "oauth_session"
  | "local_network"
  | "configured_endpoint"
  | "unknown";

export type BillingKind =
  | "local_compute"
  | "included_plan_usage"
  | "included_plan_then_flexible_credits"
  | "included_credit_then_optional_overage"
  | "included_usage_then_on_demand"
  | "metered_api"
  | "free_quota"
  | "unknown";

export type BillingConfidence = "documented" | "inferred" | "unknown" | "unsupported";

export type EndpointMode =
  | "provider_cloud"
  | "direct_openai_compatible"
  | "harness_native_endpoint";

export type EndpointProvider =
  | "ollama"
  | "lmstudio"
  | "openai_compatible"
  | "anthropic_gateway"
  | "gemini_proxy"
  | "custom";

export type WireProtocol =
  | "openai_chat_completions"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "provider_native"
  | "unknown";

export type WorkspacePolicy =
  | "shared"
  | "shared_locked"
  | "git_worktree"
  | "copy";

export type WorkspaceChangeKind = "added" | "modified" | "deleted";

export interface WorkspaceFileChange {
  path: string;
  kind: WorkspaceChangeKind;
}

export interface WorkspaceRun {
  policy: WorkspacePolicy;
  originalWorkingDir: string;
  effectiveWorkingDir: string;
  isolated: boolean;
  securityBoundary:
    | "none"
    | "project_state"
    | "project_state_and_process_cwd";
  workspaceRoot?: string;
  changedFiles?: WorkspaceFileChange[];
  diffSummary?: string;
  cleanupHint?: string;
  notes?: string[];
}

export interface RouteBilling {
  provider: BillingProvider;
  surface: BillingSurface;
  authSource: AuthSource;
  kind: BillingKind;
  paidUsagePossible: boolean;
  allowPaidUsage: boolean;
  paidUsageRequiresOptIn: boolean | "unknown";
  confidence: BillingConfidence;
  notes?: string;
}

export interface RouteSkip {
  route: string;
  code:
    | "disabled"
    | "no_dispatcher"
    | "unavailable"
    | "circuit_broken"
    | "paid_blocked"
    | "unknown_billing"
    | "route_policy"
    | "approval_required"
    | "safety_incompatible"
    | "workspace_isolation_required";
  message: string;
}

export interface DispatchResult {
  output: string;
  service: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string>;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  skippedRoutes?: RouteSkip[];
  workspace?: WorkspaceRun;
}

export interface QuotaInfo {
  service: string;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  source: "headers" | "api" | "unknown";
}

/**
 * One line-matching rule for `outputMode: "jsonl_stream"` (see below). A
 * parsed JSON line is tested against `when` (every listed dotted field path
 * must equal the given string); on match, `emit` says what to do with it.
 * Rules are checked in order per line; a line can match more than one rule
 * (e.g. a line can carry both a text field and a usage field).
 */
export interface CliEventRule {
  /** Dotted field path -> exact string it must equal, e.g. {"type": "thinking"}. */
  when: Record<string, string>;
  emit: "text" | "tool_use" | "thinking" | "usage";
  /** For emit: "text" — dotted path to the text; becomes the run's output-so-far. */
  textField?: string;
  /** For emit: "tool_use". */
  nameField?: string;
  inputField?: string;
  /** For emit: "thinking". */
  chunkField?: string;
  /** For emit: "usage" — dotted paths, checked in order, first present wins. */
  inputTokenFields?: string[];
  outputTokenFields?: string[];
}

/**
 * Config-driven CLI invocation template — lets a subprocess-based CLI
 * harness be added or redefined with zero bespoke TypeScript, the same way
 * `endpoints:` already does for HTTP-based ones. Covers everything that
 * turned out to be genuinely templatable across the 4 built-in harnesses:
 * prompt input style, working-dir flag, model flag, per-safety-profile args,
 * API-key env injection, per-file directory flags, and (via `eventRules`) the
 * same tool_use/thinking/usage streaming-event semantics Codex's dispatcher
 * hand-wrote — expressed declaratively instead of imperatively.
 */
export interface CliProtocolConfig {
  /** How the prompt reaches the CLI. */
  promptInput:
    // position "early" (default) places the flag right after leadingArgs
    // (e.g. `claude -p "<prompt>" --output-format json ...`); "late" places
    // it where "positional" mode's prompt goes, after everything else (e.g.
    // `agy --model x --mode accept-edits --print "<prompt>"`).
    | { mode: "flag"; flag: string; position?: "early" | "late" }
    | { mode: "positional" } // appended as the last bare argument
    | { mode: "stdin"; sentinelArg?: string }; // written to stdin; sentinelArg (e.g. "-") appended last if given
  /**
   * Omit to rely on the subprocess's cwd only (no explicit flag, e.g. Claude
   * Code). `extraArgsWhenSet` appends more static args only when workingDir
   * is actually non-empty (e.g. Codex's `--skip-git-repo-check`).
   */
  workingDir?: { flag: string; extraArgsWhenSet?: string[] };
  /**
   * Args placed first, right after the CLI itself — for a leading subcommand
   * like Codex's `exec` (as opposed to `extraArgs`, appended among the flags;
   * splitting the two only matters when a CLI needs `<bin> <subcommand>
   * [flags...]` shape rather than `<bin> [flags...]`).
   */
  leadingArgs?: string[];
  /**
   * Flag repeated once per unique file directory (e.g. Antigravity's
   * `--add-dir <dir>`) — computed the same way for every harness: unique
   * parent directories of absolute `files` entries, excluding workingDir
   * itself. Omit if the CLI has no such concept.
   */
  fileDirsFlag?: string;
  /** Header/bullet used when appending a file list to the prompt text (all 4 built-ins do this, with slightly different wording). Omit fileListHeader to skip the append entirely. */
  fileListHeader?: string;
  fileListBullet?: string;
  /** Omit if the CLI has no model-override flag. Falls back to the route's static `model:` when no per-call override is given, same as the 4 built-ins. */
  modelFlag?: string;
  /** Static args always appended, e.g. ["--output-format", "json"] or ["--trust"]. */
  extraArgs?: string[];
  /** Extra args appended per requested safety profile, e.g. permission-mode flags. */
  safetyArgs?: Partial<Record<SafetyProfile, string[]>>;
  /**
   * Env var to set to the route's configured `api_key` when present (e.g.
   * "CURSOR_API_KEY", "OPENAI_API_KEY"). If unset in config AND the var is
   * already present in the parent environment, it's explicitly cleared for
   * the child — matches the built-ins' "never leak an ambient key into a
   * subscription-auth call" behavior.
   */
  apiKeyEnvVar?: string;
  /**
   * How to turn stdout into a DispatchResult.
   * - "text": raw stdout is the output, verbatim.
   * - "json_field": parse stdout as one JSON object once the process exits;
   *   `outputFields` (in priority order, dotted paths supported) picks which
   *   field holds the answer.
   * - "jsonl_stream": each stdout line is parsed as JSON as it arrives.
   *   Without `eventRules`, falls back to concatenating `outputFields` from
   *   every line (a poor-man's approximation). WITH `eventRules`, matches
   *   Codex's real mid-run tool_use/thinking event surfacing and usage
   *   aggregation, declaratively.
   */
  outputMode: "text" | "json_field" | "jsonl_stream";
  /** Candidate field names to check, in priority order, for json_field/jsonl_stream (dotted paths supported). */
  outputFields?: string[];
  /**
   * Token-usage extraction for "text"/"json_field" modes (jsonl_stream uses
   * eventRules' emit: "usage" instead). Applies to the single parsed JSON
   * blob; both fields must resolve to a number for tokensUsed to be set.
   */
  usageFields?: { inputFields: string[]; outputFields: string[] };
  /** jsonl_stream only — see CliEventRule. */
  eventRules?: CliEventRule[];
  /**
   * Default true (matches most CLIs, and Cursor specifically): success
   * requires BOTH exitCode === 0 AND a non-empty parsed output — an exit-0
   * run with nothing parseable is treated as a failure. Set false to match
   * Claude Code / Codex / Antigravity's more lenient contract: success is
   * exitCode === 0 alone, and the output falls back to raw stdout/stderr
   * text when the configured parsing yields nothing.
   */
  successRequiresOutput?: boolean;
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  type: "cli" | "openai_compatible";
  harness?: string;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  tier: number;
  weight: number;
  cliCapability: number;
  leaderboardModel?: string;
  thinkingLevel?: ThinkingLevel;
  escalateModel?: string;
  escalateOn: TaskType[];
  capabilities: Partial<Record<"execute" | "plan" | "review", number>>;
  /**
   * Maximum output tokens the model can produce in a single dispatch.
   * Callers (Planners, Workers, Reconcilers) use this to size work so it fits
   * without mid-call truncation. A value of `undefined` means "unknown /
   * assume the provider default" — callers that need to chunk conservatively
   * should treat absence as a low bound.
   */
  maxOutputTokens?: number;
  /**
   * Context window (input + output) in tokens. Used by the
   * `preferLargeContext` route hint and by planners sizing up prompt payloads.
   * Advertised by the provider; may be model-specific when `escalateModel` is
   * in effect — consult the resolved model at dispatch time.
   */
  maxInputTokens?: number;
  provider?: BillingProvider;
  surface?: BillingSurface;
  authSource?: AuthSource;
  billingKind?: BillingKind;
  paidUsagePossible?: boolean;
  allowPaidUsage?: boolean;
  billingConfidence?: BillingConfidence;
  billingNotes?: string;
  safetyProfile?: SafetyProfile;
  endpointMode?: EndpointMode;
  endpointProvider?: EndpointProvider;
  wireProtocol?: WireProtocol;
  workspacePolicy?: WorkspacePolicy;
  /** Required when `harness: "generic"` — see CliProtocolConfig. Ignored otherwise. */
  protocol?: CliProtocolConfig;
  /**
   * Per-service dispatch timeout override in milliseconds. Every dispatcher
   * hard-codes its own default (10 minutes for CLI harnesses, 2 minutes for
   * openai_compatible) with no way to raise it — a long-running review or
   * audit routed to a CLI harness gets killed and its result discarded at
   * exactly the default, regardless of how the caller invoked the task
   * (`code` or `job`). Set this to raise (or lower) the ceiling for a
   * specific route; a per-call `hints.timeoutMs` takes precedence over this.
   */
  timeoutMs?: number;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  disabled?: readonly string[];
  /**
   * Config entries that were silently ignored rather than failing to load —
   * a disabled:/overrides: name that doesn't match any auto-detected route
   * (e.g. left over from before the claude_code -> claude_code_cli-style
   * rename), or a clis: entry with a missing/unrecognized harness or name.
   * Surfaced by `doctor`/`configure` so a stale or typo'd config doesn't go
   * unnoticed forever.
   */
  configWarnings?: readonly string[];
}

export interface RoutingDecision {
  service: string;
  tier: number;
  quotaScore: number;
  qualityScore: number;
  cliCapability: number;
  capabilityScore: number;
  taskType: TaskType;
  model: string | undefined;
  /**
   * Set only when hints.model was provided. true if it matched something
   * this route statically declares (model/leaderboardModel/escalateModel/
   * route name) — false if it was passed through to the dispatcher "blind"
   * because nothing recognized it, which can still work (CLIs often accept
   * arbitrary --model values) or can fail at dispatch time with the
   * harness's own rejection. hints.model is unvalidated by design (see the
   * `code` tool's own description) — this field is how a caller
   * distinguishes "the router picked exactly what I asked for" from "I
   * might have a typo" without guessing from `model` alone.
   */
  modelHintMatched?: boolean;
  elo: number | undefined;
  finalScore: number;
  reason: string;
  skippedRoutes?: RouteSkip[];
  safetyProfile?: SafetyProfile;
  effectiveSafetyProfile?: SafetyProfile;
  billing?: RouteBilling;
  workspacePolicy?: WorkspacePolicy;
}

export interface RouteHints {
  model?: string;
  service?: string;
  preferLargeContext?: boolean;
  taskType?: TaskType;
  harness?: string;
  safetyProfile?: SafetyProfile;
  workspacePolicy?: WorkspacePolicy;
  routePolicy?: RoutePolicy;
  /** Per-call dispatch timeout override in milliseconds. See ServiceConfig.timeoutMs. */
  timeoutMs?: number;
}

export type DispatcherEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
