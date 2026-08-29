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

import { z } from "zod";

import { buildMcpServer } from "../src/mcp/server.js";
import { dispatchInputShape } from "../src/mcp/tool-schemas.js";
import { workspacePolicyFromInput } from "../src/mcp/tools.js";
import { BadRequestError, parseChatRequest } from "../src/http/parse.js";
import type { RouteHints } from "../src/types.js";

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
  // Best effort, and deliberately not fatal.
  //
  // One test here asserts that MCP does NOT reject a near-miss key, which can
  // only be asserted by starting a real background run. It is cancelled and
  // waited for, but on Windows the runner's handle on the working directory
  // can outlive its exit, so rmdir hits EBUSY — and a suite where all 943
  // tests passed then reported failure for a temp directory. The directory is
  // under the OS temp root, which the OS reclaims; what is under test here is
  // parity, not cleanup.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    () => undefined,
  );
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

/**
 * The same input, put to BOTH surfaces, asserted to get the same answer.
 *
 * This file was named for that invariant and did not check it: every
 * assertion above drives the MCP client, and `parseChatRequest` — the entirety
 * of the HTTP surface's validation — was never imported. Five consecutive
 * reviews each found a fresh divergence, and each was fixed one instance at a
 * time, which is what happens when the check is a habit rather than a test.
 * The list below is those instances plus the fields around them.
 *
 * A row is not "HTTP rejects X". It is "the two surfaces agree about X", so
 * adding a guard to one and forgetting the other fails here regardless of
 * WHICH one was forgotten. That is the only property worth pinning: every
 * divergence so far has been a guard that exists on one side.
 *
 * Kept as data rather than prose so the next field is one line, not a
 * judgement call about whether it is worth a test.
 */
