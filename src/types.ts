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
  allowPaidOverage: boolean;
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
  allowPaidOverage?: boolean;
  billingConfidence?: BillingConfidence;
  billingNotes?: string;
  safetyProfile?: SafetyProfile;
  endpointMode?: EndpointMode;
  endpointProvider?: EndpointProvider;
  wireProtocol?: WireProtocol;
  workspacePolicy?: WorkspacePolicy;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  disabled?: readonly string[];
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
}

export type DispatcherEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
