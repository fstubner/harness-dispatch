/**
 * `/mcp` on the HTTP server, for each MCP protocol revision's client.
 *
 * A 2025-era client opens a session with `initialize` and is served by the
 * sessionful wiring: one server per session, so its dispatches share a
 * connection id. A 2026-07-28 client has no session — every POST carries its
 * protocol version and name in `_meta` and gets a server built for that one
 * request — so its dispatches are recorded with its name and NO connection id,
 * rather than a fresh id per request that would group nothing.
 *
 * Both go through the same bearer check, body size limit and redacting tool
 * results, which live in front of the SDK.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHttpServer, type HttpServerHandle } from "../../src/http/server.js";
import { getAsyncJob } from "../../src/jobs.js";

let dir: string;
let handle: HttpServerHandle;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-http-proto-"));
  const configPath = path.join(dir, "config.yaml");
  // Four lines 300 ms apart: output to report as progress before it finishes.
  const script =
    "let i = 0; const t = setInterval(() => { i += 1; console.log('line ' + i); " +
    "if (i === 4) clearInterval(t); }, 300)";
  await fs.writeFile(
    configPath,
    [
      "clis:",
      "  - name: fake_cli",
      "    harness: generic",
      "    command: node",
      "    tier: 3",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    protocol:",
      `      args: ["-e", ${JSON.stringify(script)}, "{{prompt}}"]`,
      "      output: { mode: text }",
    ].join("\n"),
    "utf8",
  );
  handle = await startHttpServer({ configPath, token: "secret" });
});

afterAll(async () => {
  await handle.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function connect(name: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name, version: "1.0" },
    { capabilities: {}, ...(modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}) },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer secret" } },
    }),
  );
  return client;
}

async function dispatch(client: Client): Promise<{ progress: number; caller: Record<string, unknown> | undefined }> {
  let progress = 0;
  const res = await client.callTool(
    {
      name: "dispatch",
      arguments: { prompt: "hi", workingDir: dir, hints: { taskType: "plan" }, graceSeconds: 30 },
    },
    { onprogress: () => (progress += 1) },
  );
  expect(res.isError).not.toBe(true);
  const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
    jobId: string;
    completed: boolean;
    output: string;
  };
  expect(body.completed).toBe(true);
  expect(body.output).toContain("line 4");
  const job = await getAsyncJob(body.jobId);
  return { progress, caller: job.manifest.caller as Record<string, unknown> | undefined };
}

describe.each([
  { kind: "2025-era client (initialize, session)", modern: false },
  { kind: "2026-07-28 client (no handshake, per-request _meta)", modern: true },
])("/mcp — $kind", ({ modern }) => {
  const name = modern ? "modern-http-client" : "legacy-http-client";
  let client: Client;

  beforeAll(async () => {
    client = await connect(name, modern);
  });

  afterAll(async () => {
    await client.close();
  });

  it("delivers the server instructions", () => {
    expect(client.getInstructions()).toContain("`dispatch` always starts new work");
  });

  it("lists the tools and reads the status resource", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
    const read = await client.readResource({ uri: "harness-dispatch://status.json" });
    const status = JSON.parse((read.contents[0] as { text: string }).text) as { routes: Array<{ id: string }> };
    expect(status.routes.map((r) => r.id)).toEqual(["fake_cli"]);
  });

  it("dispatches with progress and records who asked", async () => {
    const first = await dispatch(client);
    expect(first.progress, "no progress notification during the grace window").toBeGreaterThan(0);
    expect(first.caller?.client).toBe(name);
    const second = await dispatch(client);
    if (modern) {
      // No connection exists, so none is recorded — not one id per request.
      expect(first.caller?.session).toBeUndefined();
      expect(second.caller?.session).toBeUndefined();
    } else {
      expect(first.caller?.session).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.caller?.session).toBe(first.caller?.session);
    }
  }, 60_000);

  it("refuses a near-miss argument", async () => {
    await expect(
      client.callTool({ name: "dispatch", arguments: { prompt: "hi", workingDir: dir, safteyProfile: "read_only" } }),
    ).rejects.toThrow(/did you mean safetyProfile/);
  });
});

describe("/mcp — what stays in front of the SDK for 2026-07-28 requests", () => {
  const modernPost = (headers: Record<string, string>, body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
        ...headers,
      },
      body,
    });
  const toolsList = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
      },
    },
  });

  it("requires the bearer token", async () => {
    expect((await modernPost({}, toolsList)).status).toBe(401);
    expect((await modernPost({ authorization: "Bearer secret" }, toolsList)).status).toBe(200);
  });

  it("applies the body size limit", async () => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(12 * 1024 * 1024) } });
    expect((await modernPost({ authorization: "Bearer secret" }, huge)).status).toBe(413);
  });

  it("answers without opening a session", async () => {
    // The legacy client above leaves its session open (closing a client does
    // not send DELETE), so this counts the change rather than the total.
    const before = handle.openMcpSessions();
    const res = await modernPost({ authorization: "Bearer secret" }, toolsList);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(handle.openMcpSessions()).toBe(before);
  });
});