describe("both surfaces answer the same input the same way", () => {
  const REJECTED: Array<[label: string, body: Record<string, unknown>]> = [
    ["a whitespace-only prompt", { prompt: "   " }],
    ["a NUL byte in the prompt", { prompt: `has${String.fromCharCode(0)}nul` }],
    ["a blank hints.model", { prompt: "hi", hints: { model: "" } }],
    ["a whitespace hints.model", { prompt: "hi", hints: { model: "   " } }],
    ["a wrong-typed hints.model", { prompt: "hi", hints: { model: 123 } }],
    ["a wrong-typed hints.preferLargeContext", { prompt: "hi", hints: { preferLargeContext: "y" } }],
    ["a wrong-typed hints.timeoutMs", { prompt: "hi", hints: { timeoutMs: "5000" } }],
    ["a zero hints.timeoutMs", { prompt: "hi", hints: { timeoutMs: 0 } }],
    ["a negative hints.timeoutMs", { prompt: "hi", hints: { timeoutMs: -5 } }],
    ["a fractional hints.timeoutMs", { prompt: "hi", hints: { timeoutMs: 1.5 } }],
    ["a non-object hints", { prompt: "hi", hints: "workspace_edit" }],
    ["an unknown hints key", { prompt: "hi", hints: { safety_profile: "read_only" } }],
    ["a typo'd hints.safetyProfile", { prompt: "hi", hints: { safetyProfile: "read_onlyy" } }],
    ["a typo'd hints.taskType", { prompt: "hi", hints: { taskType: "excute" } }],
    ["a typo'd hints.routePolicy", { prompt: "hi", hints: { routePolicy: "bloked" } }],
    ["a typo'd hints.workspacePolicy", { prompt: "hi", hints: { workspacePolicy: "copyy" } }],
    ["a typo'd mode", { prompt: "hi", mode: "fanou" }],
    ["a non-string files entry", { prompt: "hi", files: [1] }],
    ["a non-string models entry", { prompt: "hi", models: [1] }],
    // setTimeout clamps anything past this to 1ms, so the longest timeout
    // askable becomes the shortest possible — the child dies on the first tick
    // and the ROUTE is blamed. Accepted on HTTP until 2026-08-24 because
    // zod's .int() stops at MAX_SAFE_INTEGER, far past where it breaks.
    ["an over-large hints.timeoutMs", { prompt: "hi", hints: { timeoutMs: 1e21 } }],
    ["a hints.timeoutMs past setTimeout's ceiling", { prompt: "hi", hints: { timeoutMs: 2_147_483_648 } }],
    // argv-bound strings. Only `prompt` was guarded, on BOTH surfaces — so
    // parity held while both were wrong, which is the one shape a parity row
    // cannot catch and the reason these are listed individually.
    ["a NUL in files", { prompt: "hi", files: [`a${String.fromCharCode(0)}b`] }],
    ["a NUL in models", { prompt: "hi", models: [`a${String.fromCharCode(0)}b`] }],
    ["a NUL in hints.model", { prompt: "hi", hints: { model: `a${String.fromCharCode(0)}b` } }],
    ["escalate, which is per-route config and not a dispatch field", { prompt: "hi", escalate: true }],
    // The config.yaml spelling one level up. `hints` is strict on both
    // surfaces because this slip disabled a safety limit; the OUTER object
    // cannot be (MCP carries _meta, HTTP carries OpenAI's own fields), so the
    // same typo stayed silent on BOTH — parity holding while both were wrong,
    // the one shape a parity row cannot find. Named rows are the answer.
    ["a top-level safety_profile", { prompt: "hi", safety_profile: "read_only" }],
    ["a top-level route_policy", { prompt: "hi", route_policy: "local_only" }],
    ["a top-level task_type", { prompt: "hi", task_type: "review" }],
    ["a top-level working_dir", { prompt: "hi", working_dir: "/tmp" }],
    ["a null timeoutMs", { prompt: "hi", hints: { timeoutMs: null } }],
    ["a null preferLargeContext", { prompt: "hi", hints: { preferLargeContext: null } }],
    // A relative workingDir resolves against the SERVER's cwd, not the
    // caller's. `../..` exists, so every check passed and a real dispatch ran
    // somewhere neither party chose — and `defaulted` stays false, so not even
    // the omitted-value warning fires.
    ["a relative workingDir", { prompt: "hi", workingDir: ".." }],
    ["a bare relative workingDir", { prompt: "hi", workingDir: "some/sub" }],
    // An explicit empty `models` fell through to the same branch as omitting
    // it and fanned out to EVERY eligible route — eight arms on the machine
    // where an acceptance pass measured it. A caller who sent `[]` built a
    // list that came out empty; they did not ask for everything.
    ["an empty models array", { prompt: "hi", mode: "fanout", models: [] }],
  ];

  it.each(REJECTED)("both reject %s", async (_label, body) => {
    const mcpError = await dispatchError({ workingDir: dir, ...body });
    expect(mcpError, "MCP accepted it").toBeDefined();
    expect(() => parseChatRequest({ workingDir: dir, ...body })).toThrow(BadRequestError);
  });

  /**
   * Accepted AND honoured — the value has to come out the far side.
   *
   * An earlier version asserted only `not.toThrow()`, which cannot catch
   * accept-then-silently-drop. That is the shape of nearly every divergence
   * this file has found: `{"routePolicy":"local_only"}` returned 200 and the
   * dispatch left the machine anyway. A row that only proves "no error" would
   * have passed on every one of them.
   *
   * `read` pulls the value from each surface's own parsed output, so the row
   * fails if either side quietly discards it.
   */
  const HONOURED: Array<[label: string, body: Record<string, unknown>, read: (h: RouteHints) => unknown, want: unknown]> = [
    // Documented as the default in the MCP description, and absent from the
    // HTTP enum list until 2026-08-23 — so copying the documented value into
    // an HTTP body was an error for naming the thing that already happens.
    ["routePolicy in hints", { hints: { routePolicy: "local_only" } }, (h) => h.routePolicy, "local_only"],
    ["routePolicy: standard in hints", { hints: { routePolicy: "standard" } }, (h) => h.routePolicy, "standard"],
    ["taskType in hints", { hints: { taskType: "review" } }, (h) => h.taskType, "review"],
    ["safetyProfile in hints", { hints: { safetyProfile: "read_only" } }, (h) => h.safetyProfile, "read_only"],
    ["timeoutMs in hints", { hints: { timeoutMs: 5000 } }, (h) => h.timeoutMs, 5000],
    ["preferLargeContext in hints", { hints: { preferLargeContext: true } }, (h) => h.preferLargeContext, true],
    ["the largest timeoutMs setTimeout can hold", { hints: { timeoutMs: 2_147_483_647 } }, (h) => h.timeoutMs, 2_147_483_647],
  ];

  it.each(HONOURED)("both honour %s", (_label, body, read, want) => {
    // Asserted through each surface's parse rather than a live dispatch:
    // accepting means the run starts, and starting a dozen runs to prove a
    // dozen inputs parse would test the job runner, not the boundary.
    const mcp = z.object(dispatchInputShape).parse({ prompt: "hi", workingDir: dir, ...body });
    expect(read((mcp.hints ?? {}) as RouteHints), "MCP dropped it").toEqual(want);
    const http = parseChatRequest({ prompt: "hi", workingDir: dir, ...body });
    expect(read(http.hints), "HTTP dropped it").toEqual(want);
  });

  /**
   * The SAME hints at the TOP LEVEL of an HTTP body.
   *
   * MCP refuses top-level placement outright, and that is right there: a key
   * the SDK strips is a safety setting that silently does nothing. This
   * surface speaks the OpenAI wire format, where bodies are flat — and it
   * already honoured `safetyProfile` and `workspacePolicy` there, which taught
   * callers the placement works. The other four were DROPPED on a 200.
   *
   * So the placement rule diverges on purpose and the GUARANTEE does not: on
   * both surfaces, a hint you set either takes effect or you are told.
   */
  it.each([
    ["taskType", { taskType: "review" }, (h: RouteHints) => h.taskType, "review"],
    ["routePolicy", { routePolicy: "local_only" }, (h: RouteHints) => h.routePolicy, "local_only"],
    ["safetyProfile", { safetyProfile: "read_only" }, (h: RouteHints) => h.safetyProfile, "read_only"],
    ["timeoutMs", { timeoutMs: 5000 }, (h: RouteHints) => h.timeoutMs, 5000],
    ["preferLargeContext", { preferLargeContext: true }, (h: RouteHints) => h.preferLargeContext, true],
    ["workspacePolicy", { workspacePolicy: "copy" }, (h: RouteHints) => h.workspacePolicy, "copy"],
  ])("HTTP honours a top-level %s, and MCP refuses the placement by name", async (label, body, read, want) => {
    const http = parseChatRequest({ prompt: "hi", workingDir: dir, ...body });
    expect(read(http.hints), `top-level ${label} was dropped`).toEqual(want);

    // workspacePolicy is a real top-level MCP param, not a trap.
    if (label === "workspacePolicy") return;
    const err = await dispatchError({ prompt: "hi", workingDir: dir, ...body });
    expect(err, `MCP silently accepted a top-level ${label}`).toBeDefined();
  });

  it("prefers the nested hint when both placements are given, on both surfaces", () => {
    const body = { prompt: "hi", workingDir: dir, taskType: "plan", hints: { taskType: "review" } };
    const mcp = z.object(dispatchInputShape).safeParse(body);
    // MCP refuses the top-level half outright, so "nested wins" is trivially
    // true there; this pins that it refuses rather than silently preferring.
    expect(mcp.success).toBe(false);
    expect(parseChatRequest(body).hints.taskType).toBe("review");
  });

  it("takes workspacePolicy from the TOP level when both are given, on both surfaces", () => {
    // The one exception to "nested wins", and the source claimed otherwise
    // for a release. `workspacePolicy` is a real top-level MCP parameter
    // rather than a trap, and workspacePolicyFromInput has always resolved it
    // top-level-first — so both surfaces agree, and only the comment was
    // wrong. Pinned so it stays a decision rather than the next divergence.
    const body = {
      prompt: "hi",
      workingDir: dir,
      workspacePolicy: "shared",
      hints: { workspacePolicy: "git_worktree" },
    };
    // Through the REAL resolver, not a copy of its rule. Asserting
    // `mcp.workspacePolicy ?? mcp.hints?.workspacePolicy` here re-derived the
    // very thing under test, so flipping tools.ts to nested-first would have
    // left this row green — the same shape that let a fanout fail-open ship
    // under two passing rows.
    const mcp = z.object(dispatchInputShape).parse(body);
    expect(workspacePolicyFromInput(mcp)).toBe("shared");
    expect(parseChatRequest(body).hints.workspacePolicy).toBe("shared");
  });

  /**
   * Fields that exist on ONE surface, listed so their absence from the tables
   * above reads as a decision rather than an oversight. There is nothing to
   * agree about: `stream` selects SSE, which is a property of the HTTP
   * transport, and MCP dispatch always uses the grace window instead. The
   * MCP schema is non-strict at the top level, so it strips the key.
   *
   * They still get the same TREATMENT — a typo is refused, not coerced — which
   * is the part that was wrong: `{"stream":"true"}` returned a non-streaming
   * response on a 200, and the caller was never told.
   */
  it.each([
    ["stream", { stream: "true" }],
    ["stream", { stream: 1 }],
  ])("rejects a non-boolean %s on the surface that has it", (_label, body) => {
    expect(() => parseChatRequest({ prompt: "hi", workingDir: dir, ...body })).toThrow(
      BadRequestError,
    );
  });

  it("agrees that a blank top-level model is not a model", () => {
    // The one deliberate ASYMMETRY, pinned so it reads as a decision rather
    // than the next divergence: HTTP drops a blank OpenAI-protocol `model`
    // instead of rejecting it, because clients fill that field in
    // unconditionally. MCP has no such field — a model only ever arrives as
    // hints.model, which both surfaces reject when blank.
    for (const value of ["", "   "]) {
      const parsed = parseChatRequest({ prompt: "hi", workingDir: dir, model: value });
      expect(parsed.hints.model, `top-level model ${JSON.stringify(value)} survived`).toBeUndefined();
    }
  });
});

