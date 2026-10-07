/**
 * MCP progress notifications on the DEFAULT, detached job path.
 *
 * They were wired only into the in-process runner, which is the mode
 * tests/setup-env.ts forces for the whole suite — so the one test of them
 * passed while every real install, which runs jobs in a detached supervisor,
 * sent none. Measured in an audit: a run that printed 9 lines produced 0
 * notifications detached and 4 in-process.
 *
 * This file opts OUT of in-process jobs and runs the real dist/ runner, the
 * same way the concurrency tests do.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDispatch } from "../../src/mcp/tools.js";
import { cancelJob, startAsyncJobTracked } from "../../src/jobs.js";
import { loadConfig } from "../../src/config.js";
import type { RuntimeHolder } from "../../src/mcp/config-hot-reload.js";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "job-runner.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-progress-"));
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(tmpDir, "jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // The supervisor exits ~5 s after its last job and holds its log open until
  // then, which on Windows blocks the delete.
  await new Promise((r) => setTimeout(r, 6_500));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
}, 30_000);

describe.skipIf(!existsSync(RUNNER))("progress notifications for a detached job", () => {
  it("forwards the run's output while the dispatch call is still waiting", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    const script =
      "let i = 0; const t = setInterval(() => { i += 1; console.log('line ' + i); " +
      "if (i === 5) clearInterval(t); }, 400)";
    await fs.writeFile(
      configPath,
      [
        "clis:",
        "  - name: chatty_node",
        "    harness: generic",
        "    command: node",
        "    tier: 3",
        "    billing_kind: local_compute",
        "    paid_usage_possible: false",
        "    protocol:",
        `      args: ["-e", ${JSON.stringify(script)}, "{{prompt}}"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "utf8",
    );
    const config = await loadConfig(configPath);
    const holder = { state: { config, configPath } } as unknown as RuntimeHolder;
    const messages: string[] = [];
    const response = (await handleDispatch(
      { holder },
      { prompt: "hi", mode: "single", workingDir: tmpDir, hints: { taskType: "plan" }, graceSeconds: 40 },
      {
        mcpReq: {
          _meta: { progressToken: "t1" },
          notify: async (n) => {
            messages.push(String((n.params as { message?: unknown }).message));
          },
        },
      },
    )) as { completed: boolean; output?: string };

    expect(response.completed).toBe(true);
    expect(response.output).toContain("line 5");
    expect(messages.length, "no progress notification for a detached run").toBeGreaterThan(0);
    expect(messages.join("\n")).toContain("line 1");
  }, 90_000);

  it("stops watching the job once the caller stops waiting", async () => {
    // The dispatch tool waits a grace window and then returns a jobId; the
    // watcher it raced against went on reading status.json every 300 ms for
    // up to 70 minutes, per dispatch, with nothing awaiting it.
    const configPath = path.join(tmpDir, "config.yaml");
    await fs.writeFile(
      configPath,
      [
        "clis:",
        "  - name: slow_node",
        "    harness: generic",
        "    command: node",
        "    tier: 3",
        "    billing_kind: local_compute",
        "    paid_usage_possible: false",
        "    protocol:",
        `      args: ["-e", "setTimeout(() => {}, 8000)", "{{prompt}}"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "utf8",
    );
    const config = await loadConfig(configPath);
    const holder = { state: { config, configPath } } as unknown as RuntimeHolder;
    const started = await startAsyncJobTracked({ holder }, { prompt: "p", workingDir: tmpDir });
    const t0 = Date.now();
    started.stopWatching();
    await started.completion;
    expect(Date.now() - t0, "the watch ran on after the caller stopped waiting").toBeLessThan(2_000);
    const raw = JSON.parse(await fs.readFile(path.join(started.status.jobDir, "status.json"), "utf8"));
    expect(["queued", "running"]).toContain(raw.status);
    await cancelJob(started.status.jobId, "test over");
    await new Promise((r) => setTimeout(r, 3_000));
  }, 60_000);
});
