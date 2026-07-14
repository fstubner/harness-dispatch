import { describe, expect, it } from "vitest";

import { billingIsBlocked, buildRouteBilling } from "../src/billing.js";
import { evaluateRoutePolicy, nonLocalIncludedRoutePenalty } from "../src/route-policy.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  ServiceConfig,
} from "../src/types.js";
import type { Dispatcher } from "../src/dispatchers/base.js";

function svc(overrides: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    command: overrides.name,
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    ...overrides,
  } as ServiceConfig;
}

class AvailableDispatcher implements Dispatcher {
  readonly id = "test";
  async dispatch(): Promise<DispatchResult> {
    return { output: "ok", service: this.id, success: true };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: { output: "ok", service: this.id, success: true } };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

describe("billing classification", () => {
  it("classifies Claude Agent SDK billing before and after the June 2026 credit change", () => {
    const route = svc({ name: "claude_code", harness: "claude_code" });
    expect(buildRouteBilling(route, { now: new Date("2026-05-25T00:00:00Z") }).kind).toBe(
      "included_plan_usage",
    );
    const after = buildRouteBilling(route, { now: new Date("2026-06-15T00:00:00Z") });
    expect(after.kind).toBe("included_credit_then_optional_overage");
    expect(after.paidUsagePossible).toBe(true);
  });

  it("separates Codex product-plane usage from API-key usage", () => {
    expect(buildRouteBilling(svc({ name: "codex", harness: "codex" })).kind).toBe(
      "included_plan_then_flexible_credits",
    );
    expect(
      buildRouteBilling(svc({ name: "codex", harness: "codex", apiKey: "sk-test" })).kind,
    ).toBe("metered_api");
  });

  it("classifies OpenAI-compatible endpoints conservatively", () => {
    expect(
      buildRouteBilling(
        svc({
          name: "openai",
          type: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-test",
        }),
      ).kind,
    ).toBe("metered_api");
    expect(
      buildRouteBilling(
        svc({
          name: "ollama",
          type: "openai_compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "llama",
        }),
      ).kind,
    ).toBe("local_compute");
    expect(
      buildRouteBilling(
        svc({
          name: "proxy",
          type: "openai_compatible",
          baseUrl: "http://127.0.0.1:9191/v1",
          model: "proxy",
        }),
      ).kind,
    ).toBe("unknown");
  });

  it("classifies Antigravity as free_quota and runs it by default with no opt-in", () => {
    const route = svc({ name: "antigravity_cli", harness: "antigravity_cli" });
    const billing = buildRouteBilling(route);
    expect(billing.kind).toBe("free_quota");
    expect(billing.paidUsagePossible).toBe(false);
    expect(billingIsBlocked(billing)).toBe(false);
  });
});

describe("route policy", () => {
  it("blocks paid and unknown-paid routes until explicitly allowed", () => {
    const dispatcher = new AvailableDispatcher();
    const paid = svc({ name: "codex", harness: "codex" });
    expect(evaluateRoutePolicy("codex", paid, { dispatcher }).skipped?.code).toBe(
      "paid_blocked",
    );
    const allowed = svc({ name: "codex", harness: "codex", allowPaidUsage: true });
    expect(evaluateRoutePolicy("codex", allowed, { dispatcher }).blocked).toBe(false);
  });

  it("blocks full-auto Cursor when workspace_edit is requested", () => {
    const dispatcher = new AvailableDispatcher();
    const cursor = svc({
      name: "cursor",
      harness: "cursor",
      billingKind: "included_usage_then_on_demand",
      paidUsagePossible: true,
      allowPaidUsage: true,
    });
    expect(evaluateRoutePolicy("cursor", cursor, { dispatcher }).skipped?.code).toBe(
      "safety_incompatible",
    );
    expect(
      evaluateRoutePolicy("cursor", cursor, {
        dispatcher,
        requestedSafetyProfile: "full_auto",
      }).blocked,
    ).toBe(false);
  });
});

describe("nonLocalIncludedRoutePenalty", () => {
  it("penalizes genuinely paid/unknown-billing routes MORE than included-plan routes, not less", () => {
    const local = buildRouteBilling(svc({ name: "local", surface: "local_endpoint" }));
    const included = buildRouteBilling(
      svc({ name: "codex", harness: "codex" }), // included_plan_then_flexible_credits
    );
    const metered = buildRouteBilling(
      svc({ name: "raw", type: "openai_compatible", baseUrl: "https://api.openai.com/v1" }),
    );

    const localPenalty = nonLocalIncludedRoutePenalty(local);
    const includedPenalty = nonLocalIncludedRoutePenalty(included);
    const meteredPenalty = nonLocalIncludedRoutePenalty(metered);

    expect(localPenalty).toBe(0);
    // The actual bug: metered/unknown routes must be penalized at least as
    // much as included-plan routes — previously they fell through to 0,
    // tying with local (free) routes and beating included-plan routes.
    expect(meteredPenalty).toBeGreaterThan(includedPenalty);
    expect(includedPenalty).toBeGreaterThan(localPenalty);
  });
});
