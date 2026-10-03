/**
 * A background run that only started through the plain-spawn fallback.
 *
 * On Windows the durable launch goes through WMI. When WMI is unavailable the
 * runner is still started with a plain detached spawn, which does not survive
 * a launcher that kills its descendants — so the job may die with the session
 * that dispatched it. That used to be written to a log file nobody reads; the
 * dispatch reply and `doctor` now say it.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outcome: { value: Record<string, unknown> } = { value: { ok: true, method: "spawn" } };
vi.mock("../src/jobs/detach.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/detach.js")>()),
  launchDetached: async () => outcome.value,
}));

import { loadConfig } from "../src/config.js";
import { fallbackWarning, probeVerdict } from "../src/jobs/detach.js";
import { resolveRunnerPath, startAsyncJobTracked, type JobDeps } from "../src/jobs.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let tmpDir: string;
let jobsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-fallback-"));
  jobsDir = path.join(tmpDir, "jobs");
  await fs.mkdir(jobsDir, { recursive: true });
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", jobsDir);
  vi.stubEnv("HARNESS_DISPATCH_INPROC_JOBS", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

async function deps(): Promise<JobDeps> {
  const file = path.join(tmpDir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "clis:",
      "  - name: fake_node",
      "    harness: generic",
      "    command: node",
      "    tier: 3",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    protocol:",
      `      args: ["-e", "0", "{{prompt}}"]`,
      "      output: { mode: text }",
    ].join("\n"),
    "utf8",
  );
  const config = await loadConfig(file);
  return { holder: { state: { config, configPath: file } } as unknown as RuntimeHolder };
}

describe.skipIf(resolveRunnerPath() === undefined)("a dispatch whose runner came up through the fallback", () => {
  it("tells the caller the job may not survive the session", async () => {
    outcome.value = { ok: true, method: "spawn", note: "log line", wmiError: "powershell.exe not found" };
    const started = await startAsyncJobTracked(await deps(), { prompt: "hi", workingDir: tmpDir });
    started.stopWatching();
    expect(started.status.warning).toContain("may not survive this session ending");
    expect(started.status.warning).toContain("powershell.exe not found");
    // It is on disk too, which is where every later poll reads it from.
    const onDisk = JSON.parse(await fs.readFile(path.join(started.status.jobDir, "status.json"), "utf8"));
    expect(onDisk.warning).toContain("may not survive this session ending");
    const manifest = JSON.parse(await fs.readFile(path.join(started.status.jobDir, "manifest.json"), "utf8"));
    expect(manifest.warning).toContain("may not survive this session ending");
  });

  it("says nothing when the durable launch worked", async () => {
    outcome.value = { ok: true, method: "wmi" };
    const started = await startAsyncJobTracked(await deps(), { prompt: "hi", workingDir: tmpDir });
    started.stopWatching();
    expect(started.status.warning).toBeUndefined();
  });
});

describe("launchDetached when WMI fails", () => {
  it("falls back to a plain spawn and reports why", async () => {
    // The module is mocked above; the real launcher is what is under test here.
    const { launchDetached } = await vi.importActual<typeof import("../src/jobs/detach.js")>("../src/jobs/detach.js");
    const logPath = path.join(tmpDir, "child.log");
    const result = await launchDetached(
      { execPath: process.execPath, args: ["-e", "0"], env: process.env, logPath },
      { platform: "win32", viaWmi: async () => ({ ok: false, error: "WMI service disabled" }) },
    );
    expect(result).toMatchObject({ ok: true, method: "spawn", wmiError: "WMI service disabled" });
    expect(await fs.readFile(logPath, "utf8")).toContain("WMI launch failed");
  });
});

describe("doctor's verdict on a probe that fell back", () => {
  const base = { survived: true, launcher: "node", tookMs: 1 };

  it("is a warning with a next step, not a plain pass", () => {
    const v = probeVerdict({
      ...base,
      log: "",
      how: { ok: true, method: "spawn", note: "n", wmiError: "powershell.exe not found" },
    });
    expect(v.ok).toBe(true);
    expect(v.warn).toBe(true);
    expect(v.detail).toContain("powershell.exe not found");
    expect(v.detail).toContain("Next:");
  });

  it("is a failure, with the same next step, when the fallback run was killed", () => {
    const v = probeVerdict({
      ...base,
      survived: false,
      log: "",
      how: { ok: true, method: "spawn", note: "n", wmiError: "WMI service disabled" },
    });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Next:");
  });

  it("stays a plain pass when the durable launch worked", () => {
    const v = probeVerdict({ ...base, log: "", how: { ok: true, method: "wmi" } });
    expect(v).toMatchObject({ ok: true });
    expect(v.warn).toBeUndefined();
    expect(fallbackWarning("x")).toContain("x");
  });
});
