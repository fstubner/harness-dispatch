import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startAsyncJobTracked, type JobDeps } from "../src/jobs.js";
import type { RuntimeHolder } from "../src/mcp/config-hot-reload.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-jobs-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeDeps(): JobDeps {
  const holder = {
    state: {
      router: {
        stream: async function* () {
          throw new Error("boom");
        },
        streamTo: async function* () {
          throw new Error("boom");
        },
      },
    },
  } as unknown as RuntimeHolder;
  return { holder };
}

describe("startAsyncJob file permissions", () => {
  it.skipIf(process.platform === "win32")(
    "creates job dirs and files as owner-only (0700/0600), not world-readable",
    async () => {
      // Tracked variant: await the background run before afterEach removes
      // tmpDir — the fire-and-forget form races cleanup (ENOTEMPTY on the
      // slower macOS CI runners; caught by the first cross-platform run).
      const { status, completion } = await startAsyncJobTracked(fakeDeps(), {
        prompt: "hello",
        workingDir: tmpDir,
      });
      await completion;

      const jobDir = status.jobDir;
      const dirMode = (await fs.stat(jobDir)).mode & 0o777;
      const contextMode = (await fs.stat(path.join(jobDir, "context"))).mode & 0o777;
      const outputMode = (await fs.stat(path.join(jobDir, "output"))).mode & 0o777;
      const promptMode = (await fs.stat(path.join(jobDir, "prompt.md"))).mode & 0o777;

      expect(dirMode).toBe(0o700);
      expect(contextMode).toBe(0o700);
      expect(outputMode).toBe(0o700);
      expect(promptMode).toBe(0o600);
    },
  );
});
