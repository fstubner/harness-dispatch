import { describe, expect, it, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, TOOL_NAMES } from "../../src/mcp/tools.js";
import { registerResources } from "../../src/mcp/resources.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
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
    { name: "harness-router-test", version: "test" },
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
  it("registers exactly the code tool", async () => {
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

  it("code round-trips through the in-memory transport", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "code",
        arguments: { prompt: "say hi", hints: { taskType: "plan" } },
      });
      expect(resp.isError).not.toBe(true);
      const content = resp.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        mode: "single";
        success: boolean;
        route: string;
        output: string;
      };
      expect(parsed.mode).toBe("single");
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
        "harness-router://status",
        "harness-router://status.json",
      ]);

      const text = await client.readResource({ uri: "harness-router://status" });
      expect(text.contents[0]!.text).toContain("harness-router status");

      const json = await client.readResource({ uri: "harness-router://status.json" });
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
