import { describe, expect, it, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, TOOL_NAMES } from "../../src/mcp/tools.js";
import { buildMcpServerInstance } from "../../src/mcp/server.js";
import { registerResources } from "../../src/mcp/resources.js";
import { ConfigHotReloader, RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { LeaderboardCache } from "../../src/leaderboard.js";
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
    leaderboardModel: `${name}-model`,
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

function stubLeaderboard(): LeaderboardCache {
  const lb = new LeaderboardCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lb as any).fetchedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lb as any).data = { "a-model": 1400, "b-model": 1300 };
  return lb;
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
  const leaderboard = stubLeaderboard();
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, router, leaderboard, mtimeMs: 0 };
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

  it("dispatch round-trips through the in-memory transport", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "dispatch",
        arguments: { prompt: "say hi", hints: { taskType: "plan" } },
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
      expect(text.contents[0]!.text).toContain("harness-dispatch status");

      const json = await client.readResource({ uri: "harness-dispatch://status.json" });
      const parsed = JSON.parse(String(json.contents[0]!.text)) as {
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
    // The guard wraps the SDK's CallTool handler and forwards `extra`, which
    // is what carries `sendNotification` and the progress token. Dropping it
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
        undefined,
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
