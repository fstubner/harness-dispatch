/**
 * scripts/release-notes.mjs turns a hard-wrapped CHANGELOG section into release
 * notes. A GitHub release body renders every newline as a line break, so the
 * section copied as-is broke every sentence at column 80 (v0.11.0, and the
 * v0.12.0 draft). Nothing else looks at these notes before they reach the
 * release page, so this pins the unwrapping.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function notes(version: string): string[] {
  return execFileSync(process.execPath, [path.join(repoRoot, "scripts", "release-notes.mjs"), version], {
    encoding: "utf8",
  }).split("\n");
}

describe("release notes from the changelog", () => {
  it("puts each paragraph and list item on one line", () => {
    const lines = notes("0.11.0");
    // A hard-wrapped entry, as written in CHANGELOG.md across several lines.
    const entry = lines.find((l) => l.startsWith("- **MCP progress notifications are redacted.**"));
    expect(entry).toContain("nothing did, because that path never touches the JSON or SSE writers.");
    // Every non-blank line is a block start: a heading, a list item, or the
    // first line of a paragraph after a blank line.
    lines.forEach((line, i) => {
      if (line.trim() === "" || i === 0) return;
      const startsBlock = /^\s*([-*+]|\d+\.)\s|^\s*(#|\||>|```)/.test(line);
      expect(startsBlock || lines[i - 1]!.trim() === "", `line ${i + 1} continues the one before: ${line}`).toBe(
        true,
      );
    });
  });

  it("refuses a version the changelog does not have", () => {
    expect(() => notes("0.0.0-none")).toThrow();
  });
});
