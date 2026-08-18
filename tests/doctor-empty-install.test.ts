/**
 * `doctor` must say what it looked for when nothing is ready.
 *
 * "0 ready route(s)" on its own leaves a new user unable to tell a broken tool
 * from an empty one, with no hint what to install. The ux-walkthrough claimed
 * this behaviour before the code did — the claim was written from intent
 * rather than from a run, and an independent review caught it.
 */

import { describe, expect, it } from "vitest";

import { AUTO_DETECT_COMMANDS } from "../src/config.js";

describe("auto-detect command list", () => {
  it("names a command for every auto-detected route id", () => {
    // doctor renders these verbatim, so an empty or stale entry would show a
    // user a command that does not exist.
    for (const [routeId, command] of Object.entries(AUTO_DETECT_COMMANDS)) {
      expect(routeId).toMatch(/_cli$/);
      expect(command.length).toBeGreaterThan(0);
      expect(command).not.toContain(" ");
    }
  });

  it("covers the four shipped harnesses", () => {
    expect(Object.keys(AUTO_DETECT_COMMANDS).sort()).toEqual([
      "antigravity_cli",
      "claude_code_cli",
      "codex_cli",
      "cursor_cli",
    ]);
    expect(Object.values(AUTO_DETECT_COMMANDS)).toContain("cursor-agent");
  });
});
