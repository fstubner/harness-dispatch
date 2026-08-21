import { describe, expect, it } from "vitest";

import {
  buildUsage,
  renderStatusText,
  renderUsageText,
  type HarnessDispatchStatus,
  type RouteStatus,
} from "../src/status.js";

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

function makeStatus(routes: RouteStatus[], ready: string[]): HarnessDispatchStatus {
  return {
    name: "harness-dispatch",
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

  it("surfaces the route's config-declared model_hint (no hardcoded per-harness table)", () => {
    // Hints are declared data: the shipped config's cursor entry sets
    // model_hint mentioning cursor-agent --list-models; a user-added harness
    // declares its own the same way.
    const status = makeStatus(
      [
        makeRoute({
          id: "cursor_cli",
          harness: "cursor",
          modelHint: "run cursor-agent --list-models for this install's catalog",
        }),
      ],
      [],
    );
    const usage = buildUsage(status);
    expect(usage.routes[0]!.modelHint).toContain("cursor-agent --list-models");
  });

  it("surfaces operator-declared models: lists to callers", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "nvidia_nim",
          harness: "nvidia_nim",
          models: ["qwen/qwen3-coder-480b-a35b-instruct"],
        }),
      ],
      [],
    );
    const usage = buildUsage(status);
    expect(usage.routes[0]!.models).toEqual(["qwen/qwen3-coder-480b-a35b-instruct"]);
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

  it("shows token totals, which reached --json and the MCP tool but not the text a human reads", () => {
    // The one surface people actually type at was the one that never showed
    // them, while the changelog advertised token totals in `usage`.
    const status = makeStatus(
      [
        makeRoute({
          id: "claude_code_cli",
          quota: {
            score: 1,
            localCallCount: 9,
            localSuccessCount: 9,
            localFailureCount: 0,
            localInputTokens: 466_703,
            localOutputTokens: 12_400,
          },
        }),
      ],
      ["claude_code_cli"],
    );
    const text = renderUsageText(buildUsage(status));
    expect(text).toMatch(/tokens: in=467k out=12k/);
  });

  it("omits the tokens line when the harness reported nothing, rather than claiming zero", () => {
    // "in=0 out=0" asserts nothing was spent. What actually happened is that
    // the harness told us nothing — a different claim, and the one the
    // changelog is careful to make.
    const status = makeStatus([makeRoute({ id: "codex" })], ["codex"]);
    expect(renderUsageText(buildUsage(status))).not.toContain("tokens:");
  });

  it("includes a models: line with the declared discovery hint when present", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "cursor_cli",
          harness: "cursor",
          modelHint: "Wide multi-vendor catalog: https://cursor.com/docs/models",
        }),
      ],
      ["cursor_cli"],
    );
    const text = renderUsageText(buildUsage(status));
    expect(text).toContain("models: Wide multi-vendor catalog");
  });
});

describe("renderStatusText", () => {
  it("surfaces billing.notes as a note: line so a warning isn't --json-only", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "cursor_cli",
          harness: "cursor",
          billing: {
            provider: "cursor",
            surface: "cursor_agent_cli",
            authSource: "product_login",
            kind: "included_usage_then_on_demand",
            paidUsagePossible: true,
            allowPaidUsage: true,
            paidUsageRequiresOptIn: true,
            confidence: "documented",
            notes: "Safe only because on-demand/overage billing is currently OFF.",
          },
        }),
      ],
      ["cursor_cli"],
    );
    const text = renderStatusText(status);
    expect(text).toContain("note: Safe only because on-demand/overage billing is currently OFF.");
  });

  it("omits the note: line when billing.notes is unset", () => {
    const status = makeStatus([makeRoute({ id: "codex" })], ["codex"]);
    const text = renderStatusText(status);
    expect(text).not.toContain("note:");
  });
});
