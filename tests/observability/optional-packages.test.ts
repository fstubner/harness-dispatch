/**
 * The OpenTelemetry packages are optional, so a default install does not have
 * them. Every one is replaced here by a module whose import fails, which is
 * what an absent package does:
 *
 *  - telemetry off must never import any of them, and must still run work;
 *  - telemetry on must stop with a message that says what to install.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const attempts = vi.hoisted(() => {
  const imported: string[] = [];
  return {
    imported,
    absent: (name: string): never => {
      imported.push(name);
      throw new Error(`Cannot find package '${name}'`);
    },
  };
});

// vi.mock is hoisted above the imports below, so a static import of any of
// these anywhere in the module graph would hit the failing factory too.
vi.mock("@opentelemetry/api", () => attempts.absent("@opentelemetry/api"));
vi.mock("@opentelemetry/sdk-trace-node", () => attempts.absent("@opentelemetry/sdk-trace-node"));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => attempts.absent("@opentelemetry/exporter-trace-otlp-http"));
vi.mock("@opentelemetry/resources", () => attempts.absent("@opentelemetry/resources"));
vi.mock("@opentelemetry/instrumentation", () => attempts.absent("@opentelemetry/instrumentation"));
vi.mock("@opentelemetry/instrumentation-http", () => attempts.absent("@opentelemetry/instrumentation-http"));
vi.mock("@opentelemetry/instrumentation-fs", () => attempts.absent("@opentelemetry/instrumentation-fs"));

import {
  _resetObservabilityForTests,
  initObservability,
  TELEMETRY_INSTALL_COMMAND,
  TELEMETRY_PACKAGES,
  TelemetryUnavailableError,
  withDispatcherSpan,
  withMcpToolSpan,
} from "../../src/observability/index.js";
import { withRouterSpan } from "../../src/observability/spans.js";

const saved = {
  telemetry: process.env["HARNESS_DISPATCH_TELEMETRY"],
  disabled: process.env["OTEL_SDK_DISABLED"],
};

afterEach(() => {
  _resetObservabilityForTests();
  attempts.imported.length = 0;
  for (const [key, value] of [
    ["HARNESS_DISPATCH_TELEMETRY", saved.telemetry],
    ["OTEL_SDK_DISABLED", saved.disabled],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("telemetry off, OpenTelemetry packages absent", () => {
  it("does not start and does not import any of them", async () => {
    delete process.env["HARNESS_DISPATCH_TELEMETRY"];
    delete process.env["OTEL_SDK_DISABLED"];
    expect(await initObservability()).toBe(false);
    expect(await initObservability({ enabled: false })).toBe(false);
    expect(attempts.imported).toEqual([]);
  });

  it("still runs the code inside every span helper, and passes its result and errors through", async () => {
    const dispatcher = await withDispatcherSpan("dispatch", { "dispatcher.id": "x" }, async (span) => {
      span.setAttribute("success", true);
      return "a";
    });
    const router = await withRouterSpan({ "router.op": "route" }, async () => "b");
    const tool = await withMcpToolSpan({ "tool.name": "dispatch" }, async () => "c");
    expect([dispatcher, router, tool]).toEqual(["a", "b", "c"]);
    await expect(
      withMcpToolSpan({ "tool.name": "dispatch" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(attempts.imported).toEqual([]);
  });
});

describe("telemetry on, OpenTelemetry packages absent", () => {
  it("fails with a message that names what to install and how to turn telemetry off", async () => {
    delete process.env["OTEL_SDK_DISABLED"];
    const err = await initObservability({ enabled: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelemetryUnavailableError);
    const message = (err as Error).message;
    expect(message).toContain(TELEMETRY_INSTALL_COMMAND);
    expect(message).toContain("@opentelemetry/sdk-trace-node@^2.10.0");
    expect(message).toContain("@opentelemetry/exporter-trace-otlp-http@^0.221.0");
    expect(message).toContain("telemetry: { enabled: false }");
  });

  it("is also reached through the HARNESS_DISPATCH_TELEMETRY opt-in", async () => {
    delete process.env["OTEL_SDK_DISABLED"];
    process.env["HARNESS_DISPATCH_TELEMETRY"] = "1";
    await expect(initObservability()).rejects.toThrow(/npm install/);
  });

  it("OTEL_SDK_DISABLED=true still wins, without importing anything", async () => {
    process.env["OTEL_SDK_DISABLED"] = "true";
    expect(await initObservability({ enabled: true })).toBe(false);
    expect(attempts.imported).toEqual([]);
  });
});

describe("the packages telemetry asks you to install", () => {
  it("are optional peers of the package, at the ranges the install command names", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies).toEqual(TELEMETRY_PACKAGES);
    for (const name of Object.keys(TELEMETRY_PACKAGES)) {
      expect(pkg.peerDependenciesMeta[name]?.optional, name).toBe(true);
    }
    // A default install must not pull any of them.
    expect(Object.keys(pkg.dependencies).filter((n) => n.startsWith("@opentelemetry/"))).toEqual([]);
  });
});
