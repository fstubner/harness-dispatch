import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const startMcpServerMock = vi.fn();
vi.mock("../src/mcp/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/server.js")>();
  return {
    ...actual,
    startMcpServer: (...args: unknown[]) => startMcpServerMock(...args),
  };
});

import { main } from "../src/bin.js";
import { QuotaCache } from "../src/quota.js";

async function writeConfig(opts: { includePaidRoute?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-cli-"));
  const file = path.join(dir, "config.yaml");
  const paidRoute = opts.includePaidRoute
    ? [
        "  paid:",
        "    enabled: true",
        "    type: openai_compatible",
        "    base_url: https://api.openai.com/v1",
        "    model: gpt-paid",
        "    provider: openai",
        "    surface: openai_api",
        "    auth_source: api_key",
        "    billing_kind: metered_api",
        "    paid_usage_possible: true",
        "    billing_confidence: documented",
        "    tier: 1",
        "    weight: 2",
        "    cli_capability: 1",
        "    capabilities:",
        "      execute: 1",
        "      plan: 1",
        "      review: 1",
        "",
      ]
    : [];
  await fs.writeFile(
    file,
    [
      "services:",
      "  local:",
      "    enabled: true",
      "    type: openai_compatible",
      "    base_url: http://127.0.0.1:1/v1",
      "    model: local-test",
      "    provider: local",
      "    surface: local_endpoint",
      "    auth_source: local_network",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    billing_confidence: documented",
      "    tier: 3",
      "    weight: 1",
      "    cli_capability: 1",
      "    capabilities:",
      "      execute: 1",
      "      plan: 1",
      "      review: 1",
      "",
      ...paidRoute,
    ].join("\n"),
    "utf-8",
  );
  return file;
}

async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("CLI parser", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("prints public help with the v0.4 commands", async () => {
    const result = await capture(() => main(["--help"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("harness-router configure");
    expect(result.stdout).toContain("harness-router doctor");
    expect(result.stdout).toContain("harness-router doctor --live");
    expect(result.stdout).toContain("harness-router status");
    expect(result.stdout).toContain("harness-router serve");
    expect(result.stdout).toContain("harness-router auth show");
    expect(result.stdout).not.toContain("list-services");
    expect(result.stdout).not.toContain("dashboard");
  });

  it("supports status --json", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const result = await capture(() => main(["status", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      routes: Array<Record<string, unknown> & { id: string }>;
      skippedRoutes: unknown[];
    };
    expect(parsed.name).toBe("harness-router");
    expect(parsed.routes[0]!.id).toBe("local");
    expect(parsed.routes[0]).toHaveProperty("billing");
    expect(parsed.routes[0]).toHaveProperty("effectiveSafetyProfile");
    expect(parsed.routes[0]).not.toHaveProperty("kind");
    expect(Array.isArray(parsed.skippedRoutes)).toBe(true);
  });

  it("maps hidden dashboard and list-services aliases to status", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const dashboard = await capture(() => main(["dashboard", "--config", config]));
    expect(dashboard.code).toBe(0);
    expect(dashboard.stdout).toContain("harness-router status");

    const list = await capture(() => main(["list-services", "--config", config]));
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.stdout) as { routes: Array<{ id: string }> };
    expect(parsed.routes[0]!.id).toBe("local");
  });

  it("supports configure --print without writing config", async () => {
    const config = await writeConfig();
    const result = await capture(() => main(["configure", "--print", "--config", config]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("version: 4");
    expect(result.stdout).toContain("local:");
  });

  it("supports doctor --json without running a live probe", async () => {
    process.env.HARNESS_ROUTER_HTTP_TOKEN = "test-token";
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const result = await capture(() => main(["doctor", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; detail: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "live-probe")?.detail).toContain(
      "skipped",
    );
  });

  it("reports paid blockers without failing doctor when a safe route is ready", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig({ includePaidRoute: true });
    const result = await capture(() => main(["doctor", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      status: { skippedRoutes: Array<{ route: string; code: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "billing-policy")?.ok).toBe(true);
    expect(parsed.status.skippedRoutes).toEqual([
      expect.objectContaining({ route: "paid", code: "paid_blocked" }),
    ]);
  });

  it("supports auth show through the environment token", async () => {
    process.env.HARNESS_ROUTER_HTTP_TOKEN = "test-token";
    const result = await capture(() => main(["auth", "show"]));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("test-token");
  });

  it("forwards --config through the mcp command instead of dropping it", async () => {
    // main() blocks forever on the stdio MCP lifetime promise (shutdown only
    // happens via process.exit on a real signal) — don't await it to
    // completion; just let it run far enough to call startMcpServer, assert,
    // then remove the signal handlers it installed so they don't leak.
    startMcpServerMock.mockReset();
    const registered: Array<[string | symbol, (...args: unknown[]) => void]> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
        registered.push([event, listener]);
        return process;
      });
    startMcpServerMock.mockResolvedValue({ close: vi.fn(async () => undefined) });

    void main(["mcp", "--config", "some/config.yaml"]);
    // initObservability() does a real dynamic import on first use (not just a
    // microtask), so poll with real timer ticks instead of flushing
    // microtasks, up to a generous bound.
    const deadline = Date.now() + 5000;
    while (startMcpServerMock.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(startMcpServerMock).toHaveBeenCalledWith({ configPath: "some/config.yaml" });
    for (const [event, listener] of registered) process.off(event, listener);
    onSpy.mockRestore();
  });
});
