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

/** A 200 that carries nothing usable, so the route fails and the router falls on. */
async function startUnusableOpenAi(): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Two endpoint routes, the first preferred, so a failure falls to the second. */
async function writeTwoRouteConfig(primary: string, secondary: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-http2-"));
  const file = path.join(dir, "config.yaml");
  const route = (name: string, baseUrl: string, tier: number): string[] => [
    `  ${name}:`,
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
    `    tier: ${tier}`,
    "    weight: 1",
    "    cli_capability: 1",
    "    capabilities:",
    "      execute: 1",
    "      plan: 1",
    "      review: 1",
    "",
  ];
  await fs.writeFile(
    file,
    ["services:", ...route("ep_primary", primary, 1), ...route("ep_secondary", secondary, 2)].join(String.fromCharCode(10)),
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

      // The route must be REPORTED skipped, not merely not-run.
      //
      // There are two enforcement points — eligibleRoutes filters, and routeTo
      // refuses whatever reaches it — and each alone keeps the upstream call
      // count at zero, so the assertion above passes with either one removed.
      // They are not interchangeable: only the filter produces skippedRoutes.
      // Drop it and the refusal survives as per-row `error` strings with an
      // empty skippedRoutes, which is the "reads correctly, reports nothing"
      // shape this file keeps finding.
      expect(text, `${mode} mode did not report WHY the route was skipped`).toMatch(
        /route_policy/,
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

  it("does NOT emit an SSE error frame when a fallback then succeeds", async () => {
    // The frame was written the moment a route failed — before the router had
    // tried the next one. So a request that succeeded on the fallback still
    // carried an `error` frame, ahead of its own answer. The OpenAI streaming
    // contract has no non-fatal error frame, so a client treating one as
    // terminal reported a failure for a request that worked. Reproduced by an
    // acceptance pass against the real server.
    const bad = await startUnusableOpenAi();
    const good = await startFakeOpenAi();
    fakes.push(bad, good);
    const config = await writeTwoRouteConfig(
      `http://127.0.0.1:${bad.port}/v1`,
      `http://127.0.0.1:${good.port}/v1`,
    );
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "local-test",
        stream: true,
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, "the fallback answer never arrived").toContain("hello");
    expect(text).toContain("[DONE]");
    expect(text, "a successful request carried an error frame").not.toContain('"error"');
  });

  it("DOES emit an error frame when every route fails", async () => {
    // The frame is deferred, not deleted. Losing it would trade a false
    // failure for a silent one, which is the worse direction.
    const bad1 = await startUnusableOpenAi();
    const bad2 = await startUnusableOpenAi();
    fakes.push(bad1, bad2);
    const config = await writeTwoRouteConfig(
      `http://127.0.0.1:${bad1.port}/v1`,
      `http://127.0.0.1:${bad2.port}/v1`,
    );
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "local-test",
        stream: true,
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    const text = await res.text();
    expect(text, "every route failed and nothing said so").toContain('"error"');
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

  it("leaves a durable trail for every fanout arm, not just a response", async () => {
    // These arms called router.routeTo directly, so an arm's work existed ONLY
    // inside the HTTP request: no job directory, no manifest, no partial log.
    // Kill the client or the server mid-fanout and every arm's output was
    // gone, with nothing on disk to salvage — while the MCP fanout had been
    // job-backed all along. PRODUCT.md names losing that trail as the defining
    // failure, so the two surfaces disagreed about the product's central
    // promise. An acceptance pass found it by reading.
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-http-fanout-jobs-"));
    const prev = process.env.HARNESS_DISPATCH_JOBS_DIR;
    process.env.HARNESS_DISPATCH_JOBS_DIR = jobsDir;
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    try {
      const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
      const handle = await startHttpServer({ configPath: config, token: "secret" });
      handles.push(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          model: "local-test",
          mode: "fanout",
          messages: [{ role: "user", content: "say hello" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        harness_dispatch?: { mode?: string };
        choices: Array<{ message: { content: string } }>;
      };

      // The RESPONSE SHAPE is unchanged - durability was never a contract
      // change, which is what made deferring this the wrong call.
      expect(body.harness_dispatch?.mode).toBe("fanout");
      const rows = JSON.parse(body.choices[0]!.message.content) as Array<{
        route: string;
        jobId?: string;
        success: boolean;
        output: string;
      }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.route).toBeDefined();
      expect(rows[0]!.success).toBe(true);

      // The trail: a jobId the caller can come back to, and a real job
      // directory on disk that outlives the request.
      expect(rows[0]!.jobId, "no jobId — nothing to salvage with").toBeDefined();
      const onDisk = await fs.readdir(jobsDir);
      expect(onDisk, "no job directory survived the request").toContain(rows[0]!.jobId);
      const manifest = await fs.readFile(
        path.join(jobsDir, rows[0]!.jobId!, "manifest.json"),
        "utf8",
      );
      expect(JSON.parse(manifest)).toMatchObject({ jobId: rows[0]!.jobId });
    } finally {
      if (prev === undefined) delete process.env.HARNESS_DISPATCH_JOBS_DIR;
      else process.env.HARNESS_DISPATCH_JOBS_DIR = prev;
      await fs.rm(jobsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);

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

/**
 * The one unauthenticated route.
 *
 * Every other endpoint requires the bearer token, so a deploy gate or a
 * container probe could not ask whether the process was up without being
 * handed a credential — and a health check that needs a secret is one most
 * orchestrators will not perform. `/v1/status` answers a richer question and
 * stays behind the token precisely because that answer is not for strangers.
 *
 * These assertions are as much about what it does NOT say as what it does.
 */
describe("GET /health", () => {
  it("answers without a token", async () => {
    const s = await startHttpServer({ configPath: await writeConfig("http://127.0.0.1:1/v1"), port: 0, host: "127.0.0.1", token: "secret" });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("harness-dispatch");
      expect(typeof body.version).toBe("string");
    } finally {
      await s.close();
    }
  });

  it("discloses nothing beyond liveness and version", async () => {
    // Route ids, endpoint URLs, quota, breaker state and the token itself are
    // all things `/v1/status` will tell an authenticated caller and this must
    // not tell anyone. Asserted as an exact key set so a future field has to
    // be added here deliberately rather than leaking by accident.
    const s = await startHttpServer({ configPath: await writeConfig("http://127.0.0.1:1/v1"), port: 0, host: "127.0.0.1", token: "secret" });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${s.port}/health`)).json()) as object;
      expect(Object.keys(body).sort()).toEqual(["service", "status", "version"]);
      const text = JSON.stringify(body);
      expect(text).not.toContain(s.token ?? "\u0000no-token");
      for (const leak of ["baseUrl", "apiKey", "routes", "quota", "breaker"]) {
        expect(text).not.toContain(leak);
      }
    } finally {
      await s.close();
    }
  });

  it("still requires a token for the detailed status", async () => {
    const s = await startHttpServer({ configPath: await writeConfig("http://127.0.0.1:1/v1"), port: 0, host: "127.0.0.1", token: "secret" });
    try {
      expect((await fetch(`http://127.0.0.1:${s.port}/v1/status`)).status).toBe(401);
    } finally {
      await s.close();
    }
  });
});

describe("MCP sessions that never come into existence", () => {
  /**
   * The per-session `McpServer` and transport are built BEFORE it is known
   * whether the request is an `initialize`. For anything else carrying an
   * unknown session id the SDK answers 400 without initialising, so
   * `onsessioninitialized` never fires (nothing enters the transport map) and
   * `onclose` never fires (nothing leaves the server set).
   *
   * An acceptance pass counted five POSTs with unknown session ids leaving
   * five orphaned servers alive until shutdown. A valid token is all it takes,
   * so any authorised client with a stale session id leaks one per request.
   */
  it("does not leave a server behind for every rejected request", async () => {
    const fake = await startFakeOpenAi();
    const config = await writeConfig(`http://127.0.0.1:${fake.port}/v1`);
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    try {

    expect(handle.openMcpSessions()).toBe(0);

    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": `no-such-session-${i}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list", params: {} }),
      }).catch(() => undefined);
    }

    expect(
      handle.openMcpSessions(),
      "one MCP server leaked per rejected request",
    ).toBe(0);
    } finally {
      await handle.close();
      await fake.close();
    }
  });
});
