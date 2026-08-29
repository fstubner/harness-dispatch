/**
 * Validation at the MCP input boundary.
 *
 * The internals these inputs feed are careful; the boundary itself was not.
 * An MCP server's threat model is "the calling agent may be steered by
 * injected content", not "the caller is trustworthy", so a bare z.string()
 * reaching path.join is a real gap rather than a theoretical one.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAsyncJob } from "../src/jobs.js";
import { escapedFiles } from "../src/workspaces.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-boundary-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("jobId validation", () => {
  it("rejects traversal instead of reading a status file outside the jobs root", async () => {
    // getAsyncJob does path.join(jobsRoot(), jobId). Planted one level up
    // from the jobs root: reachable only if the id is not validated.
    const outside = path.join(tmpDir, "..", `hr-outside-${process.pid}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(outside, "status.json"),
      JSON.stringify({ jobId: "planted", status: "completed", jobDir: outside }),
      "utf8",
    );
    await fs.writeFile(path.join(outside, "manifest.json"), JSON.stringify({ jobId: "planted" }), "utf8");

    try {
      await expect(getAsyncJob(`../${path.basename(outside)}`)).rejects.toThrow(/Invalid jobId/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    ["absolute path", "/etc"],
    ["windows absolute", "C:\\Windows"],
    ["empty", ""],
    ["wrong shape", "not-a-job-id"],
    ["right prefix, wrong suffix", "job-123-ZZZZZZZZ"], // fixture-shapes-ok
  ])("rejects %s", async (_label, jobId) => {
    await expect(getAsyncJob(jobId)).rejects.toThrow(/Invalid jobId/);
  });

  it("accepts the shape jobs.ts actually generates", async () => {
    const jobId = "job-1786977316001-b49d1232";
    // Not planted on disk, so this fails at the read — the point is that it
    // gets PAST validation rather than being rejected on format.
    await expect(getAsyncJob(jobId)).rejects.not.toThrow(/Invalid jobId/);
  });
});

describe("escapedFiles — files that widen an isolated workspace", () => {
  it("reports the parent directory of a file outside workingDir", () => {
    const dirs = escapedFiles(
      [path.join(os.homedir(), ".ssh", "id_rsa")],
      path.join(os.homedir(), "project"),
    );
    expect(dirs).toEqual([path.join(os.homedir(), ".ssh")]);
  });

  it("reports nothing for files inside workingDir", () => {
    const root = path.join(os.homedir(), "project");
    expect(escapedFiles([path.join(root, "src", "a.ts"), path.join(root, "b.ts")], root)).toEqual([]);
  });

  it("deduplicates several files sharing one outside directory", () => {
    const root = path.join(os.homedir(), "project");
    const outside = path.join(os.homedir(), "secrets");
    expect(
      escapedFiles([path.join(outside, "a"), path.join(outside, "b")], root),
    ).toEqual([outside]);
  });
});
