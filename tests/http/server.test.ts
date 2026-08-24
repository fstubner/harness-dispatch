import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-http-"));
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

  it("reports a busy port as one actionable line, not an unhandled error event", async () => {
    // A listen failure arrives as an 'error' EVENT, not a rejected call, so
    // with no handler Node rethrew it from the event loop and `serve --port
    // <busy>` printed `node:events:486 throw er; // Unhandled 'error' event`
    // followed by a stack. Every other bad-input path in this CLI answers with
    // one line, and a port already in use is the most ordinary of them.
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);

    const first = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(first);

    await expect(
      startHttpServer({ configPath: config, token: "secret", port: first.port }),
    ).rejects.toThrow(/already in use/);
  });

  it("does not blame privileges for an EACCES on a high port", async () => {
    // The first version of the message asserted "ports below 1024 need
    // elevated privileges" for EVERY EACCES. On Windows a HIGH port is refused
    // just as often, because the OS reserves whole ranges — and there
    // elevation changes nothing. Observed live on port 39271. Naming a cause
    // that does not apply sends people to fix the wrong thing, which is worse
    // than the stack trace it replaced.
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);

    const listen = await import("node:http");
    const spy = vi
      .spyOn(listen.Server.prototype, "listen")
      .mockImplementation(function (this: Server): Server {
        const err = new Error("listen EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        setImmediate(() => this.emit("error", err));
        return this;
      });
    try {
      const err = await startHttpServer({
        configPath: config,
        token: "secret",
        port: 39271,
      }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/not permitted to bind/);
      expect(err?.message).toMatch(/reserved/);
      // The unconditional privileges claim must be gone.
      expect(err?.message).not.toMatch(/^.*Ports below 1024 need elevated privileges/);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when binding to loopback (default)", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handle = await startHttpServer({ configPath: config, token: "secret" });
      handles.push(handle);
      const warned = stderr.mock.calls.some((call) => String(call[0]).includes("WARNING"));
      expect(warned).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("warns on stderr when --host binds beyond loopback", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handle = await startHttpServer({
        configPath: config,
        token: "secret",
        host: "0.0.0.0",
      });
      handles.push(handle);
      const warning = stderr.mock.calls.map((call) => String(call[0])).find((s) => s.includes("WARNING"));
      expect(warning).toBeDefined();
      expect(warning).toContain("0.0.0.0");
      expect(warning).toContain("network");
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects an oversized request body with 413 instead of buffering it all into memory", async () => {
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const oversized = "x".repeat(10 * 1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "local", messages: [{ role: "user", content: oversized }] }),
    });
    expect(res.status).toBe(413);
  }, 20000);

  it.each([["single"], ["fanout"]])(
    "enforces routePolicy in %s mode, not just in the one that was tested",
    async (mode) => {
      // The parity table asserts routePolicy is HONOURED and passes — but it
      // reads parseChatRequest's output, so it can only see that the parser
      // kept the value. It cannot see past the parser, and fanout dropped it
      // AFTER parsing: runFanoutArms named three hint fields inline and
      // routeTo never learned about the fourth.
      //
      // So `{"mode":"fanout","hints":{"routePolicy":"blocked"}}` — documented
      // as "dry-run: block everything" — returned 200 having run a live agent
      // in the caller's working tree, while the identical single-mode request
      // was refused. One surface disagreeing with itself, under a green row.
      //
      // Asserted end-to-end against a real server and a real upstream,
      // because that is the only place the gap was visible.
      const fake = await startFakeOpenAi();
      fakes.push(fake);
      const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
      const handle = await startHttpServer({ configPath: config, token: "secret" });
      handles.push(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "hi",
          workingDir: process.cwd(),
          mode,
          hints: { routePolicy: "blocked" },
        }),
      });

      const text = await res.text();
      expect(text, `${mode} mode ran a dispatch the caller had blocked`).not.toMatch(
        /hello response/,
      );
    },
    30000,
  );

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
      harness_dispatch: { route: string; jobId?: string };
    };
    // "hello stream", not "hello response": the non-streaming path is backed
    // by the persisted job pipeline now (which streams the dispatch), so a
    // client that times out mid-run no longer loses the finished result.
    expect(body.choices[0]!.message.content).toBe("hello stream");
    expect(body.harness_dispatch.route).toBe("local");
    expect(body.harness_dispatch).toHaveProperty("skippedRoutes");
    // The recovery contract for clients that gave up mid-run: the jobId is in
    // the body AND in a header (headers arrive before the body, so even a
    // caller that only captured headers can retrieve the result later).
    expect(body.harness_dispatch.jobId).toMatch(/^job-\d+-[0-9a-f]{8}$/);
    expect(chat.headers.get("x-harness-dispatch-job-id")).toBe(body.harness_dispatch.jobId);
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
      harness_dispatch: { skippedRoutes?: Array<{ route: string; code: string }> };
    };
    expect(body.harness_dispatch.skippedRoutes).toEqual([
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
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-http-copy-"));

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
      harness_dispatch?: { mode?: string };
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.harness_dispatch?.mode).toBe("fanout");
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
      expect(tools.tools.map((tool) => tool.name)).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
        "harness-dispatch://status",
        "harness-dispatch://status.json",
      ]);
    } finally {
      await client.close();
    }
  });

  it("serves a second concurrent MCP session instead of hanging", async () => {
    // Regression test: Server.connect() throws if called twice on the same
    // instance, so the HTTP transport must build a fresh McpServer per
    // session. A prior version guarded connect() with `if (!connected)`,
    // which silently left every session after the first wired to nothing —
    // requests through it would hang forever rather than error.
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    const config = await writeConfig(`http://127.0.0.1:${fake.port}`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const makeClient = () =>
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: "Bearer secret" } },
      });

    const clientA = new Client({ name: "http-test-a", version: "test" }, { capabilities: {} });
    const clientB = new Client({ name: "http-test-b", version: "test" }, { capabilities: {} });
    await clientA.connect(makeClient());
    await clientB.connect(makeClient());
    try {
      const [toolsA, toolsB] = await Promise.all([
        clientA.listTools(),
        clientB.listTools(),
      ]);
      expect(toolsA.tools.map((tool) => tool.name)).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
      expect(toolsB.tools.map((tool) => tool.name)).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });
});