/**
 * One place the surfaces deliberately DIFFER, written down so it stays a
 * decision rather than a drift.
 *
 * A top-level key one typo from a hint name (`safteyProfile`) is refused on
 * HTTP and silently dropped on MCP. Not an oversight: the MCP SDK validates
 * against `z.object(dispatchInputShape)` before any of our code runs, and zod
 * strips unknown keys — so nothing in the registered-tool path can see what the
 * caller actually sent. Closing it means intercepting CallTool below the SDK's
 * routing.
 *
 * The consequence is identical on both sides — the hint is dropped and the
 * dispatch runs at the looser default — so this test asserts the asymmetry
 * rather than approving of it. If MCP ever starts rejecting these, this test
 * fails and the row moves up into REJECTED where it belongs.
 */
describe("near-miss top-level keys: a known, deliberate asymmetry", () => {
  it.each([
    ["safteyProfile", { prompt: "hi", safteyProfile: "read_only" }],
    ["taskTyp", { prompt: "hi", taskTyp: "review" }],
  ])("HTTP rejects %s; MCP strips it before we can", async (key, body) => {
    expect(
      () => parseChatRequest({ workingDir: dir, ...body }),
      "HTTP stopped rejecting a near-miss key",
    ).toThrow(new RegExp(key));

    // MCP does NOT reject these, so this call starts a REAL background run.
    // `graceSeconds: 0` returns the jobId immediately and the job is cancelled
    // below — without that, the run outlives the test and holds the temp
    // working directory open, and teardown fails with EBUSY. Starting work a
    // test does not stop is what this file already fixed once.
    const r = await client.callTool({
      name: "dispatch",
      arguments: { workingDir: dir, graceSeconds: 0, ...body },
    });
    expect(
      (r as { isError?: boolean }).isError,
      "MCP now rejects it — good; move this row into REJECTED and delete this test",
    ).toBeFalsy();

    const text = ((r as { content?: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? "")
      .join("");
    const jobId = (JSON.parse(text) as { jobId?: string }).jobId;
    if (jobId !== undefined) {
      await client.callTool({ name: "cancel_job", arguments: { jobId } });
      // Cancelling ASKS the runner to stop; it does not wait for it. The
      // runner heartbeats status.json every 15s and writes a terminal status
      // as it exits, so returning here let it write into a jobs directory
      // that teardown had already deleted — vitest reports that as an
      // unhandled error and the run fails with every test passing. Exactly
      // the failure this file's header records from a previous review, hit
      // again by a test written to assert something else.
      for (let i = 0; i < 100; i += 1) {
        const s = await client.callTool({ name: "job_status", arguments: { jobId } });
        const st = ((s as { content?: Array<{ text?: string }> }).content ?? [])
          .map((c) => c.text ?? "")
          .join("");
        if (/"completed"\s*:\s*true|"status"\s*:\s*"(cancelled|failed|completed|orphaned)"/.test(st)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 30_000);
});
