/**
 * A shared supervisor serves whoever dispatches next, so it must not carry the
 * nesting depth of whoever happened to start it.
 *
 * `job_status` on a queued job can start a supervisor, and it is not gated by
 * depth. A depth-1 process (a delegate asking after a job) therefore launched a
 * supervisor whose environment held HARNESS_DISPATCH_DEPTH=1, and the CLI
 * dispatcher's leftover check, which reads the executing process's own
 * environment, then refused an ordinary depth-0 user's job as nested.
 */

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const RUNNER = path.join(DIST, "job-runner.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-supdepth-"));
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(tmpDir, "jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // The supervisor exits a few seconds after its last job and may hold its log
  // open until then, which on Windows blocks the delete.
  await new Promise((r) => setTimeout(r, 6_500));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
}, 30_000);

function runDriver(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`driver exited ${code}: ${err}`))));
  });
}

describe.skipIf(!existsSync(RUNNER))("a supervisor started from a nested process", () => {
  it("still runs a later dispatch from a session that is not nested", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    await fs.writeFile(
      configPath,
      [
        "clis:",
        "  - name: probe",
        "    harness: generic",
        "    command: node",
        "    tier: 3",
        "    billing_kind: local_compute",
        "    paid_usage_possible: false",
        "    protocol:",
        `      args: ["-e", "console.log('ran at depth ' + process.env.HARNESS_DISPATCH_DEPTH)"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "utf8",
    );
    const url = (f: string) => JSON.stringify(pathToFileURL(path.join(DIST, f)).href);

    // A nested process (depth 1) starts the shared supervisor, as `job_status`
    // does when it finds a queued job and nothing alive to run it.
    const starter = path.join(tmpDir, "starter.mjs");
    await fs.writeFile(
      starter,
      [
        `const { startSupervisorIfNoneAlive } = await import(${url("jobs/supervisor.js")});`,
        `const failed = await startSupervisorIfNoneAlive(${JSON.stringify(configPath)});`,
        `if (failed) { console.error(failed); process.exit(1); }`,
        `process.exit(0);`,
      ].join("\n"),
      "utf8",
    );
    await runDriver(starter, { ...process.env, HARNESS_DISPATCH_DEPTH: "1" });

    // Then an ordinary session, not nested, dispatches.
    const jobDirFile = path.join(tmpDir, "job-dir.txt");
    const dispatcher = path.join(tmpDir, "dispatcher.mjs");
    await fs.writeFile(
      dispatcher,
      [
        `import { writeFileSync } from "node:fs";`,
        `const { loadConfig } = await import(${url("config.js")});`,
        `const { startAsyncJobTracked } = await import(${url("jobs.js")});`,
        `const config = await loadConfig(${JSON.stringify(configPath)});`,
        `const started = await startAsyncJobTracked({ holder: { state: { config, configPath: ${JSON.stringify(configPath)} } } }, { prompt: "p1", workingDir: ${JSON.stringify(tmpDir)} });`,
        `writeFileSync(${JSON.stringify(jobDirFile)}, started.status.jobDir);`,
        `process.exit(0);`,
      ].join("\n"),
      "utf8",
    );
    const { HARNESS_DISPATCH_DEPTH: _drop, ...notNested } = process.env;
    await runDriver(dispatcher, notNested);
    const jobDir = await fs.readFile(jobDirFile, "utf8");

    const deadline = Date.now() + 45_000;
    let status: { status: string } = { status: "queued" };
    while (Date.now() < deadline) {
      status = JSON.parse(await fs.readFile(path.join(jobDir, "status.json"), "utf8"));
      if (status.status !== "queued" && status.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const result = JSON.parse(await fs.readFile(path.join(jobDir, "output", "result.json"), "utf8"));
    expect(JSON.stringify(result.result ?? result), "refused as nested").not.toMatch(/may not dispatch/);
    expect(status.status).toBe("completed");
    // The delegate itself is one level below the session that dispatched it.
    expect(result.result.output).toContain("ran at depth 1");
  }, 120_000);
});
