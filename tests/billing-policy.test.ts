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
  it("classifies Claude Agent SDK billing as included plan usage — the announced June 2026 credit split was paused before taking effect", () => {
    const route = svc({ name: "claude_code", harness: "claude_code", surface: "claude_agent_sdk" });
    expect(buildRouteBilling(route).kind).toBe("included_plan_usage");
    // Anthropic paused the 2026-06-15 Agent SDK credit split on launch day —
    // post-date classification must NOT flip to the credit kind.
    // Classification carries no date logic at all now (buildRouteBilling's
    // unused `now` option is gone), so date-independence is structural rather
    // than something a fixed clock can demonstrate. Kept as a second
    // assertion because the KIND is still the thing that must not drift.
    const after = buildRouteBilling(route);
    expect(after.kind).toBe("included_plan_usage");
    expect(after.notes).toMatch(/same subscription usage pool/);
    // Not paidUsagePossible by default: Anthropic hard-stops at the plan's
    // included usage unless the user has separately opted into "usage
    // credits" overage on their own account — see inferredPaidUsagePossible
    // in billing.ts. A user who HAS opted in can restore the block with an
    // explicit paid_usage_possible: true in that route's config.
    expect(after.paidUsagePossible).toBe(false);
    const overrideEnabled = buildRouteBilling({ ...route, paidUsagePossible: true });
    expect(overrideEnabled.paidUsagePossible).toBe(true);
  });

  it("an explicit billing_kind on a generic route counts as documented — not blocked", () => {
    // The advertised remedy for generic routes' unknown/blocked default is
    // "set billing_kind: and paid_usage_possible: explicitly once you know
    // it". That declaration must actually lift the block: an operator's
    // explicit billing_kind IS the documentation, so confidence must not
    // fall back to "unknown" just because the surface is custom.
    const billing = buildRouteBilling(
      svc({
        name: "my_cli",
        harness: "generic",
        billingKind: "local_compute",
        paidUsagePossible: false,
      }),
    );
    expect(billing.kind).toBe("local_compute");
    expect(billing.confidence).toBe("documented");
    expect(billingIsBlocked(billing)).toBe(false);
  });

  it("a generic route with no billing_kind stays unknown/blocked", () => {
    const billing = buildRouteBilling(svc({ name: "my_cli", harness: "generic" }));
    expect(billing.kind).toBe("unknown");
    expect(billing.confidence).toBe("unknown");
    expect(billingIsBlocked(billing)).toBe(true);
  });

  it("separates Codex product-plane usage from API-key usage", () => {
    expect(
      buildRouteBilling(svc({ name: "codex", harness: "codex", surface: "codex_cli" })).kind,
    ).toBe("included_plan_then_flexible_credits");
    expect(
      buildRouteBilling(
        svc({ name: "codex", harness: "codex", surface: "codex_cli", apiKey: "sk-test" }),
      ).kind,
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

  it("does not treat a remote URL that merely CONTAINS a local one as local compute", () => {
    // The predicates used String.includes, so this classified as
    // kind: local_compute / provider: local / paidUsagePossible: false —
    // which ALSO exempted it from the caller's local_only and
    // approval_required policies, since isLocalRoute ORs those fields.
    const billing = buildRouteBilling(
      svc({
        name: "sneaky",
        type: "openai_compatible",
        baseUrl: "https://evil.example.com/proxy?upstream=localhost:11434/v1",
      }),
    );
    expect(billing.kind).not.toBe("local_compute");
    expect(billing.provider).not.toBe("local");
    expect(billing.paidUsagePossible).toBe(true);
  });

  it("does not treat a hostname that merely starts with a loopback name as loopback", () => {
    const billing = buildRouteBilling(
      svc({
        name: "lookalike",
        type: "openai_compatible",
        baseUrl: "https://localhost.evil.example.com/v1",
      }),
    );
    expect(billing.kind).not.toBe("local_compute");
  });

  it("still classifies a genuine loopback runtime as local", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1"]) {
      expect(buildRouteBilling(svc({ name: "real", type: "openai_compatible", baseUrl: url })).kind).toBe(
        "local_compute",
      );
    }
  });

  it("classifies Antigravity as free_quota and runs it by default with no opt-in", () => {
    const route = svc({ name: "antigravity_cli", harness: "antigravity_cli", surface: "antigravity_cli" });
    const billing = buildRouteBilling(route);
    expect(billing.kind).toBe("free_quota");
    expect(billing.paidUsagePossible).toBe(false);
    expect(billingIsBlocked(billing)).toBe(false);
  });
});

