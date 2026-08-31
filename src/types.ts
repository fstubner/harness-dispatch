/**
 * Core types for harness-dispatch.
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
  /**
   * Digest of this file as it stood when the dispatch STARTED — the base the
   * agent's edit was made against. Absent for an added file (there was
   * nothing) and for policies that have a real base commit instead.
   *
   * A `copy` patch has no commit to anchor to, so without this there is no way
   * to tell "the project has not moved" from "the project has moved and my
   * patch is about to overwrite it". Two concurrent dispatches touching one
   * file ended with the second silently reverting the first's COMMITTED work:
   * git apply cannot conflict when the patch's context is the current file.
   *
   * Computed over content with CRLF collapsed to LF, so a checkout whose eol
   * settings rewrote a file on the way in is not mistaken for a real edit.
   */
  baseHash?: string;
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
  /**
   * For `git_worktree`: the commit the worktree was created from.
   *
   * Load-bearing for producing a correct patch. A worktree starts at HEAD,
   * NOT at the caller's working tree, so diffing the worktree against the
   * original directory of a dirty project reports the user's own uncommitted
   * work as deletions — and applying that patch would destroy it. The agent's
   * changes are worktree-vs-this-commit, and nothing else.
   */
  baseCommit?: string;
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
    | "cannot_execute"
    | "workspace_isolation_required";
  message: string;
}

