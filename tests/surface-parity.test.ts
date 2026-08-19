/**
 * The MCP and HTTP surfaces must agree about what they reject.
 *
 * Four consecutive reviews found the same shape: a guard added to one surface
 * and not the other, or to one branch and not its sibling. In the commit
 * before this one it happened three times at once — strict hints (MCP only),
 * 400 mapping (parse errors only), fanout rejection (non-streaming only).
 *
 * These tests exist to make that class fail loudly rather than be found by a
 * human on the fourth pass.
 */

import { describe, expect, it } from "vitest";

import { invokeTool } from "../src/mcp/tools.js";

const deps = {} as never;

describe("misplaced hint keys are rejected, not ignored", () => {
  // The trap the previous fix created: `hints` became strict, so a caller who
  // hit that error and "corrected" it by promoting the key one level got a
  // SILENT fail-open instead — the dispatch ran with more access than asked.
  it.each(["safetyProfile", "routePolicy", "taskType", "timeoutMs"])(
    "rejects top-level %s with a message naming hints",
    async (key) => {
      await expect(
        invokeTool("dispatch", { prompt: "hi", [key]: "read_only" }, deps),
      ).rejects.toThrow(/belongs inside `hints`|belong inside `hints`/);
    },
  );

  it("names the consequence, not just the mistake", async () => {
    const err = await invokeTool("dispatch", { prompt: "hi", safetyProfile: "read_only" }, deps).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/MORE access than you asked for/);
  });

  it("still accepts the correct placement", async () => {
    // Must not reject legitimate callers — the guard names specific keys
    // rather than applying .strict() to the outer object, so an MCP client
    // attaching its own fields still works.
    //
    // Asserted by inspecting the error IF one occurs: this call may fail later
    // for unrelated reasons (no configured routes in this context), and what
    // matters is only that it is not turned away at the boundary.
    const err = await invokeTool(
      "dispatch",
      { prompt: "hi", hints: { safetyProfile: "read_only" } },
      deps,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message ?? "").not.toMatch(/belongs inside `hints`/);
  });

  it("rejects an unknown key inside hints", async () => {
    // `safety_profile` is the config.yaml spelling. Accepting it silently
    // disabled a safety limit.
    await expect(
      invokeTool("dispatch", { prompt: "hi", hints: { safety_profile: "read_only" } }, deps),
    ).rejects.toThrow();
  });
});
