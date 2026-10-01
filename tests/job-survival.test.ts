/**
 * A background run must outlive the session that dispatched it.
 *
 * That is the whole reason jobs run in detached supervisors, and on the
 * maintainer's Windows machine it was false: every MCP server there is started
 * through a version-manager shim (nvx) that kills its descendants when it
 * exits, and Node's `detached: true` does not leave the shim's job object. A
 * job dispatched by a session that then ended stayed `queued` forever. Found in
 * an architecture audit; reproduced by dispatching from a shim-launched process
 * and exiting.
 *
 * Both tests run the parent under the same `node` a client's launch command
 * resolves to (`launcherNode`), so on a machine with such a shim they exercise
 * it, and on one without they still check the ordinary detached path. They use
 * the built dist/, like every other detached-path test: the supervisor is a
 * separate process running the real runner.
 */

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launcherNode, probeDetachedSurvival } from "../src/jobs/detach.js";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const RUNNER = path.join(DIST, "job-runner.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-survival-"));
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(tmpDir, "jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // The supervisor exits ~5 s after its last job; until then it may hold its
  // log open, which on Windows blocks the delete.
  await new Promise((r) => setTimeout(r, 6_500));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
}, 30_000);

async function runUnderLauncher(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcherNode(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`parent exited ${code}: ${err}`));
      else resolve(code);
    });
  });
}

describe.skipIf(!existsSync(RUNNER))("a background run outlives its session", () => {
  it("finishes a job whose dispatching process exited straight after dispatch", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    const script = "setTimeout(() => console.log('survived ' + process.argv[1]), 3000)";
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
        `      args: ["-e", ${JSON.stringify(script)}, "{{prompt}}"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "utf8",
    );
    const jobIdFile = path.join(tmpDir, "job-id.txt");
    const driver = path.join(tmpDir, "driver.mjs");
    await fs.writeFile(
      driver,
      [
        `import { writeFileSync } from "node:fs";`,
        `const { loadConfig } = await import(${JSON.stringify(pathToFileURL(path.join(DIST, "config.js")).href)});`,
        `const { startAsyncJobTracked } = await import(${JSON.stringify(pathToFileURL(path.join(DIST, "jobs.js")).href)});`,
        `const configPath = ${JSON.stringify(configPath)};`,
        `const config = await loadConfig(configPath);`,
        `const started = await startAsyncJobTracked({ holder: { state: { config, configPath } } }, { prompt: "p1", workingDir: ${JSON.stringify(tmpDir)} });`,
        `writeFileSync(${JSON.stringify(jobIdFile)}, started.status.jobDir);`,
        // Exactly what a session ending does to its server: gone, mid-run.
        `process.exit(0);`,
      ].join("\n"),
      "utf8",
    );

    await runUnderLauncher([driver]);
    const jobDir = await fs.readFile(jobIdFile, "utf8");

    const deadline = Date.now() + 45_000;
    let status: { status: string } = { status: "queued" };
    while (Date.now() < deadline) {
      status = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8"));
      if (status.status !== "queued" && status.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status.status, "the run died with the process that dispatched it").toBe("completed");
    const result = JSON.parse(await fs.readFile(path.join(jobDir, "output", "result.json"), "utf8"));
    expect(result.result.output).toContain("survived p1");
  }, 90_000);

  it("doctor's probe says so by observing a probe outlive its parent", async () => {
    const probeDir = path.join(tmpDir, "probe");
    await fs.mkdir(probeDir);
    const verdict = await probeDetachedSurvival(RUNNER, probeDir);
    expect(verdict.detail).toMatch(/outlives/);
    expect(verdict.ok).toBe(true);
  }, 60_000);
});
