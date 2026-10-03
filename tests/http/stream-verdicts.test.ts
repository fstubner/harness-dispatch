/**
 * What a streamed or session-bound HTTP request tells the caller when it did
 * NOT succeed, and what it reports about how it ran.
 *
 * A streamed response has already sent its 200 by the time anything goes
 * wrong, so the only way to say so is a frame. Each of these was a stream that
 * ended in a clean `finish_reason: "stop"` and `[DONE]` while the same request
 * non-streaming answered 500 or 502.
 */
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cancelJob } from "../../src/jobs.js";
import { startHttpServer, type HttpServerHandle } from "../../src/http/server.js";
import { BadRequestError, parseChatRequest } from "../../src/http/parse.js";

const ROUTE_LINES = (name: string, baseUrl: string, tier: number): string[] => [
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

async function writeRoutes(routes: Array<[string, string]>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-http-verdicts-"));
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    ["services:", ...routes.flatMap(([n, u], i) => ROUTE_LINES(n, u, i + 1))].join("\n"),
    "utf-8",
  );
  return file;
}

type Fake = { port: number; close(): Promise<void> };

async function listen(handler: Parameters<typeof createServer>[1]): Promise<Fake> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Always answers, with no choices: a route failure. */
const unusable = () =>
  listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [] }));
  });

/** Answers `hello` as a stream or as JSON. */
const answering = () =>
  listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { stream?: boolean };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }));
  });

/** Takes the request and never answers, so a run stays open until cancelled. */
const hanging = () =>
  listen(() => {
    // held open on purpose
  });

function frames(sse: string): Array<Record<string, any>> {
  return sse
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((p) => p.startsWith("{"))
    .map((p) => JSON.parse(p) as Record<string, any>);
}

describe("HTTP verdicts", () => {
  const handles: HttpServerHandle[] = [];
  const fakes: Fake[] = [];
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
    await Promise.all(fakes.splice(0).map((f) => f.close()));
  });

  async function serve(routes: Fake[]): Promise<HttpServerHandle> {
    fakes.push(...routes);
    const config = await writeRoutes(
      routes.map((r, i) => [`ep_${i}`, `http://127.0.0.1:${r.port}/v1`] as [string, string]),
    );
    const handle = await startHttpServer({ configPath: config, token: "secret" });
    handles.push(handle);
    return handle;
  }

  const post = (h: HttpServerHandle, body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
    });

  it("ends a CANCELLED stream with an error frame, not an empty success", async () => {
    const h = await serve([await hanging()]);
    const res = await post(h, { stream: true });
    const jobId = res.headers.get("x-harness-dispatch-job-id")!;
    expect(jobId).toMatch(/^job-/);
    await cancelJob(jobId, "test");
    const out = frames(await res.text());
    const error = out.find((f) => f.error !== undefined);
    expect(error, "a cancelled stream looked like an empty answer").toBeDefined();
    expect(String(error!.error.message)).toMatch(/[Cc]ancelled/);
  }, 30_000);

  it("ends a streamed fanout with an error frame when every arm failed", async () => {
    const h = await serve([await unusable(), await unusable()]);
    const res = await post(h, { stream: true, mode: "fanout" });
    const out = frames(await res.text());
    const error = out.find((f) => f.error !== undefined);
    expect(error, "every arm failed and the stream said nothing").toBeDefined();
    expect(String(error!.error.message)).toMatch(/every fanout arm failed/);
  }, 30_000);

  it("names the routed model on a streamed answer, as the buffered reply does", async () => {
    const h = await serve([await answering()]);
    const buffered = (await (await post(h, {})).json()) as { model: string };
    const streamed = frames(await (await post(h, { stream: true })).text());
    expect(streamed.length).toBeGreaterThan(0);
    expect(buffered.model).not.toBe("harness-dispatch");
    // Every frame from the answer on, the stop frame included, carries it.
    expect(streamed.at(-1)!.model).toBe(buffered.model);
  }, 30_000);

  it("carries the workingDir warning on a streamed single-route reply", async () => {
    const h = await serve([await answering()]);
    const out = frames(await (await post(h, { stream: true })).text());
    expect(JSON.stringify(out)).toMatch(/workingDir was not provided/);
  }, 30_000);

  it("rejects a NUL byte in the top-level model like it does in hints.model", () => {
    const body = { messages: [{ role: "user", content: "hi" }], workingDir: process.cwd() };
    expect(() => parseChatRequest({ ...body, model: "gpt-5\u0000x" })).toThrow(BadRequestError);
    expect(() => parseChatRequest({ ...body, model: "gpt-5\u0000x" })).toThrow(/NUL/);
  });

  it("answers 404 for an MCP session id it does not hold, so a client re-initialises", async () => {
    const h = await serve([await answering()]);
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST",
      headers: { ...auth, accept: "application/json, text/event-stream", "mcp-session-id": "gone" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(h.openMcpSessions()).toBe(0);
  });

  it("tells a caller with no token where to find it", async () => {
    const h = await serve([await answering()]);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/status`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.hint).toMatch(/auth show/);
  });
});
