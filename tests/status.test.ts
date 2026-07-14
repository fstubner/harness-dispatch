import { describe, expect, it } from "vitest";

import { buildUsage, renderUsageText, type HarnessRouterStatus, type RouteStatus } from "../src/status.js";

function makeRoute(overrides: Partial<RouteStatus> = {}): RouteStatus {
  return {
    id: "svc",
    harness: "svc",
    enabled: true,
    available: true,
    type: "cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    billing: {
      provider: "openai",
      surface: "codex_cli",
      authSource: "product_login",
      kind: "included_plan_then_flexible_credits",
      paidUsagePossible: true,
      allowPaidUsage: false,
      paidUsageRequiresOptIn: true,
      confidence: "documented",
    },
    safetyProfile: "workspace_edit",
    effectiveSafetyProfile: "workspace_edit",
    quota: { score: 1 },
    breaker: { tripped: false, failures: 0 },
    ...overrides,
  } as RouteStatus;
}

function makeStatus(routes: RouteStatus[], ready: string[]): HarnessRouterStatus {
  return {
    name: "harness-router",
    generatedAt: "2026-07-10T00:00:00.000Z",
    routes,
    ready,
    skippedRoutes: [],
  };
}

describe("buildUsage", () => {
  it("narrows status routes to usage-relevant fields", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "codex",
          model: "gpt-5.6-terra",
          quota: {
            score: 0.8,
            localCallCount: 11,
            localSuccessCount: 9,
            localFailureCount: 2,
            remaining: 40,
            limit: 50,
          },
        }),
      ],
      ["codex"],
    );

    const usage = buildUsage(status);
    expect(usage.routes).toHaveLength(1);
    const route = usage.routes[0]!;
    expect(route).toMatchObject({
      id: "codex",
      model: "gpt-5.6-terra",
      ready: true,
      callCount: 11,
      successCount: 9,
      failureCount: 2,
      quotaRemaining: 40,
      quotaLimit: 50,
      billingKind: "included_plan_then_flexible_credits",
      paidUsagePossible: true,
    });
  });

  it("defaults missing call counts to zero", () => {
    const status = makeStatus([makeRoute({ id: "fresh" })], []);
    const usage = buildUsage(status);
    expect(usage.routes[0]).toMatchObject({
      callCount: 0,
      successCount: 0,
      failureCount: 0,
      ready: false,
    });
  });

  it("includes a modelHint pointing at cursor's live --list-models", () => {
    const status = makeStatus([makeRoute({ id: "cursor_cli", harness: "cursor" })], []);
    const usage = buildUsage(status);
    expect(usage.routes[0]!.modelHint).toContain("cursor-agent --list-models");
  });

  it("includes a modelHint for claude_code pointing at Anthropic's public model docs", () => {
    const status = makeStatus([makeRoute({ id: "claude_code_cli", harness: "claude_code" })], []);
    const usage = buildUsage(status);
    expect(usage.routes[0]!.modelHint).toContain("platform.claude.com/docs");
  });

  it("includes a modelHint pointing at GET {baseUrl}/models for openai_compatible routes", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "groq_api",
          harness: "groq_api",
          type: "openai_compatible",
          baseUrl: "https://api.groq.com/openai/v1",
        }),
      ],
      [],
    );
    const usage = buildUsage(status);
    expect(usage.routes[0]!.modelHint).toBe(
      "Standard OpenAI-compatible catalog: GET https://api.groq.com/openai/v1/models",
    );
  });
});

describe("renderUsageText", () => {
  it("renders a compact per-route usage line", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "codex",
          model: "gpt-5.6-terra",
          quota: { score: 0.8, localCallCount: 5, localSuccessCount: 4, localFailureCount: 1 },
        }),
      ],
      ["codex"],
    );
    const text = renderUsageText(buildUsage(status));
    expect(text).toContain("codex (gpt-5.6-terra)");
    expect(text).toContain("calls=5");
    expect(text).toContain("success=4");
    expect(text).toContain("failed=1");
    expect(text).toContain("breaker=closed");
  });

  it("includes a models: line with the discovery hint when present", () => {
    const status = makeStatus(
      [makeRoute({ id: "cursor_cli", harness: "cursor" })],
      ["cursor_cli"],
    );
    const text = renderUsageText(buildUsage(status));
    expect(text).toContain("models: Wide multi-vendor catalog");
  });
});
