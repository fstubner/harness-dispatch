/**
 * initObservability against a real OTLP/HTTP collector: what a span carries
 * once exported. Pins the trace-only SDK wiring (no `@opentelemetry/sdk-node`):
 * the service identity, the host detector, the prompt-safe default that leaves
 * the process detector out, and the user's own detector setting winning.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { trace } from "@opentelemetry/api";
import {
  _resetObservabilityForTests,
  initObservability,
  shutdownObservability,
  withMcpToolSpan,
} from "../../src/observability/index.js";

let server: Server;
let bodies: string[];
let port: number;
const savedEnv = {
  detectors: process.env["OTEL_NODE_RESOURCE_DETECTORS"],
  disabled: process.env["OTEL_SDK_DISABLED"],
};

beforeEach(async () => {
  bodies = [];
  delete process.env["OTEL_SDK_DISABLED"];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await shutdownObservability();
  trace.disable();
  _resetObservabilityForTests();
  server.close();
  for (const [key, value] of [
    ["OTEL_NODE_RESOURCE_DETECTORS", savedEnv.detectors],
    ["OTEL_SDK_DISABLED", savedEnv.disabled],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function exportOneSpan(): Promise<string> {
  const started = await initObservability({
    enabled: true,
    otlpUrl: `http://127.0.0.1:${port}`,
    instrumentations: [],
  });
  expect(started).toBe(true);
  await withMcpToolSpan({ "tool.name": "dispatch" }, async () => undefined);
  await shutdownObservability(); // drains the batch
  expect(bodies.length, "no spans were exported").toBeGreaterThan(0);
  return bodies.join("\n");
}

describe("initObservability resource", () => {
  it("tags spans with the service and the host, and leaves argv out by default", async () => {
    delete process.env["OTEL_NODE_RESOURCE_DETECTORS"];
    const exported = await exportOneSpan();
    expect(exported).toContain('"harness-dispatch"');
    expect(exported).toContain("service.version");
    expect(exported).toContain("host.name");
    expect(exported).not.toContain("process.command_args");
  });

  it("honours an explicit detector list", async () => {
    process.env["OTEL_NODE_RESOURCE_DETECTORS"] = "process";
    const exported = await exportOneSpan();
    expect(exported).toContain("process.command_args");
    expect(exported).not.toContain("host.name");
  });
});
