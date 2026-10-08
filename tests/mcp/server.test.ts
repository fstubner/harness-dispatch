import { describe, expect, it, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { registerTools, TOOL_NAMES } from "../../src/mcp/tools.js";
import { buildMcpServerInstance } from "../../src/mcp/server.js";
import { registerResources } from "../../src/mcp/resources.js";
import { ConfigHotReloader, RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatcherEvent,
  DispatchResult,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

class StubDispatcher implements Dispatcher {
  readonly id: string;
  constructor(id: string, private readonly reply: string) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return { output: this.reply, service: this.id, success: true };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    const result = { output: this.reply, service: this.id, success: true };
    yield { type: "stdout", chunk: this.reply };
    yield { type: "completion", result };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

function makeSvc(name: string, harness: string): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness,
    command: name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: [],
    model: `${name}-model`,
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    provider: "local",
    surface: "local_endpoint",
    authSource: "local_network",
    billingKind: "local_compute",
    paidUsagePossible: false,
    billingConfidence: "documented",
  };
}

function buildState(): RuntimeState {
  const services = {
    a: makeSvc("a", "claude_code"),
    b: makeSvc("b", "codex"),
  };
  const dispatchers: Record<string, Dispatcher> = {
    a: new StubDispatcher("a", "answer-from-a"),
    b: new StubDispatcher("b", "answer-from-b"),
  };
  const config: RouterConfig = { services };
  const quota = new QuotaCache(dispatchers);
  const router = new Router(config, quota, dispatchers);
  return { config, dispatchers, quota, router, mtimeMs: 0 };
}

vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);

async function startLinked(): Promise<{
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}> {
  const server = new McpServer(
    { name: "harness-dispatch-test", version: "test" },
    { instructions: "test server" },
  );
  const holder = new RuntimeHolder(buildState());
  registerTools(server, { holder });
  registerResources(server, { holder });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "test" },
    { capabilities: {} },
  );

  await server.connect(serverT);
  await client.connect(clientT);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP server — public surface", () => {
  it("registers exactly the public tools", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.listTools();
      expect(resp.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const hints = (resp.tools[0]!.inputSchema.properties as Record<string, unknown>)
        .hints as { properties?: Record<string, unknown> };
      const hintKeys = Object.keys(hints.properties ?? {});
      expect(hintKeys).toContain("safetyProfile");
      expect(hintKeys).not.toContain("service");
      expect(hintKeys).not.toContain("harness");
    } finally {
      await close();
    }
  });

  it("annotates the tools so a client can tell polling from stopping work", async () => {
    // No tool carried annotations, so a client that honours them could not
    // auto-approve `job_status` or `usage`, nor warn on `workspace discard`.
    const { client, close } = await startLinked();
    try {
      const byName = Object.fromEntries(
        (await client.listTools()).tools.map((t) => [t.name, t.annotations]),
      );
      expect(byName["job_status"]?.readOnlyHint).toBe(true);
      expect(byName["usage"]?.readOnlyHint).toBe(true);
      expect(byName["cancel_job"]?.destructiveHint).toBe(true);
      expect(byName["workspace"]?.destructiveHint).toBe(true);
      // dispatch starts work that can edit files: never advertised read-only.
      expect(byName["dispatch"]?.readOnlyHint).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("dispatch round-trips through the in-memory transport", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "dispatch",
        arguments: { prompt: "say hi", workingDir: process.cwd(), hints: { taskType: "plan" } },
      });
      expect(resp.isError).not.toBe(true);
      const content = resp.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        mode: "single";
        completed: boolean;
        success: boolean;
        route: string;
        output: string;
      };
      expect(parsed.mode).toBe("single");
      expect(parsed.completed).toBe(true);
      expect(parsed.success).toBe(true);
      expect(["a", "b"]).toContain(parsed.route);
      expect(parsed.output.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("lists and reads the two public status resources", async () => {
    const { client, close } = await startLinked();
    try {
      const listed = await client.listResources();
      expect(listed.resources.map((r) => r.uri).sort()).toEqual([
        "harness-dispatch://status",
        "harness-dispatch://status.json",
      ]);

      const text = await client.readResource({ uri: "harness-dispatch://status" });
      expect((text.contents[0] as { text: string }).text).toContain("harness-dispatch status");

      const json = await client.readResource({ uri: "harness-dispatch://status.json" });
      const parsed = JSON.parse(String((json.contents[0] as { text: string }).text)) as {
        routes: Array<Record<string, unknown>>;
        skippedRoutes: unknown[];
      };
      expect(parsed.routes).toHaveLength(2);
      expect(parsed.routes[0]).toHaveProperty("billing");
      expect(parsed.routes[0]).toHaveProperty("effectiveSafetyProfile");
      expect(parsed.routes[0]).not.toHaveProperty("kind");
      expect(Array.isArray(parsed.skippedRoutes)).toBe(true);
    } finally {
      await close();
    }
  });
});

