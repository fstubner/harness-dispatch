/**
 * A server instance that cannot be built must stop startup, not answer every
 * request with "Internal server error".
 *
 * The SDK's serving entries build instances lazily, on a connection's first
 * message. If building throws (the near-miss guard's check, when an SDK update
 * stops it from wrapping `tools/call`), stdio answered every request with
 * -32603 and printed nothing, so the server looked alive and served no tools.
 * bootstrapMcpRuntime builds one instance up front so the cause is reported.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/mcp/near-miss-guard.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/mcp/near-miss-guard.js")>();
  return {
    ...original,
    installNearMissGuard: () => () => {
      throw new Error("near-miss guard did not wrap tools/call");
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-startup-check-"));
  vi.stubEnv("HARNESS_DISPATCH_STATE_DIR", dir);
  vi.stubEnv("HARNESS_DISPATCH_LOG_DIR", path.join(dir, "logs"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(dir, "jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("MCP startup", () => {
  it("fails with the build error when a server instance cannot be built", async () => {
    const configPath = path.join(dir, "config.yaml");
    // Only a fake route, and every auto-detected one disabled, so nothing real
    // is configured or reachable.
    await fs.writeFile(
      configPath,
      [
        "detect: true",
        "disabled: [claude_code_cli, codex_cli, cursor_cli, antigravity_cli, gemini_cli]",
        "clis:",
        "  - name: fake_cli",
        "    command: node",
        "    args: ['-e', 'console.log(1)']",
        "",
      ].join("\n"),
      "utf8",
    );
    const { bootstrapMcpRuntime } = await import("../../src/mcp/server.js");
    await expect(bootstrapMcpRuntime({ configPath })).rejects.toThrow(
      "near-miss guard did not wrap tools/call",
    );
  });
});
