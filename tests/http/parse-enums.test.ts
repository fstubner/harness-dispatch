/**
 * The HTTP surface must reject an invalid enum VALUE, not drop it.
 *
 * parse.ts's own header states the contract: "Anything rejected here must be
 * rejected the same way the MCP schema rejects it." The unknown-KEY check was
 * added when `safety_profile` (the config spelling) silently disabled a safety
 * limit — and covered only half the failure. An unknown VALUE fell through the
 * if-chain and was dropped, so `hints.safetyProfile: "read_onlyy"` returned
 * HTTP 200 and ran the dispatch write-capable (`shared_locked`), while the
 * correct spelling produced `shared`. MCP rejects the same input by name.
 *
 * PRODUCT.md names CI and cron as this surface's users — the ones least likely
 * to notice a silently downgraded safety profile.
 */
import { describe, expect, it } from "vitest";

import { parseChatRequest } from "../../src/http/parse.js";

const base = { prompt: "probe", workingDir: process.cwd() };

describe("HTTP hint values are rejected, not dropped", () => {
  it.each([
    ["hints.safetyProfile", { hints: { safetyProfile: "read_onlyy" } }],
    ["hints.routePolicy", { hints: { routePolicy: "bloked" } }],
    ["hints.workspacePolicy", { hints: { workspacePolicy: "copyy" } }],
    ["hints.taskType", { hints: { taskType: "excute" } }],
    ["safetyProfile", { safetyProfile: "read_onlyy" }],
    ["workspacePolicy", { workspacePolicy: "worktree" }],
  ])("rejects a typo in %s", (field, body) => {
    expect(() => parseChatRequest({ ...base, ...body })).toThrow(
      new RegExp(`${field.replace(".", "\.")}: invalid value`),
    );
  });

  it("still accepts every valid value", () => {
    const parsed = parseChatRequest({
      ...base,
      hints: {
        safetyProfile: "workspace_edit",
        routePolicy: "local_only",
        workspacePolicy: "git_worktree",
        taskType: "review",
      },
    });
    expect(parsed.hints.safetyProfile).toBe("workspace_edit");
    expect(parsed.hints.routePolicy).toBe("local_only");
    expect(parsed.hints.workspacePolicy).toBe("git_worktree");
    expect(parsed.hints.taskType).toBe("review");
  });

  it("leaves an omitted hint omitted rather than defaulting it", () => {
    const parsed = parseChatRequest({ ...base, hints: { model: "m" } });
    expect(parsed.hints.safetyProfile).toBeUndefined();
    expect(parsed.hints.workspacePolicy).toBeUndefined();
  });

  it.each([
    ["hints.model", { hints: { model: 123 } }, /hints\.model: expected string/],
    ["hints.preferLargeContext", { hints: { preferLargeContext: "yes" } }, /expected boolean/],
    ["hints.timeoutMs", { hints: { timeoutMs: "5000" } }, /expected number/],
    ["hints itself as a string", { hints: "workspace_edit" }, /hints: must be an object/],
    ["hints itself as an array", { hints: [] }, /hints: must be an object/],
  ])("rejects a wrong-typed %s rather than dropping it", (_label, body, message) => {
    // The other half of the unknown-KEY rule above. A known key with the wrong
    // type fell through the if-chain and vanished on a 200, so the caller's
    // hint was ignored without a word — and `hints: "x"` discarded EVERY hint
    // in one go, safety ones included, because a non-object failed the branch
    // guard silently. Arrays are typeof "object", so they got in and matched
    // nothing.
    expect(() => parseChatRequest({ ...base, ...body })).toThrow(message);
  });

  it.each([["empty", ""], ["whitespace", "   "]])(
    "rejects a %s hints.model instead of unsetting the route's own",
    (_label, value) => {
      // The same rule as the MCP surface, and the same reason the unknown-KEY
      // check above spans both: a blank model beat the route's configured one,
      // so the harness ran with no model flag and the response reported
      // model: "". The OpenAI top-level `model` field has always dropped "",
      // so this failed open on one surface only — and the 0.7.8 release notes
      // claimed the rejection without qualifying which surface.
      expect(() => parseChatRequest({ ...base, hints: { model: value } })).toThrow(
        /hints\.model: must not be empty/,
      );
    },
  );

  it.each([["empty", ""], ["whitespace", "   "]])(
    "drops a %s top-level model rather than sending it to the harness",
    (_label, value) => {
      // The OpenAI protocol's own field, so it is DROPPED rather than
      // rejected — clients fill it in unconditionally, often with a
      // placeholder. "" was always dropped; whitespace is truthy and was not,
      // so it survived to `--model "   "` on a CLI route and cost a real
      // provider call, a route failure and breaker credit, on an HTTP 200.
      const parsed = parseChatRequest({ ...base, model: value });
      expect(parsed.hints.model).toBeUndefined();
    },
  );
});

/**
 * The same failure one level up: a top-level KEY that is nearly a hint name.
 *
 * The outer object cannot be strict — it carries OpenAI's own fields — so an
 * unknown top-level key was accepted and dropped. An acceptance pass found two
 * shapes of that: hints wrapped in `harness_dispatch` (the key this endpoint
 * uses in its own RESPONSES, so the natural wrong guess) and a plain
 * transposition, `safteyProfile`. Both returned HTTP 200 and dispatched at the
 * default `workspace_edit` — more access than the caller asked for, with no
 * signal — while the correct spelling produced `read_only`.
 */
describe("HTTP near-miss top-level keys are rejected, not dropped", () => {
  it.each([
    ["harness_dispatch", { harness_dispatch: { hints: { safetyProfile: "read_only" } } }],
    ["harnessDispatch", { harnessDispatch: { hints: { safetyProfile: "read_only" } } }],
    ["safteyProfile", { safteyProfile: "read_only" }],
    ["safetyProfil", { safetyProfil: "read_only" }],
    ["taskTyp", { taskTyp: "review" }],
    ["workingDr", { workingDr: "/tmp" }],
  ])("rejects %s rather than silently ignoring it", (key, body) => {
    expect(() => parseChatRequest({ ...base, ...body })).toThrow(new RegExp(key));
  });

  it("does not reject OpenAI's own fields, or anything unrelated", () => {
    // The cost of getting this wrong is refusing a legitimate request, so the
    // rule has to stay narrow enough to leave the protocol's own body alone.
    expect(() =>
      parseChatRequest({
        ...base,
        model: "gpt-4",
        stream: false,
        temperature: 0.7,
        top_p: 1,
        n: 1,
        stop: null,
        user: "someone",
        max_tokens: 100,
        presence_penalty: 0,
        frequency_penalty: 0,
        seed: 7,
        response_format: { type: "text" },
        metadata: { anything: true },
      }),
    ).not.toThrow();
  });
});
