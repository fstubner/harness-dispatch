/**
 * Value coercion and enum narrowing for config parsing.
 *
 * Split out of config.ts, which reached 1738 lines with three parallel route
 * builders — the shape that produced four separate silent-drop defects. These
 * are the leaves of that parser: pure functions over `unknown`, no config
 * state, no I/O, trivially testable in isolation.
 *
 * The convention throughout is DROP ON MISMATCH — every `*From` returns
 * undefined rather than guessing, and the caller decides the fallback. That is
 * deliberate, and it is also exactly why a typo could silently select a
 * default. config.ts warns separately about unrecognised keys to cover it;
 * the two belong together.
 */

import type {
  AuthSource,
  BillingConfidence,
  BillingKind,
  BillingProvider,
  BillingSurface,
  EndpointMode,
  EndpointProvider,
  ThinkingLevel,
  WireProtocol,
  WorkspacePolicy,
} from "../types.js";

export function num(v: unknown, def: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

export function int(v: unknown, def: number): number {
  return Math.trunc(num(v, def));
}

export function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return def;
}

export function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "") return undefined;
  return v;
}

export function thinkingFrom(v: unknown): ThinkingLevel | undefined {
  if (v === "low" || v === "medium" || v === "high") return v;
  return undefined;
}

export function providerFrom(v: unknown): BillingProvider | undefined {
  if (
    v === "anthropic" ||
    v === "openai" ||
    v === "cursor" ||
    v === "google" ||
    v === "local" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

export function surfaceFrom(v: unknown): BillingSurface | undefined {
  if (
    v === "claude_code" ||
    v === "claude_agent_sdk" ||
    v === "anthropic_api" ||
    v === "codex_cli" ||
    v === "codex_sdk" ||
    v === "openai_api" ||
    v === "cursor_agent_cli" ||
    v === "antigravity_cli" ||
    v === "gemini_api" ||
    v === "vertex_ai" ||
    v === "openai_compatible" ||
    v === "local_endpoint" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

export function authSourceFrom(v: unknown): AuthSource | undefined {
  if (
    v === "product_login" ||
    v === "api_key" ||
    v === "oauth_session" ||
    v === "local_network" ||
    v === "configured_endpoint" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

export function billingKindFrom(v: unknown): BillingKind | undefined {
  if (
    v === "local_compute" ||
    v === "included_plan_usage" ||
    v === "included_plan_then_flexible_credits" ||
    v === "included_credit_then_optional_overage" ||
    v === "included_usage_then_on_demand" ||
    v === "metered_api" ||
    v === "free_quota" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

export function confidenceFrom(v: unknown): BillingConfidence | undefined {
  if (v === "documented" || v === "inferred" || v === "unknown" || v === "unsupported") {
    return v;
  }
  return undefined;
}

export function endpointModeFrom(v: unknown): EndpointMode | undefined {
  if (
    v === "provider_cloud" ||
    v === "direct_openai_compatible" ||
    v === "harness_native_endpoint"
  ) {
    return v;
  }
  return undefined;
}

export function endpointProviderFrom(v: unknown): EndpointProvider | undefined {
  if (
    v === "ollama" ||
    v === "lmstudio" ||
    v === "openai_compatible" ||
    v === "anthropic_gateway" ||
    v === "gemini_proxy" ||
    v === "custom"
  ) {
    return v;
  }
  return undefined;
}

export function wireProtocolFrom(v: unknown): WireProtocol | undefined {
  if (
    v === "openai_chat_completions" ||
    v === "anthropic_messages" ||
    v === "gemini_generate_content" ||
    v === "provider_native" ||
    v === "unknown"
  ) {
    return v;
  }
  return undefined;
}

export function workspacePolicyFrom(v: unknown): WorkspacePolicy | undefined {
  if (v === "shared" || v === "shared_locked" || v === "git_worktree" || v === "copy") {
    return v;
  }
  return undefined;
}

export function inferEndpointProvider(baseUrl: string | undefined): EndpointProvider {
  if (!baseUrl) return "custom";
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const port = url.port;
    if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && port === "11434") {
      return "ollama";
    }
    if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && port === "1234") {
      return "lmstudio";
    }
  } catch {
    // Fall through to substring checks for partial or nonstandard URLs.
  }
  const lower = baseUrl.toLowerCase();
  if (lower.includes("ollama")) return "ollama";
  if (lower.includes("lmstudio") || lower.includes("lm-studio")) return "lmstudio";
  return "custom";
}
