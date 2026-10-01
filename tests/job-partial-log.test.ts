import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startAsyncJobTracked, type JobDeps } from "../src/jobs.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";
import type { DispatchResult } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-partial-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function depsYielding(result: DispatchResult): JobDeps {
  const stream = async function* () {
    yield { event: { type: "stdout" as const, chunk: "raw protocol frame\n" }, decision: null };
    yield { event: { type: "completion" as const, result }, decision: null };
  };
  return { holder: { state: { router: { stream, streamTo: stream } } } as unknown as RuntimeHolder };
}

async function run(result: DispatchResult): Promise<{ partial: string; resultJson: string }> {
  const { status, completion } = await startAsyncJobTracked(depsYielding(result), {
    prompt: "hello",
    workingDir: tmpDir,
  });
  await completion;
  const output = path.join(status.jobDir, "output");
  return {
    partial: path.join(output, "stdout.partial.log"),
    resultJson: path.join(output, "result.json"),
  };
}

describe("the raw progress log after a job ends", () => {
  it("is dropped once a successful job's full output is in result.json", async () => {
    const { partial, resultJson } = await run({ output: "the whole answer", service: "r", success: true });
    expect(JSON.parse(await fs.readFile(resultJson, "utf8")).result.output).toBe("the whole answer");
    expect(existsSync(partial), "the duplicate log was kept").toBe(false);
  });

  it("is kept for a failure, where it is the only trail", async () => {
    const { partial } = await run({ output: "", service: "r", success: false, error: "boom" });
    expect(existsSync(partial)).toBe(true);
  });

  it("is kept for a success that produced no output of its own", async () => {
    const { partial } = await run({ output: "", service: "r", success: true });
    expect(existsSync(partial)).toBe(true);
  });
});
