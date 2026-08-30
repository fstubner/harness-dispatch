/**
 * A config edit that cannot be loaded must SAY so.
 *
 * Keeping the previous config when a reload fails is right — a typo mid-edit
 * should not take the server down. Saying nothing about it is not: the server
 * stays up, keeps routing on the old config, and nothing on stderr or in the
 * response distinguishes "your edit is live" from "your edit was rejected and
 * you are still running the file from ten minutes ago". The edit looks applied
 * because everything still works.
 *
 * `doctor` diagnoses it correctly and exits 1 — if you think to run it.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapRuntime, ConfigHotReloader, RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let dir: string;
let configPath: string;
let stderr: string[];
let restoreStderr: () => void;

const GOOD = ["clis:", "  - name: probe", "    harness: codex", "    tier: 3", ""].join("\n");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-reloadfail-"));
  configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, GOOD, "utf8");
  stderr = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (chunk: string) => {
    stderr.push(String(chunk));
    return true;
  };
  restoreStderr = () => {
    (process.stderr as unknown as { write: unknown }).write = original;
  };
});

afterEach(async () => {
  restoreStderr();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** mtime granularity is coarse enough that a same-millisecond write is missed. */
async function rewriteConfig(body: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1100));
  await fs.writeFile(configPath, body, "utf8");
}

describe("a failed config reload is reported, not swallowed", () => {
  it("warns on stderr and keeps the previous config", async () => {
    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);
    expect(Object.keys(holder.state.config.services)).toContain("probe");

    await rewriteConfig("clis:\n  - name: probe\n   bad indentation: [oops\n");
    const reloaded = await reloader.maybeReload();

    expect(reloaded, "a malformed config must not be adopted").toBe(false);
    expect(
      Object.keys(holder.state.config.services),
      "the previous config must stay in effect",
    ).toContain("probe");
    expect(
      stderr.join(""),
      "the server kept running a config the file no longer matches, and said nothing",
    ).toMatch(/config reload FAILED/i);
  }, 30_000);

  it("reaches STATUS, not just stderr, and clears once the file is fixed", async () => {
    // stderr is invisible to every MCP client and every HTTP caller, which is
    // most of how this server is used — so the operator had no way to learn
    // that the file on disk was not the config in effect. The comment at the
    // throw site described the bug as "nothing on stderr and nothing in
    // status" while closing only the first half.
    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);
    expect(holder.state.config.reloadError).toBeUndefined();

    await rewriteConfig("clis:\n  - name: probe\n   bad indentation: [oops\n");
    expect(await reloader.maybeReload()).toBe(false);
    expect(
      holder.state.config.reloadError,
      "status had no way to know the running config was stale",
    ).toBeDefined();

    // And it must not stick around once the file is valid again — a warning
    // that outlives its cause is the same class of lie in the other direction.
    await rewriteConfig(GOOD);
    expect(await reloader.maybeReload()).toBe(true);
    expect(holder.state.config.reloadError).toBeUndefined();
  }, 30_000);

  it("does not repeat the same warning on every poll", async () => {
    // The reloader re-checks on a timer, so an unfixed file would otherwise
    // print on every pass until someone noticed — which is its own way of
    // being ignored.
    const state = await bootstrapRuntime({ configPath });
    const reloader = new ConfigHotReloader(new RuntimeHolder(state), configPath);

    await rewriteConfig("clis:\n  - name: probe\n   bad indentation: [oops\n");
    await reloader.maybeReload();
    const afterFirst = stderr.join("").match(/config reload FAILED/gi)?.length ?? 0;
    await reloader.maybeReload();
    const afterSecond = stderr.join("").match(/config reload FAILED/gi)?.length ?? 0;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  }, 30_000);

  it("refuses a background dispatch instead of reporting the job orphaned 90s later", async () => {
    // The detached runner bootstraps from the config FILE, so a file this
    // server can no longer load means no runner can start — and the job sat
    // untouched until the 90s orphan threshold declared it dead. Observed: a
    // caller told "ended without a result (status: orphaned)" about a job
    // whose own status.json later read completed/success. Two false statements
    // from one broken file.
    //
    // The server is fine — a failed reload keeps the last good config in
    // memory, which is why it can still accept the dispatch. That divergence
    // between what the server runs and what a runner would read is the bug.
    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const { startAsyncJobTracked } = await import("../src/jobs.js");

    await rewriteConfig("clis:\n  - name: probe\n   bad indentation: [oops\n");

    await expect(
      startAsyncJobTracked({ holder }, { prompt: "hi", workingDir: dir }),
    ).rejects.toThrow(/cannot start a background run/i);
  }, 30_000);

  it("still accepts a dispatch when the config on disk is fine", async () => {
    // The negative. This check runs on every background dispatch, so a false
    // positive would refuse all of them.
    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const { startAsyncJobTracked } = await import("../src/jobs.js");

    const started = await startAsyncJobTracked({ holder }, { prompt: "hi", workingDir: dir });
    expect(started.status.jobId).toMatch(/^job-\d+-[0-9a-f]{8}$/);
  }, 30_000);

  it("stays silent when the edit is fine", async () => {
    // The guard must not cry wolf on a working reload.
    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);

    await rewriteConfig(
      ["clis:", "  - name: probe", "    harness: codex", "    tier: 1", ""].join("\n"),
    );
    const reloaded = await reloader.maybeReload();

    expect(reloaded, "a valid edit should be adopted").toBe(true);
    expect(stderr.join("")).not.toMatch(/config reload FAILED/i);
  }, 30_000);
});