/**
 * A near-miss TOP-LEVEL key asked for read-only and got write access.
 *
 * `safteyProfile: "read_only"` was accepted in silence — the SDK validates
 * against `z.object(shape)` and zod STRIPS unknown keys, so no handler ever saw
 * it — and the dispatch then ran at the `workspace_edit` default. An acceptance
 * pass measured it writing a file into the project. The HTTP surface has
 * rejected the same input all along, so one input got two opposite answers.
 *
 * These build through `buildMcpServerInstance`, the REAL production builder,
 * rather than the helper above. The helper constructs its own McpServer, so a
 * guard installed only there would keep these green while production shipped
 * without it — the "correct but never delivered" hole this project keeps
 * finding in its own tests.
 */
describe("MCP server — near-miss top-level keys", () => {
  async function startProductionLinked(): Promise<{ client: Client; close: () => Promise<void> }> {
    const holder = new RuntimeHolder(buildState());
    const server = buildMcpServerInstance(holder, new ConfigHotReloader(holder, undefined));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "typo-test", version: "test" }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    return {
      client,
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  it("refuses a transposed safetyProfile instead of running with more access", async () => {
    const { client, close } = await startProductionLinked();
    try {
      await expect(
        client.callTool({
          name: "dispatch",
          arguments: { prompt: "hi", workingDir: process.cwd(), safteyProfile: "read_only" },
        }),
      ).rejects.toThrow(/did you mean safetyProfile/);
    } finally {
      await close();
    }
  });

  it("refuses a near-miss on the other hint names too", async () => {
    // One name fixed would be a special case, not a rule.
    const { client, close } = await startProductionLinked();
    try {
      await expect(
        client.callTool({
          name: "dispatch",
          arguments: { prompt: "hi", workingDir: process.cwd(), workspacePolcy: "copy" },
        }),
      ).rejects.toThrow(/did you mean workspacePolicy/);
    } finally {
      await close();
    }
  });

  it("tells the caller WHERE the key goes, so following the advice works", async () => {
    // Correcting `safteyProfile` to `safetyProfile` at the top level of
    // `dispatch` lands on a z.never() trap — a SECOND rejection. That is the
    // failure tool-schemas.ts already records from its own snake_case traps:
    // "a refusal that confidently points at the wrong landing spot costs the
    // round trip it exists to save". The rule was re-learned there and not
    // applied to this message until an acceptance pass measured it.
    const { client, close } = await startProductionLinked();
    try {
      await expect(
        client.callTool({
          name: "dispatch",
          arguments: { prompt: "hi", workingDir: process.cwd(), safteyProfile: "read_only" },
        }),
      ).rejects.toThrow(/inside `hints`/);
    } finally {
      await close();
    }
  });

  it("names a top-level key as top-level, not as a hint", async () => {
    // `workspacePolicy` and `workingDir` ARE top-level dispatch parameters, so
    // sending the caller to `hints` would be the same defect mirrored.
    const { client, close } = await startProductionLinked();
    try {
      await expect(
        client.callTool({
          name: "dispatch",
          arguments: { prompt: "hi", workingDir: process.cwd(), workspacePolcy: "copy" },
        }),
      ).rejects.toThrow(/top level/);
    } finally {
      await close();
    }
  });

  it("does not promise a safety consequence on a tool that dispatches nothing", async () => {
    // The guard fires on every tool, and the message was written for
    // `dispatch`. On `job_status` the corrected spelling is not a field
    // either — and "the run gets MORE access than you asked for" is simply
    // false, since job_status runs nothing. An acceptance pass followed the
    // advice and watched the corrected key be silently ignored.
    const { client, close } = await startProductionLinked();
    try {
      const err = await client
        .callTool({ name: "job_status", arguments: { safteyProfile: "read_only" } })
        .then(() => undefined)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(err).toBeDefined();
      expect(err).toContain("job_status");
      expect(err, "promised a safety consequence on a tool that runs nothing").not.toContain(
        "MORE access",
      );
    } finally {
      await close();
    }
  });

  it("leaves `_meta` and other legitimate unknown keys alone", async () => {
    // The outer object cannot be strict — MCP carries `_meta` there — so the
    // guard must reject near misses and nothing else. Rejecting `_meta` would
    // break every compliant client.
    const { client, close } = await startProductionLinked();
    try {
      const res = await client.callTool({
        name: "job_status",
        arguments: { _meta: { progressToken: "t" }, somethingUnrelated: true },
      });
      expect(res).toBeDefined();
    } finally {
      await close();
    }
  });

  it("still delivers progress notifications through the wrapper", async () => {
    // The guard wraps the SDK's tools/call handler and forwards the handler
    // context, which is what carries `notify` and the progress token (on SDK
    // v1 it was `extra` and `sendNotification`). Dropping it
    // would silence progress for EVERY tool call — and an acceptance pass
    // changed `handler(request, extra)` to `handler(request, undefined)` and
    // watched the full suite pass, 1041 tests, zero failures. The one thing
    // this wrapper could most plausibly break had nothing holding it.
    const { client, close } = await startProductionLinked();
    const seen: number[] = [];
    try {
      await client.callTool(
        {
          name: "dispatch",
          arguments: {
            prompt: "hi",
            workingDir: process.cwd(),
            hints: { taskType: "plan" },
          },
        },
        {
          onprogress: (p: { progress: number }) => {
            seen.push(p.progress);
          },
        },
      );
      expect(seen.length, "no progress notification reached the client").toBeGreaterThan(0);
    } finally {
      await close();
    }
  }, 30_000);

  it("accepts the CORRECT spelling, which is the whole point", async () => {
    const { client, close } = await startProductionLinked();
    try {
      const res = await client.callTool({
        name: "dispatch",
        arguments: {
          prompt: "hi",
          workingDir: process.cwd(),
          hints: { safetyProfile: "read_only", taskType: "plan" },
        },
      });
      expect(res).toBeDefined();
    } finally {
      await close();
    }
  });
});

describe("MCP server — operator instructions", () => {
  // A route's `instructions:` is policy the calling agent should follow when it
  // picks a model; `usage` is where agents look before choosing one.
  it("shows a route's instructions in the usage tool's answer", async () => {
    const state = buildState();
    state.config.services["a"]!.instructions = "haiku for sweeps, opus only for hard judgment";
    const server = new McpServer({ name: "harness-dispatch-test", version: "test" }, {});
    const holder = new RuntimeHolder(state);
    registerTools(server, { holder });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "usage-test", version: "test" }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const resp = await client.callTool({ name: "usage", arguments: {} });
      const content = resp.content as Array<{ type: string; text: string }>;
      const usage = JSON.parse(content[0]!.text) as { routes: Array<{ id: string; instructions?: string }> };
      expect(usage.routes.find((r) => r.id === "a")?.instructions).toBe(
        "haiku for sweeps, opus only for hard judgment",
      );
      expect(usage.routes.find((r) => r.id === "b")?.instructions).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP server — who dispatched", () => {
  // Every session on the machine writes one dispatch log and one jobs
  // directory, so without the client and connection on each record the log
  // could say how routes performed but not which agent or session used them.
  it("records the connecting client and its session on the job and the log line", async () => {
    const { getAsyncJob } = await import("../../src/jobs.js");
    const { dispatchLogPath } = await import("../../src/dispatch-log.js");
    const { readFileSync } = await import("node:fs");
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "dispatch",
        arguments: { prompt: "say hi", workingDir: process.cwd(), hints: { taskType: "plan" } },
      });
      const content = resp.content as Array<{ type: string; text: string }>;
      const { jobId } = JSON.parse(content[0]!.text) as { jobId: string };
      const job = await getAsyncJob(jobId);
      expect(job.manifest.caller?.client).toBe("test-client");
      expect(job.manifest.caller?.clientVersion).toBe("test");
      expect(job.manifest.caller?.session).toMatch(/^[0-9a-f-]{36}$/);

      const line = readFileSync(dispatchLogPath(), "utf8")
        .split("\n")
        .filter((l) => l.includes(jobId))
        .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
      expect(line, "no dispatch log line for the job").toBeDefined();
      expect(line).toMatchObject({
        client: "test-client",
        clientVersion: "test",
        session: job.manifest.caller?.session,
        jobId,
      });
    } finally {
      await close();
    }
  });

  it("records a client that names itself per request and never sends initialize", async () => {
    // MCP 2026-07-28 drops the initialize handshake; a client speaking only
    // that revision names itself in each request's _meta instead.
    const { getAsyncJob } = await import("../../src/jobs.js");
    const server = new McpServer({ name: "harness-dispatch-test", version: "test" });
    registerTools(server, { holder: new RuntimeHolder(buildState()) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const reply = new Promise<{ result?: { content: Array<{ text: string }> }; error?: unknown }>((resolve) => {
      clientT.onmessage = (m) => {
        if ((m as { id?: unknown }).id === 1) resolve(m as never);
      };
    });
    await clientT.start();
    try {
      await clientT.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "dispatch",
          arguments: { prompt: "say hi", workingDir: process.cwd(), hints: { taskType: "plan" } },
          _meta: { "io.modelcontextprotocol/clientInfo": { name: "per-request-client", version: "9.9" } },
        },
      });
      const msg = await reply;
      expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
      const { jobId } = JSON.parse(msg.result!.content[0]!.text) as { jobId: string };
      const job = await getAsyncJob(jobId);
      expect(job.manifest.caller?.client).toBe("per-request-client");
      expect(job.manifest.caller?.clientVersion).toBe("9.9");
    } finally {
      await server.close();
    }
  });
});
