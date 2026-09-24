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
    // The host is redacted, and this assertion used to say it was not.
    //
    // `redactEndpointHost` replaced the hostname by assigning to
    // `url.hostname`; the WHATWG setter silently rejects a value containing
    // `<` and `>`, so the function returned its input verbatim and this test
    // pinned that no-op as the expected output. Status and usage are described
    // as safe to paste into a bug report, and a private endpoint's hostname is
    // the one part of a base URL that identifies infrastructure.
    expect(usage.routes[0]!.modelHint).toBe(
      "Standard OpenAI-compatible catalog: GET https://<endpoint-host>/openai/v1/models",
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

describe("usage with no routes", () => {
  /**
   * An acceptance pass deleted this block and the doctor job-runner check
   * together and the full suite stayed at 1258 passed, exit 0 — byte
   * identical. Both behaviours worked; neither was pinned, and the commit
   * message presented them as delivered.
   */
  it("explains itself rather than printing a bare header", async () => {
    const { renderUsageText } = await import("../src/status.js");
    const text = renderUsageText({
      name: "harness-dispatch",
      generatedAt: new Date().toISOString(),
      routes: [],
    } as never);
    expect(text).toContain("No routes configured");
    // Both ways out, because which one applies depends on the machine.
    expect(text).toContain("endpoints:");
    expect(text).toMatch(/claude|codex|cursor-agent|agy/);
  });
});

describe("the mark on a listed route reflects whether the router will use it", () => {
  // `usage` is the surface an orchestrating agent is told to read before
  // delegating, and it printed `ok` for every configured route — including
  // ones the router was refusing to score at all. A user watching a route sit
  // at `ok` while nothing routed to it had no way to connect the two, which is
  // why `doctor` grew a separate route-health line saying what `status`
  // contradicted one screen up.
  it("marks a route the router refuses as skip, in usage and in status", () => {
    const status = makeStatus(
      [
        makeRoute({
          id: "groq_api",
          type: "openai_compatible",
          skipped: {
            route: "groq_api",
            code: "credential_unset",
            message: "its api_key is ${GROQ_API_KEY}, and that variable is not set here",
          },
        }),
      ],
      [],
    );

    const usage = renderUsageText(buildUsage(status));
    expect(usage).toMatch(/^skip groq_api/m);
    // And the reason travels with it: the mark alone says "not this one"
    // without saying what to do about it.
    expect(usage).toContain("${GROQ_API_KEY}");
    expect(renderStatusText(status)).toMatch(/^skip groq_api/m);
  });

  it("leaves a route skipped only for THIS request marked ok", () => {
    // The listing surfaces evaluate policy with no safety profile, task type
    // or route policy, so several skip codes answer a question nobody asked.
    // cursor_cli declares full_auto, which exceeds the default requested
    // profile — marking it skipped would call a route broken that a full_auto
    // dispatch uses successfully, 11 times out of 14 on this machine.
    const status = makeStatus(
      [
        makeRoute({
          id: "cursor_cli",
          skipped: {
            route: "cursor_cli",
            code: "safety_incompatible",
            message: "effective safety full_auto exceeds requested safety",
          },
        }),
      ],
      ["cursor_cli"],
    );

    const usage = renderUsageText(buildUsage(status));
    expect(usage).toMatch(/^ok cursor_cli/m);
    // Still reported, because it is information — just not a verdict.
    expect(usage).toContain("safety_incompatible");
  });
});

describe("the listing and the router agree about a dead route", () => {
  // `doctor` reported "local_inference has never succeeded (8 calls, 0
  // successes), so the router no longer scores it" while `usage` and `status`
  // printed `ok` for that same route one screen up. Both read the same policy
  // function; only the router was passing it the call counts the check needs,
  // so the listing could not see the skip at all.
  it("marks a route with calls and no successes as skipped", async () => {
    const { buildStatus } = await import("../src/status.js");
    const svc = {
      name: "dead_local", enabled: true, type: "openai_compatible",
      baseUrl: "http://127.0.0.1:1234/v1", model: "m", tier: 3, weight: 1,
      cliCapability: 1, capabilities: { execute: 0, plan: 1, review: 1 }, escalateOn: [],
      provider: "local", surface: "local_endpoint", authSource: "local_network",
      billingKind: "local_compute", paidUsagePossible: false, billingConfidence: "documented",
    };
    const status = await buildStatus(
      { services: { dead_local: svc } } as never,
      { dead_local: { isAvailable: () => true } } as never,
      {
        fullStatus: async () => ({
          dead_local: { localCallCount: 8, localSuccessCount: 0, localFailureCount: 8 },
        }),
        getQuotaScore: async () => 1,
        localCountsPersistError: () => undefined,
      } as never,
      {
        circuitBreakerStatus: () => ({}),
        breakerStateUnreadable: () => [],
        pickService: () => undefined,
        getBreaker: () => undefined,
      } as never,
      { getQualityScore: async () => ({ qualityScore: 0.5 }) } as never,
    );

    expect(status.routes[0]?.skipped?.code).toBe("never_succeeded");
    expect(renderUsageText(buildUsage(status))).toMatch(/^skip dead_local/m);
  });
});

describe("a server running older code than is installed says so", () => {
  // A long-lived MCP server reloads config but not code, and unreleased builds
  // share a version string, so nothing revealed a server still on old code:
  // its `usage` reported routes ready that the rebuilt CLI skipped. Found in
  // an audit.
  it("warns when the module file is newer than when it was loaded", async () => {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { staleCodeWarning } = await import("../src/status.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-stale-"));
    const file = path.join(dir, "status.js");
    await fs.writeFile(file, "// loaded", "utf8");
    try {
      const loaded = (await fs.stat(file)).mtimeMs;
      expect(staleCodeWarning(file, loaded), "warned with nothing changed").toBeUndefined();

      // A rebuild or upgrade rewrites it.
      const later = new Date(loaded + 60_000);
      await fs.utimes(file, later, later);
      expect(staleCodeWarning(file, loaded)).toMatch(/restart/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reaches usage, which is what an orchestrator reads", () => {
    const status = makeStatus([makeRoute({ id: "codex" })], ["codex"]);
    status.stateWarnings = ["this server is running older code than is now installed"];
    const usage = buildUsage(status);
    expect(usage.warnings).toEqual(status.stateWarnings);
    expect(renderUsageText(usage)).toMatch(/^! this server is running older code/m);
  });
});
