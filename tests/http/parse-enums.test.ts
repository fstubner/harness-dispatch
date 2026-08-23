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
});
