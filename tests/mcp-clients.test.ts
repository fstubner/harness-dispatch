/**
 * A client pointing at a path that is not there.
 *
 * This is the failure the check exists for, and it is invisible from both
 * ends: a client that cannot spawn its server just has no tools, which looks
 * exactly like never having installed one, and the server never runs so it
 * cannot complain. On the maintainer's machine Claude Code spent months
 * launching `harness-router/dist/bin.js` after that directory was renamed
 * away, and a SessionStart hook pointed at the same dead path. Nothing
 * reported either.
 *
 * The fixtures below are the real shapes, read off that machine.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectClientEntries } from "../src/mcp-clients.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hd-clients-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeClaudeCode(servers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
}

async function writeCursor(servers: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: servers }),
  );
}

describe("inspectClientEntries", () => {
  it("reports an entry whose path does not exist", async () => {
    // Verbatim the shape that was broken, including the pre-rename key name.
    await writeClaudeCode({
      "harness-router": {
        type: "stdio",
        command: "node",
        args: [
          path.join(home, "gone", "dist", "bin.js"),
          "mcp",
          "--config",
          path.join(home, "gone", "config.yaml"),
        ],
        cwd: path.join(home, "gone"),
      },
    });

    const [report] = inspectClientEntries(home);
    expect(report?.client).toBe("Claude Code");
    expect(report?.entry).toBe("harness-router");
    // The binary, the --config value and cwd are all gone; --config itself is
    // a flag and must not be reported as a path.
    expect(report?.missingPaths).toHaveLength(3);
    expect(report?.missingPaths.some((p) => p.includes("--config"))).toBe(false);
  });

  it("does not report a bare command as missing", async () => {
    // Cursor's real entry. `npx` is resolved through PATH and shims at spawn
    // time; replicating that lookup here would report working installs as
    // broken, which is worse than not checking.
    await writeCursor({
      "harness-dispatch": { command: "npx", args: ["-y", "harness-dispatch"] },
    });

    const [report] = inspectClientEntries(home);
    expect(report?.client).toBe("Cursor");
    expect(report?.missingPaths).toEqual([]);
  });

  it("reports nothing when a path resolves", async () => {
    const real = path.join(home, "bin.js");
    await fs.writeFile(real, "");
    await writeClaudeCode({ "harness-dispatch": { command: "node", args: [real] } });
    expect(inspectClientEntries(home)[0]?.missingPaths).toEqual([]);
  });

  it("finds the entry by what it launches, not only by its key", async () => {
    // Renaming the key does not un-break it, and someone who called it
    // something else still deserves the warning.
    await writeClaudeCode({
      "my-router": { command: "node", args: [path.join(home, "nope", "harness-dispatch.js")] },
    });
    expect(inspectClientEntries(home)[0]?.entry).toBe("my-router");
  });

  it("ignores clients that are not configured for this server at all", async () => {
    // Not having installed it is not a fault. This must stay silent, or the
    // check becomes noise on every machine that runs one other MCP server.
    await writeClaudeCode({ "some-other-server": { command: "node", args: ["/nope/x.js"] } });
    expect(inspectClientEntries(home)).toEqual([]);
  });

  it("returns nothing when no client config exists", () => {
    expect(inspectClientEntries(home)).toEqual([]);
  });

  it("skips a config that will not parse rather than failing", async () => {
    // Another application's malformed JSON is that application's problem.
    // `doctor` reporting it as OUR failure would be wrong and unfixable from
    // here.
    await fs.writeFile(path.join(home, ".claude.json"), "{ not json");
    expect(() => inspectClientEntries(home)).not.toThrow();
    expect(inspectClientEntries(home)).toEqual([]);
  });

  it("reads every configured client, not just the first", async () => {
    await writeClaudeCode({ "harness-dispatch": { command: "npx", args: ["harness-dispatch"] } });
    await writeCursor({ "harness-dispatch": { command: "node", args: [path.join(home, "x.js")] } });
    const reports = inspectClientEntries(home);
    expect(reports.map((r) => r.client).sort()).toEqual(["Claude Code", "Cursor"]);
    expect(reports.find((r) => r.client === "Cursor")?.missingPaths).toHaveLength(1);
  });
});
