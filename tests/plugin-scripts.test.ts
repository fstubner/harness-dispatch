/**
 * The plugin install/launch scripts, which had no tests at all.
 *
 * They run on a user's machine at install time and construct a shell command
 * line on Windows, so they are the highest-consequence code in the repo per
 * line — and the only part no review had opened until now. They also execute
 * top-level work on import, which is why unit-importing them is not an option:
 * every case here drives a real subprocess, `--dry-run` where one exists.
 *
 * The two behaviours pinned below are both instances of the class this
 * codebase keeps finding: an explicit, wrong input silently replaced by a
 * default instead of being reported.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const installCodex = path.join(repoRoot, "plugin", "scripts", "install-codex.mjs");

let dir: string;

beforeEach(async () => {
  // realpath, because macOS hands out /var/folders/... while a spawned
  // process reports its cwd as the resolved /private/var/folders/... — the
  // installer prints an absolute path built from ITS cwd, so the expected
  // value has to be resolved the same way or the assertion only passes on
  // Linux and Windows.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-plugin-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Run the installer, returning {status, out}. Never throws on non-zero exit. */
function runInstaller(args: string[], cwd: string): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [installCodex, ...args], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("install-codex.mjs — --config handling", () => {
  it("resolves a relative --config to an absolute path before persisting it", async () => {
    // The persisted value is read back much later by launch-mcp.mjs, in a
    // process whose cwd is Codex's rather than the installer's. A relative
    // path therefore resolved to nothing at launch and the server started on
    // auto-detected defaults — none of the operator's routes or safety floors
    // in effect, and nothing said so.
    const cfg = path.join(dir, "config.yaml");
    await fs.writeFile(cfg, "clis: []\n", "utf8");

    const { status, out } = runInstaller(["--dry-run", "--config", "config.yaml"], dir);

    expect(status).toBe(0);
    expect(out).toContain(`HARNESS_DISPATCH_CONFIG=${cfg}`);
    // The bare relative form must not survive anywhere in the command.
    expect(out).not.toContain("HARNESS_DISPATCH_CONFIG=config.yaml");
  });

  it("rejects a --config path that does not exist, at install time", async () => {
    // Install time is the only moment the person who typed the path is still
    // there to fix it.
    const missing = path.join(dir, "nope.yaml");
    const { status, out } = runInstaller(["--dry-run", "--config", missing], dir);

    expect(status).toBe(1);
    expect(out).toMatch(/does not exist/);
    expect(out).toContain("nope.yaml");
  });

  it("rejects --config with a flag as its value instead of taking it literally", async () => {
    const { status, out } = runInstaller(["--config", "--dry-run"], dir);
    expect(status).toBe(1);
    expect(out).toMatch(/needs a value/);
  });

  it("still runs with no --config at all", async () => {
    const { status, out } = runInstaller(["--dry-run"], dir);
    expect(status).toBe(0);
    expect(out).not.toContain("HARNESS_DISPATCH_CONFIG");
  });
});

describe("launch-mcp.mjs — an explicit config that is missing must be reported", () => {
  it("passes HARNESS_DISPATCH_CONFIG through so the server can reject it by name", async () => {
    // The launcher used to gate this on existsSync and fall through to
    // auto-detection when it failed, which is the same silent-default failure
    // the CLI treats as a hard error. It now hands the path over and lets
    // loadConfig produce its own "config file not found" message.
    //
    // Driven end-to-end: the launcher spawns the real server, which must exit
    // non-zero naming the path.
    const launcher = path.join(repoRoot, "plugin", "scripts", "launch-mcp.mjs");
    const distBin = path.join(repoRoot, "dist", "bin.js");
    if (!(await fs.stat(distBin).catch(() => null))) return; // unbuilt checkout
    const missing = path.join(dir, "typo.yaml");

    let out = "";
    let status = 0;
    try {
      execFileSync(process.execPath, [launcher], {
        encoding: "utf8",
        env: { ...process.env, HARNESS_DISPATCH_CONFIG: missing },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    expect(status).not.toBe(0);
    expect(out).toMatch(/config file not found/i);
    expect(out).toContain("typo.yaml");
  }, 40_000);
});
