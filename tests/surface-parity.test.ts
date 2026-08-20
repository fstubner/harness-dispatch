/**
 * The MCP and HTTP surfaces must agree about what they reject — verified on
 * the surface that SHIPS.
 *
 * Four consecutive reviews found the same shape: a guard added to one surface
 * and not the other, or to one branch and not its sibling. The fifth found the
 * meta-instance: the misplaced-hints guard lived only in `invokeTool`, an
 * entry point used exclusively by tests, while the registered handlers let the
 * SDK strip the key silently — and THIS FILE passed, because it asserted
 * against `invokeTool` too. A test suite that drives a convenience export
 * instead of the registered handler verifies a surface nothing ships.
 *
 * So these tests connect a real MCP client to a real McpServer over the SDK's
 * in-memory transport and call the registered tools — the same validation
 * path (SDK-side schema parse) a production client hits over stdio or HTTP.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMcpServer } from "../src/mcp/server.js";

let dir: string;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-parity-live-"));
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, "clis: []\nendpoints: []\n", "utf8");

  const { server } = await buildMcpServer({ configPath });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "parity-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The SDK reports input-validation failure as a CallToolResult with
 * `isError: true` (a tool-level error the calling agent can read), not as a
 * JSON-RPC rejection — so the error channel to assert on is the resolved
 * result's content. Returns the error text, or undefined if the call was not
 * an error.
 */
async function dispatchError(args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const r = await client.callTool({ name: "dispatch", arguments: args });
    if (!(r as { isError?: boolean }).isError) return undefined;
    const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
    return content.map((c) => c.text ?? "").join("\n");
  } catch (e) {
    return (e as Error).message;
  }
}

describe("misplaced hint keys are rejected by the registered dispatch tool", () => {
  // The trap the strict-hints fix created: `hints` became strict, so a caller
  // who hit that error and "corrected" it by promoting the key one level got
  // a SILENT fail-open instead — the dispatch ran with more access than asked.
  it.each(["safetyProfile", "routePolicy", "taskType", "timeoutMs", "model"])(
    "rejects top-level %s with a message naming hints",
    async (key) => {
      expect(await dispatchError({ prompt: "hi", [key]: "read_only" })).toMatch(
        /belongs inside `hints`/,
      );
    },
  );

  it("names the consequence, not just the mistake", async () => {
    expect(await dispatchError({ prompt: "hi", safetyProfile: "read_only" })).toMatch(
      /MORE access than you asked for/,
    );
  });

  it("points escalate at config.yaml, not at hints", async () => {
    // hints is strict and has no `escalate` key, so "put it in hints" would
    // send the caller straight into a second rejection.
    const err = await dispatchError({ prompt: "hi", escalate: true });
    expect(err).toMatch(/escalate_model/);
    expect(err).not.toMatch(/belongs inside `hints`/);
  });

  it("advertises the trap keys as unacceptable in the tool schema", async () => {
    // z.never() renders as {"not":{}} — a client that reads the schema sees
    // the key is refused, not merely undocumented. If the traps ever fall out
    // of the advertised schema, the SDK would go back to stripping them
    // silently, so this assertion is load-bearing, not cosmetic.
    const tools = await client.listTools();
    const dispatch = tools.tools.find((t) => t.name === "dispatch");
    const props = (dispatch?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    for (const key of ["safetyProfile", "routePolicy", "taskType", "timeoutMs", "model"]) {
      expect(props![key], `schema is missing the ${key} trap`).toBeDefined();
      expect(JSON.stringify(props![key])).toContain('"not"');
    }
  });

  it("still accepts the correct placement", async () => {
    // Must not reject legitimate callers — the guard names specific keys
    // rather than applying .strict() to the outer object, so an MCP client
    // attaching its own fields still works.
    //
    // This call fails later for an unrelated reason (no configured routes);
    // what matters is only that it is not turned away at the boundary.
    //
    // Default grace on purpose (NOT graceSeconds: 0): the reply must not
    // arrive until the background run has fully landed. Fire-and-forget left
    // a failing job still writing while this file's teardown deleted the
    // jobs dir under it — an unhandled rejection on the POSIX CI legs.
    const err = await dispatchError({
      prompt: "hi",
      hints: { safetyProfile: "read_only" },
    });
    expect(err ?? "").not.toMatch(/belongs inside `hints`/);
    // Explicit timeout: this is the one case here that waits on a real
    // detached job runner (spawned from dist/) rather than being rejected at
    // the boundary, and it exceeded vitest's 15s default under full-suite
    // parallel load. Waiting is deliberate — abandoning the run mid-write is
    // what caused the CI unhandled rejection this file already fixed once.
  }, 45_000);

  it("rejects an unknown key inside hints", async () => {
    // `safety_profile` is the config.yaml spelling. Accepting it silently
    // disabled a safety limit.
    const err = await dispatchError({ prompt: "hi", hints: { safety_profile: "read_only" } });
    expect(err).toMatch(/safety_profile|unrecognized|Unrecognized/);
  });
});
