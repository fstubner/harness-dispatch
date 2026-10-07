/**
 * The client name and version are whatever the client claims, and they are
 * written to the shared dispatch log and shown in every session's job list.
 * A 200 KB name with a newline and a terminal escape code went in verbatim.
 */

import { describe, expect, it } from "vitest";

import { clientLabel } from "../../src/mcp/tools.js";

describe("clientLabel", () => {
  it("removes control characters, including newlines and escape codes", () => {
    expect(clientLabel("evil\nclient\u001b[31mred\u0007")).toBe("evilclient[31mred");
  });

  it("caps the length at 200 characters", () => {
    expect(clientLabel("x".repeat(200_000))).toHaveLength(200);
  });

  it("keeps an ordinary name and drops an empty one", () => {
    expect(clientLabel("claude-code")).toBe("claude-code");
    expect(clientLabel("\n\t ")).toBeUndefined();
    expect(clientLabel(undefined)).toBeUndefined();
  });
});
