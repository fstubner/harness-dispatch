/**
 * A Claude Code plugin install counts as registered.
 *
 * The plugin declares its MCP server itself, so nothing about it is in
 * `~/.claude.json` — the only file `doctor` and `connect` read for Claude
 * Code. A plugin user was told "not registered — run `harness-dispatch
 * connect`", and doing that gave Claude Code a second server with the same
 * tools.
 *
 * The fixture homes copy the layout of a real install made with
 * `claude plugin install harness-dispatch@harness-dispatch` into a scratch
 * Claude config directory (2026-10-08): `settings.json` gains
 * `enabledPlugins`, and `plugins/installed_plugins.json` lists the install.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/bin.js";
import { mcpClientsCheck } from "../src/cli/doctor.js";
import { claudeCodePluginInstall } from "../src/mcp-clients.js";

const ID = "harness-dispatch@harness-dispatch";
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hd-plugin-home-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
});

async function installPlugin(enabled: boolean): Promise<void> {
  const dir = path.join(home, ".claude");
  await fs.mkdir(path.join(dir, "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [ID]: [
          {
            scope: "user",
            installPath: path.join(dir, "plugins", "cache", "harness-dispatch", "harness-dispatch", "0.12.0"),
            version: "0.12.0",
            installedAt: "2026-10-08T00:00:00.000Z",
            lastUpdated: "2026-10-08T00:00:00.000Z",
            gitCommitSha: "6dbfccd8fa5b7b61e081a9d4f0ad69d146d02c10",
          },
        ],
      },
    }),
  );
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "other@somewhere": true, [ID]: enabled } }),
  );
}

async function writeClaudeEntry(): Promise<void> {
  await fs.writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { "harness-dispatch": { command: "harness-dispatch", args: [] } } }),
  );
}

const claudeInstalled = (commands: string[]): boolean => commands.includes("claude");

describe("claudeCodePluginInstall", () => {
  it("finds an enabled plugin", async () => {
    await installPlugin(true);
    expect(claudeCodePluginInstall(home)).toEqual({ id: ID, enabled: true });
  });

  it("finds an installed but disabled plugin", async () => {
    await installPlugin(false);
    expect(claudeCodePluginInstall(home)).toEqual({ id: ID, enabled: false });
  });

  it("finds nothing in a home without Claude Code plugin files", () => {
    expect(claudeCodePluginInstall(home)).toBeUndefined();
  });
});

describe("doctor's mcp-clients check", () => {
  it("says the plugin registers the server, and does not advise connect", async () => {
    await installPlugin(true);
    const check = mcpClientsCheck(home, claudeInstalled);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain("registered via the Claude Code plugin");
    expect(check.detail).not.toContain("connect");
  });

  it("still advises connect when Claude Code is installed and nothing registers the server", () => {
    const check = mcpClientsCheck(home, claudeInstalled);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain("harness-dispatch connect");
  });

  it("points a disabled plugin at /plugin rather than connect", async () => {
    await installPlugin(false);
    const check = mcpClientsCheck(home, claudeInstalled);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain("installed but disabled");
    expect(check.detail).toContain("/plugin");
  });

  it("warns when the plugin and a ~/.claude.json entry both register it", async () => {
    await installPlugin(true);
    await writeClaudeEntry();
    const check = mcpClientsCheck(home, claudeInstalled);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain("registered twice");
  });
});

describe("connect with the plugin installed", () => {
  async function connect(args: string[]): Promise<{ code: number; stdout: string }> {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (c: string) => {
      chunks.push(String(c));
      return true;
    };
    try {
      return { code: await main(["connect", ...args]), stdout: chunks.join("") };
    } finally {
      (process.stdout as unknown as { write: unknown }).write = orig;
    }
  }

  it("skips Claude Code instead of writing a second registration", async () => {
    await installPlugin(true);
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    const before = await fs.readFile(path.join(home, ".claude.json"), "utf8");
    const out = await connect(["--clients", "claude-code", "--yes"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("already registered via the Claude Code plugin");
    expect(await fs.readFile(path.join(home, ".claude.json"), "utf8")).toBe(before);
  });

  it("writes the entry anyway with --force", async () => {
    await installPlugin(true);
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    const out = await connect(["--clients", "claude-code", "--yes", "--force"]);
    expect(out.code, out.stdout).toBe(0);
    const after = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toContain("harness-dispatch");
  });
});
