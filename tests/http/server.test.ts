import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer, type HttpServerHandle } from "../../src/http/server.js";

async function startFakeOpenAi(): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { stream?: boolean };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" stream"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hello response" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("fake server failed to bind");
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeConfig(baseUrl: string, opts: { includePaidRoute?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-http-"));
  const file = path.join(dir, "config.yaml");
  const paidRoute = opts.includePaidRoute
    ? [
        "  paid_openai:",
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
      `    base_url: ${baseUrl}`,
      "    model: local-test",
      "    provider: local",
      "    surface: local_endpoint",
      "    auth_source: local_network",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    billing_confidence: documented",
      "    endpoint_mode: direct_openai_compatible",
      "    endpoint_provider: custom",
      "    wire_protocol: openai_chat_completions",
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

describe("HTTP server", () => {
  const handles: HttpServerHandle[] = [];
  const fakes: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  });

  it("requires bearer auth for status", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/status`);
    expect(res.status).toBe(401);
  });

  it("serves REST status and non-streaming chat completions", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const status = await fetch(`http://127.0.0.1:${handle.port}/v1/status`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(status.status).toBe(200);
    const statusJson = (await status.json()) as {
      routes: Array<Record<string, unknown> & { id: string }>;
      skippedRoutes: unknown[];
    };
    expect(statusJson.routes[0]!.id).toBe("local");
    expect(statusJson.routes[0]).toHaveProperty("billing");
    expect(statusJson.routes[0]).toHaveProperty("endpoint");
    expect(statusJson.routes[0].endpoint).toEqual(
      expect.objectContaining({
        mode: "direct_openai_compatible",
        provider: "custom",
        wireProtocol: "openai_chat_completions",
      }),
    );
    expect(statusJson.routes[0]).toHaveProperty("effectiveSafetyProfile");
    expect(statusJson.routes[0]).not.toHaveProperty("kind");
    expect(Array.isArray(statusJson.skippedRoutes)).toBe(true);

    const chat = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "local-test",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as {
      choices: Array<{ message: { content: string } }>;
      harness_router: { route: string };
    };
    expect(body.choices[0]!.message.content).toBe("hello response");
    expect(body.harness_router.route).toBe("local");
    expect(body.harness_router).toHaveProperty("skippedRoutes");
  });

  it("surfaces skipped routes in REST chat completions", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`, {
      includePaidRoute: true,
    });
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const chat = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "local-test",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as {
      harness_router: { skippedRoutes?: Array<{ route: string; code: string }> };
    };
    expect(body.harness_router.skippedRoutes).toEqual([
      expect.objectContaining({ route: "paid_openai", code: "paid_blocked" }),
    ]);
  });

  it("streams chat completions as SSE", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "local-test",
        stream: true,
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hello");
    expect(text).toContain("[DONE]");
  });

  it("rejects explicit write-capable fanout until workspace isolation is available", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "local-test",
        mode: "fanout",
        safetyProfile: "workspace_edit",
        messages: [{ role: "user", content: "edit files" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_isolation_required");
  });

  it("allows explicit write-capable fanout with copy-isolated workspaces", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-http-copy-"));

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "local-test",
        mode: "fanout",
        safetyProfile: "workspace_edit",
        workspacePolicy: "copy",
        workingDir,
        messages: [{ role: "user", content: "edit files" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      harness_router?: { mode?: string };
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.harness_router?.mode).toBe("fanout");
    expect(body.choices[0]!.message.content).toContain("workspace");
  });

  it("serves MCP tools and resources over the same authenticated HTTP server", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: {
          headers: { authorization: "Bearer secret" },
        },
      },
    );
    const client = new Client({ name: "http-test", version: "test" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["code", "job", "usage"]);
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
        "harness-router://status",
        "harness-router://status.json",
      ]);
    } finally {
      await client.close();
    }
  });
});
