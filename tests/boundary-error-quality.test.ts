/**
 * Errors at the boundary must name the real cause.
 *
 * Three findings from an independent acceptance review, all the same shape: an
 * input that could be rejected cheaply and clearly was instead passed through,
 * and failed later somewhere that could no longer explain itself.
 *
 * The cost is not cosmetic. A caller told the wrong cause debugs the wrong
 * thing — and for the agent that is the primary consumer here, a misleading
 * error is worse than a blunt one, because it has no way to notice it is being
 * misled.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob, startAsyncJobTracked } from "../src/jobs.js";
import { validateWorkingDir } from "../src/working-dir.js";
import { loadConfig } from "../src/config.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-boundq-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(dir, "jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("workingDir validation", () => {
  it("rejects a path that does not exist, naming the path", () => {
    const err = validateWorkingDir(path.join(dir, "nope"));
    expect(err).toMatch(/does not exist/);
    expect(err).toContain("nope");
  });

  it("rejects a file where a directory is required", async () => {
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "x", "utf8");
    expect(validateWorkingDir(file)).toMatch(/not a directory/);
  });

  it("accepts a real directory, and an omitted value", () => {
    expect(validateWorkingDir(dir)).toBeUndefined();
    expect(validateWorkingDir(undefined)).toBeUndefined();
    expect(validateWorkingDir("")).toBeUndefined();
  });

  it("fails the dispatch before a job directory is created", async () => {
    // Previously this reached the harness and surfaced as
    // `spawn claude.EXE ENOENT` — the binary blamed for the directory's
    // absence, sending the caller to debug their PATH.
    const config = await loadConfig(undefined);
    const deps = { holder: { state: { config } } as unknown as RuntimeHolder };
    await expect(
      startAsyncJobTracked(deps, { prompt: "hi", workingDir: path.join(dir, "gone") }),
    ).rejects.toThrow(/workingDir does not exist/);

    // And nothing was left behind for a job that never legitimately started.
    const jobsDir = path.join(dir, "jobs");
    const entries = await fs.readdir(jobsDir).catch(() => []);
    expect(entries.filter((e) => e.startsWith("job-"))).toEqual([]);
  });
});

describe("job_status on a job that is gone", () => {
  it("says the job is missing rather than leaking a filesystem error", async () => {
    // Retention prunes finished jobs, so any caller holding an id long enough
    // reaches this. The id is well-formed; only the job is absent.
    await expect(getAsyncJob("job-1700000000000-deadbeef")).rejects.toThrow(/No such job/);
  });

  it("does not quote an internal absolute path in the message", async () => {
    // The old message was a raw Node ENOENT naming the jobs directory layout,
    // which tells the caller nothing they can act on.
    const err = await getAsyncJob("job-1700000000000-deadbeef").catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/ENOENT/);
    expect((err as Error).message).not.toMatch(/manifest\.json/);
  });

  it("still rejects a malformed id as malformed, not as missing", async () => {
    // The two failures are different and must stay distinguishable.
    await expect(getAsyncJob("../../etc/passwd")).rejects.toThrow(/Invalid jobId/);
  });
});
