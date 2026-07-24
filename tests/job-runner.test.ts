import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "job-runner.js",
);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-runner-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * End-to-end proof that a background run survives independently of the
 * process that created the job: the job bundle is written here, but
 * executed by a SEPARATE node process (the real dist/ runner) that
 * bootstraps its own runtime from config — exactly what happens when the
 * MCP server that started a job dies.
 *
 * The route is a `generic` harness whose command is node itself, so the
 * test needs no external CLI and works on every CI platform.
 */
describe("detached job runner", () => {
  it.skipIf(!existsSync(RUNNER))(
    "executes a job bundle to completion in a separate process",
    async () => {
      const configPath = path.join(tmpDir, "config.yaml");
      await fs.writeFile(
        configPath,
        [
          "clis:",
          "  - name: echo_node",
          "    harness: generic",
          "    command: node",
          "    tier: 3",
          "    billing_kind: local_compute",
          "    paid_usage_possible: false",
          "    protocol:",
          '      args: ["-e", "console.log(\'runner-ok \' + process.argv[1])", "{{prompt}}"]',
          "      output: { mode: text }",
        ].join("\n"),
        "utf8",
      );

      const jobId = "job-0000000000002-runner";
      const jobDir = path.join(tmpDir, jobId);
      await fs.mkdir(path.join(jobDir, "context"), { recursive: true });
      await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
      const promptPath = path.join(jobDir, "prompt.md");
      await fs.writeFile(promptPath, "hello-prompt", "utf8");
      const createdAt = new Date().toISOString();
      await fs.writeFile(
        path.join(jobDir, "manifest.json"),
        JSON.stringify({
          jobId,
          createdAt,
          workingDir: tmpDir,
          promptPath,
          files: [],
          service: "echo_node",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(jobDir, "status.json"),
        JSON.stringify({ jobId, status: "queued", createdAt, updatedAt: createdAt, jobDir }),
        "utf8",
      );

      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [RUNNER, jobDir], {
          env: {
            ...process.env,
            HARNESS_DISPATCH_CONFIG: configPath,
            HARNESS_DISPATCH_JOBS_DIR: tmpDir,
          },
          stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(0);

      const result = JSON.parse(
        await fs.readFile(path.join(jobDir, "output", "result.json"), "utf8"),
      ) as { result: { success: boolean; output: string; service: string } };
      expect(result.result.success).toBe(true);
      expect(result.result.output).toContain("runner-ok hello-prompt");

      const status = JSON.parse(
        await fs.readFile(path.join(jobDir, "status.json"), "utf8"),
      ) as { status: string; route?: string };
      expect(status.status).toBe("completed");
      expect(status.route).toBe("echo_node");
    },
    60_000,
  );
});