describe("route policy", () => {
  it("does NOT block included-then-optional-overage routes by default — the provider itself hard-stops first", () => {
    const dispatcher = new AvailableDispatcher();
    const codex = svc({ name: "codex", harness: "codex", surface: "codex_cli" });
    expect(evaluateRoutePolicy("codex", codex, { dispatcher }).blocked).toBe(false);
    const cursor = svc({
      name: "cursor",
      harness: "cursor",
      surface: "cursor_agent_cli",
      billingKind: "included_usage_then_on_demand",
      paidUsagePossible: false,
      effectiveSafety: "full_auto",
    });
    // Cursor's shipped entry declares effective_safety: full_auto (print mode
    // always has write+shell capability), so isolate the billing check from
    // that separate safety_incompatible gate.
    expect(
      evaluateRoutePolicy("cursor", cursor, {
        dispatcher,
        requestedSafetyProfile: "full_auto",
      }).blocked,
    ).toBe(false);
  });

  it("blocks metered/unknown-billing routes until explicitly allowed — no provider-side backstop exists", () => {
    const dispatcher = new AvailableDispatcher();
    const metered = svc({ name: "codex", harness: "codex", surface: "codex_cli", apiKey: "sk-test" });
    expect(evaluateRoutePolicy("codex", metered, { dispatcher }).skipped?.code).toBe(
      "paid_blocked",
    );
    const allowed = svc({
      name: "codex",
      harness: "codex",
      surface: "codex_cli",
      apiKey: "sk-test",
      allowPaidUsage: true,
    });
    expect(evaluateRoutePolicy("codex", allowed, { dispatcher }).blocked).toBe(false);
  });

  it("still blocks a route where the operator has confirmed provider-side overage IS enabled", () => {
    const dispatcher = new AvailableDispatcher();
    const optedIn = svc({
      name: "codex",
      harness: "codex",
      surface: "codex_cli",
      paidUsagePossible: true, // explicit override — operator confirmed overage is on
    });
    expect(evaluateRoutePolicy("codex", optedIn, { dispatcher }).skipped?.code).toBe(
      "paid_blocked",
    );
    const allowed = svc({
      name: "codex",
      harness: "codex",
      surface: "codex_cli",
      paidUsagePossible: true,
      allowPaidUsage: true,
    });
    expect(evaluateRoutePolicy("codex", allowed, { dispatcher }).blocked).toBe(false);
  });

  it("blocks full-auto Cursor when workspace_edit is requested", () => {
    const dispatcher = new AvailableDispatcher();
    const cursor = svc({
      name: "cursor",
      harness: "cursor",
      surface: "cursor_agent_cli",
      billingKind: "included_usage_then_on_demand",
      paidUsagePossible: true,
      allowPaidUsage: true,
      effectiveSafety: "full_auto",
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
      svc({ name: "codex", harness: "codex", surface: "codex_cli" }), // included_plan_then_flexible_credits
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

describe("the unknown-billing refusal says WHICH thing is unknown", () => {
  // billingIsUnknown is true when the KIND is unknown OR the CONFIDENCE is.
  // One message covered both, so a route `status` prints as
  // `billing=metered_api` was refused with "billing source is unknown" - the
  // kind is known perfectly well; what is unknown is how sure we are of it. An
  // acceptance pass caught the two surfaces contradicting each other.
  function svc(over: Record<string, unknown>): never {
    return {
      name: "r",
      enabled: true,
      type: "openai_compatible",
      tier: 1,
      weight: 1,
      cliCapability: 1,
      capabilities: { execute: 1, plan: 1, review: 1 },
      escalateOn: [],
      provider: "openai",
      surface: "openai_api",
      authSource: "api_key",
      paidUsagePossible: true,
      ...over,
    } as never;
  }

  it("names the kind when the kind is what is missing", () => {
    const out = evaluateRoutePolicy(
      "r",
      svc({ billingKind: "unknown", billingConfidence: "documented" }),
      { dispatcher: { isAvailable: () => true } as never },
    );
    expect(out.skipped?.message).toContain("billing source is unknown");
  });

  it("names the CONFIDENCE when the kind is known", () => {
    const out = evaluateRoutePolicy(
      "r",
      svc({ billingKind: "metered_api", billingConfidence: "unknown" }),
      { dispatcher: { isAvailable: () => true } as never },
    );
    expect(out.skipped?.message).toContain("metered_api");
    expect(out.skipped?.message).toContain("confidence is unknown");
    expect(
      out.skipped?.message,
      "told the operator the source was unknown for a route whose kind is known",
    ).not.toContain("billing source is unknown");
  });
});