export interface DispatchResult {
  output: string;
  service: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
  /**
   * The INPUT was refused before the route was asked to do anything.
   *
   * Distinct from a failure, because it says nothing about whether the route
   * works: the same input fails identically on every route of that shape, and
   * a fresh one would fail again. Not counted toward `usage` or the circuit
   * breaker — an over-long prompt cascading through three routes otherwise
   * recorded three calls and three failures, and three such dispatches opened
   * healthy routes for 300 seconds.
   */
  inputRejected?: boolean;
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string>;
  /**
   * Milliseconds the HARNESS ATTEMPT took — the subprocess or HTTP call
   * alone. A job's status.durationMs is the end-to-end figure (routing,
   * workspace prep, lock waits); the two differ by design.
   */
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
 * One line-matching rule for `output.mode: "jsonl_stream"` (see below). A
 * parsed JSON line is tested against `when` (every listed dotted field path
 * must equal the given string); on match, `emit` says what to do with it.
 * Rules are checked in order per line; a line can match more than one rule
 * (e.g. a line can carry both a text field and a usage field).
 */
export interface CliEventRule {
  /** Dotted field path -> exact string it must equal, e.g. {"type": "thinking"}. */
  when: Record<string, string>;
  emit: "text" | "tool_use" | "thinking" | "usage" | "error";
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
  /**
   * For emit: "error" — dotted path to the human-readable error message
   * (e.g. Codex's real `{"type":"error","message":"You've hit your usage
   * limit..."}` frame). Without a rule for this, a structured error frame
   * is silently invisible to the dispatcher — it falls through to raw
   * stdout/stderr text heuristics, which lose the message entirely if
   * stderr happens to carry unrelated CLI banner noise (confirmed
   * 2026-07-24: Codex's real stderr is just "Reading additional input from
   * stdin...", which was shadowing the actual JSON error in stdout).
   */
  messageField?: string;
}

/**
 * Config-driven CLI invocation template — lets a subprocess-based CLI
 * harness be added or redefined with zero bespoke TypeScript, the same way
 * `endpoints:` already does for HTTP-based ones.
 *
 * `args` is a literal command-line argument list, written the same way
 * you'd type it by hand. A handful of reserved `{{name}}` tokens are
 * substituted (or expanded to zero or more real tokens) at dispatch time;
 * everything else passes through verbatim:
 *
 *   {{prompt}}       the prompt text (one token) — omitted if `stdin: true`
 *   {{model}}        [model.flag, value] if a model is set, else nothing
 *   {{safety}}       safety[requested profile] (zero or more tokens)
 *   {{working_dir}}  [workingDir.flag, dir, ...extraArgsWhenSet] if set, else nothing
 *   {{file_dirs}}    [fileDirs.flag, dir] repeated once per included file's directory
 *   {{native_args}}  endpointNativeArgs[endpoint_provider], only when this route
 *                    is dispatched as endpoint_mode: harness_native_endpoint
 *
 * e.g. Claude Code's real invocation is just:
 *   args: ["-p", "{{prompt}}", "--output-format", "json", "{{safety}}", "{{model}}"]
 */
export interface CliProtocolConfig {
  args: string[];
  /** Write the prompt to the child's stdin instead of substituting {{prompt}} into args. */
  stdin?: boolean;
  /** Omit if the CLI has no model-override flag. Falls back to the route's static `model:` when no per-call override is given. */
  model?: { flag: string };
  /**
   * Omit to rely on the subprocess's cwd only (no explicit flag, e.g. Claude
   * Code). `extraArgsWhenSet` appends more static args only when workingDir
   * is actually non-empty (e.g. Codex's `--skip-git-repo-check`).
   * `fallback: "home"` substitutes the user's home directory when the
   * caller passes an empty workingDir and this CLI has no "just use the
   * current directory" default of its own (e.g. Cursor).
   */
  workingDir?: { flag: string; extraArgsWhenSet?: string[]; fallback?: "home" };
  /**
   * Flag repeated once per unique file directory (e.g. Antigravity's
   * `--add-dir <dir>`) — computed the same way for every harness: unique
   * parent directories of absolute `files` entries, excluding workingDir
   * itself. Omit if the CLI has no such concept.
   */
  fileDirs?: { flag: string };
  /** Args appended per requested safety profile (permission-mode flags etc.), via {{safety}}. */
  safety?: Partial<Record<SafetyProfile, string[]>>;
  /**
   * Env var to set to the route's configured `api_key` when present (e.g.
   * "CURSOR_API_KEY", "OPENAI_API_KEY"). If unset in config AND the var is
   * already present in the parent environment, it's explicitly cleared for
   * the child — matches the built-ins' "never leak an ambient key into a
   * subscription-auth call" behavior.
   */
  apiKeyEnvVar?: string;
  /** Header/bullet used when appending a file list to the prompt text. Omit fileListHeader to skip the append entirely. */
  fileListHeader?: string;
  fileListBullet?: string;
  /** How to turn stdout into a DispatchResult. */
  output: {
    /**
     * - "text": raw stdout is the output, verbatim.
     * - "json_field": parse stdout as one JSON object once the process
     *   exits; `fields` (in priority order, dotted paths supported) picks
     *   which field holds the answer.
     * - "jsonl_stream": each stdout line is parsed as JSON as it arrives.
     *   Without `eventRules`, falls back to concatenating `fields` from
     *   every line (a poor-man's approximation). WITH `eventRules`,
     *   supports real mid-run tool_use/thinking event surfacing and usage
     *   aggregation, declaratively (see CliEventRule).
     */
    mode: "text" | "json_field" | "jsonl_stream";
    /** Candidate field names to check, in priority order, for json_field/jsonl_stream (dotted paths supported). */
    fields?: string[];
    /**
     * Token-usage extraction for "text"/"json_field" modes (jsonl_stream
     * uses eventRules' emit: "usage" instead).
     */
    /**
     * `input`/`output` are dotted paths checked in order, FIRST PRESENT WINS —
     * they name the same quantity under different vendor spellings
     * (`usage.input_tokens` vs `usage.prompt_tokens`), so summing them would
     * double-count.
     *
     * `inputExtra`/`outputExtra` are the opposite: every listed path that is
     * present is SUMMED ON TOP of the primary. Anthropic splits input across
     * three sibling fields — `input_tokens` counts only the uncached remainder,
     * with the bulk in `cache_creation_input_tokens` and
     * `cache_read_input_tokens`. Reading the first alone reported 2 tokens for
     * a turn that consumed 55,213, and `usage` totals were meaningless as a
     * result. There is no vendor field carrying the total, so it has to be
     * added up here.
     */
    usage?: { input: string[]; output: string[]; inputExtra?: string[]; outputExtra?: string[] };
    /** jsonl_stream only — see CliEventRule. */
    eventRules?: CliEventRule[];
    /**
     * Explicit error detection for "text"/"json_field" modes (jsonl_stream
     * uses eventRules' emit: "error" instead) — a CLI can exit 0 while its
     * JSON body reports an API-level failure (confirmed 2026-07-24: Claude
     * Code's `is_error`/`api_error_status` fields on an otherwise-0-exit
     * response). `field` is a dotted path to a boolean; when true, the
     * dispatch is forced to success: false regardless of exit code or
     * `successRequiresOutput`, with the message from `messageFields`
     * (falls back to `fields` if omitted).
     */
    error?: { field: string; messageFields?: string[] };
  };
  /**
   * Default true (matches most CLIs, and Cursor specifically): success
   * requires BOTH exitCode === 0 AND a non-empty parsed output — an exit-0
   * run with nothing parseable is treated as a failure. Set false to match
   * Claude Code / Codex / Antigravity's more lenient contract: success is
   * exitCode === 0 alone, and the output falls back to raw stdout/stderr
   * text when the configured parsing yields nothing.
   */
  successRequiresOutput?: boolean;
  /**
   * Extra args to prepend when this route is configured with
   * `endpoint_mode: harness_native_endpoint` against a matching
   * `endpoint_provider` (e.g. Codex's `--oss --local-provider ollama`) —
   * config-dependent, not a fixed property of any particular harness.
   */
  endpointNativeArgs?: Partial<Record<EndpointProvider, string[]>>;
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
  /**
   * The safety level this route ACTUALLY runs at regardless of what's
   * requested — a capability floor, not a preference. E.g. Cursor's print
   * mode always has write+shell capability, so its shipped entry declares
   * `effective_safety: full_auto` and the route is skipped for stricter
   * requests. Declared in config (shipped or user), not hardcoded per
   * harness anywhere in code.
   */
  /**
   * Capability floor: what the harness ACTUALLY runs at, regardless of what
   * was requested.
   *
   * Either one profile for every request, or a map from requested profile to
   * the floor that applies to it. The map exists because a CLI can have
   * genuinely different capability per mode: cursor-agent's `--mode plan` is
   * read-only (verified — it declined to create or overwrite files), while its
   * default print mode has write AND shell. One value cannot say that, so the
   * route was pinned at full_auto and skipped every ordinary request.
   */
  effectiveSafety?: SafetyProfile | Partial<Record<SafetyProfile, SafetyProfile>>;
  /**
   * Operator-declared known-good model ids for this route (`models:` in
   * config) — surfaced verbatim in status/usage so a calling agent can pick
   * one without guessing. Optional and advisory: hints.model is still
   * forwarded even if it's not in this list.
   */
  models?: string[];
  /**
   * Free-text pointer to where this route's REAL model catalog lives
   * (`model_hint:` in config) — a docs URL, a CLI command like
   * `cursor-agent --list-models`, or "GET {base_url}/models". Surfaced in
   * status/usage; declared per entry in the shipped config, not hardcoded
   * per harness in code.
   */
  modelHint?: string;
  endpointMode?: EndpointMode;
  endpointProvider?: EndpointProvider;
  wireProtocol?: WireProtocol;
  /**
   * How much of the concurrency budget one run of this route consumes.
   *
   * `max_concurrent_runs` counted jobs, which treated an HTTP call to a local
   * endpoint as costing the same as a whole Claude Code process — so four
   * cheap endpoint calls could exclude a real dispatch, and the bound could
   * not be raised without also allowing four heavyweight CLIs. Weighting the
   * count fixes both directions.
   *
   * Defaults to 1.0 for CLI routes and 0.1 for openai_compatible endpoints.
   * With every weight at 1.0 the arithmetic is exactly the old count, so
   * existing configs behave identically.
   */
  resourceWeight?: number;
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
   * OpenTelemetry traces. OFF by default — purely operator-facing local
   * observability (OTLP to localhost unless redirected); enable only if you
   * run a collector. `HARNESS_DISPATCH_TELEMETRY=1` is the env equivalent.
   */
  telemetry?: { enabled: boolean };
  /** Local artifact retention. jobsDays: how long ~/.harness-dispatch/jobs entries live (default 7). */
  retention?: { jobsDays?: number };
  /**
   * Arena ELO scoring. OFF by default: routing ranks on the `tier` and
   * `weight` you set, and the router makes no outbound request. Enable to let
   * public benchmark scores influence ranking and tier auto-derivation.
   */
  leaderboard?: { enabled?: boolean };
  /**
   * Resolved secret -> the `${VAR}` reference it came from, for every
   * `${VAR}` in the config file that resolved to a non-empty value.
   *
   * Exists so `configure` can write the reference back instead of the secret.
   * Interpolation happens on the raw YAML tree before it is shaped into
   * routes, so by the time a ServiceConfig exists its `apiKey` is already the
   * resolved string and the reference is gone; this is the only surviving
   * record of it. Never serialize this map.
   */
  envRefs?: ReadonlyMap<string, string>;
  /**
   * ROUTE NAME -> the `api_key: ${VAR}` reference written in the config file.
   *
   * envRefs is keyed by resolved value and therefore cannot represent a
   * reference whose variable is UNSET: that resolves to "", which every unset
   * variable shares. Without this map, regenerating a config on a shell that
   * had not exported the variable dropped the api_key line entirely. Never
   * serialize this map.
   */
  apiKeyRefs?: ReadonlyMap<string, string>;
  /**
   * Ceiling on agent CLIs running at once, machine-wide (default 4).
   *
   * Not a throughput knob — a resource guard. Every dispatch spawns a
   * detached runner which spawns a full agent CLI, and those are heavyweight
   * processes (Codex is a Rust binary with a model runtime), not fan-outable
   * HTTP calls. Unbounded, a burst of parallel dispatches exhausts memory:
   * measured 2026-08-03, 20 dispatches to one route with 13 running
   * concurrently, half of them failing, one killed by a Rust OOM. Dispatches
   * past the limit wait in `queued` and start as slots free — nothing is
   * rejected or lost. Raise it on a machine with headroom; `0` disables the
   * bound entirely and restores the old behaviour.
   */
  maxConcurrentRuns?: number;
  /**
   * Config entries that were silently ignored rather than failing to load —
   * a disabled:/overrides: name that doesn't match any auto-detected route
   * (e.g. left over from before the claude_code -> claude_code_cli-style
   * rename), or a clis: entry with a missing/unrecognized harness or name.
   * Surfaced by `doctor`/`configure` so a stale or typo'd config doesn't go
   * unnoticed forever.
   */
  configWarnings?: readonly string[];
  /**
   * Set when a hot reload FAILED and this config is the previously loaded one
   * still in effect — so the file on disk is not the file being routed on.
   *
   * Carried here because it has to reach `status`. The failure was reported on
   * stderr only, which no MCP client and no HTTP caller ever sees, and the
   * comment at the throw site described the bug as "nothing on stderr and
   * nothing in status" while closing only the first half.
   */
  reloadError?: string;
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
  /**
   * `hints.model` was NOT sent to the harness, because it named a configured
   * route rather than a model.
   *
   * Without this the drop was invisible: the tool schema said the model is
   * "ALWAYS passed to the harness as an override either way", and
   * `modelHintMatched: false` is documented as "it was forwarded blind" — so a
   * caller whose model was silently discarded read a response that said the
   * opposite twice over. Suppressing the value is right; saying nothing about
   * it is the same failure this project keeps finding elsewhere.
   */
  modelHintDropped?: boolean;
  elo: number | undefined;
  finalScore: number;
  reason: string;
  /**
   * What the winner beat, and by how much — the other candidates in the tier
   * it was chosen from, best first, winner included.
   *
   * Every score component was already reported FOR THE WINNER, and `reason`
   * said "tier 1 best (3 available)" — a count, never a comparison. So the one
   * question a caller has about an automatic choice ("why that one?") had no
   * answer, and the honest response to an unauditable chooser is to stop using
   * it: measured over a month of real dispatches, 85% named a route outright
   * and the scoring ran on about one dispatch in seven.
   *
   * Set only on the scored path. A forced or explicit route was not chosen
   * over anything, so there is nothing to compare.
   */
  candidates?: Array<{ route: string; score: number }>;
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
  /**
   * `text: true` means the chunk is the ANSWER, safe to show a user as it
   * arrives. Without it the chunk is raw process output, which for an
   * event-driven harness is protocol JSONL.
   *
   * The distinction exists because the HTTP streaming path forwarded every
   * stdout chunk into `delta.content`, so an OpenAI-compatible client
   * concatenating deltas received Codex protocol frames and internal thread
   * ids instead of the answer — while the non-streaming call on the same
   * endpoint returned the parsed result. Only the dispatcher knows which of
   * the two it is producing.
   */
  | { type: "stdout"; chunk: string; text?: boolean }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
