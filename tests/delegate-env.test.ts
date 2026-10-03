/**
 * What a delegated agent CLI inherits from this process's environment.
 *
 * The child is spawned with `{ ...process.env, ...extraEnv }`, so anything not
 * blanked here reaches it. These run a real child that prints what it saw,
 * because the failure being guarded is precisely a variable arriving that
 * should not have (or vanishing when it should not have).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildDispatchers } from "../src/mcp/dispatcher-factory.js";
import type { DispatchResult } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-delegate-env-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const WATCHED = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "HARNESS_DISPATCH_HTTP_TOKEN",
  "GITHUB_TOKEN",
  "HD_TEST_ENDPOINT_KEY",
  "HD_TEST_MODEL",
  "HARNESS_DISPATCH_DEPTH",
];

/** A route whose child prints the watched variables as JSON, plus an endpoint keyed from env. */
async function probe(): Promise<() => Promise<DispatchResult>> {
  const printer = path.join(dir, "printenv.cjs");
  await fs.writeFile(
    printer,
    `const keys = ${JSON.stringify(WATCHED)};\n` +
      "const out = {};\n" +
      "for (const k of keys) out[k] = process.env[k] === undefined ? null : process.env[k];\n" +
      "process.stdout.write(JSON.stringify(out));\n",
    "utf8",
  );
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "clis:",
      "  - name: probe",
      "    harness: generic",
      "    command: node",
      "    model: ${HD_TEST_MODEL}",
      "    tier: 1",
      "    protocol:",
      `      args: [${JSON.stringify(printer.split("\\").join("/"))}]`,
      "      output: { mode: text }",
      "endpoints:",
      "  - name: keyed",
      "    base_url: https://api.example.test/v1",
      "    model: m",
      "    api_key: ${HD_TEST_ENDPOINT_KEY}",
      "",
    ].join("\n"),
    "utf8",
  );
  const cfg = await loadConfig(file, { whichFn: async () => null });
  const d = buildDispatchers(cfg)["probe"]!;
  return () => d.dispatch("hi", [], dir);
}

function seen(result: DispatchResult): Record<string, string | null> {
  expect(result.success, result.error).toBe(true);
  return JSON.parse(result.output) as Record<string, string | null>;
}

describe("a delegate's environment", () => {
  it("does not receive billing switches, the HTTP token or GITHUB_TOKEN", async () => {
    // audit5 F5: all four were seen set in a delegate. CODEX_API_KEY and
    // ANTHROPIC_AUTH_TOKEN move a subscription route onto metered billing
    // while it stays classified product_login.
    for (const k of WATCHED.slice(0, 6)) vi.stubEnv(k, "value-that-must-not-arrive");
    const out = seen(await (await probe())());
    for (const k of WATCHED.slice(0, 6)) expect(out[k], k).toBe("");
  });

  it("blanks a ${VAR} that holds a credential, and leaves any other ${VAR} alone", async () => {
    // audit4 A1-1: every ${VAR} named anywhere in config was blanked in every
    // child, so `command: ${LOCALAPPDATA}\...` on one route emptied
    // LOCALAPPDATA for all of them.
    vi.stubEnv("HD_TEST_ENDPOINT_KEY", "sk-endpoint-key-0123456789");
    vi.stubEnv("HD_TEST_MODEL", "some-model-name");
    const out = seen(await (await probe())());
    expect(out["HD_TEST_ENDPOINT_KEY"]).toBe("");
    expect(out["HD_TEST_MODEL"]).toBe("some-model-name");
  });

  it("is marked one level deeper, and a delegate cannot dispatch at all", async () => {
    // audit5 F7: nothing marked a delegate as nested, so a delegate with this
    // server among its MCP servers, or with shell, could dispatch without bound.
    vi.stubEnv("HARNESS_DISPATCH_DEPTH", "");
    const run = await probe();
    expect(seen(await run())["HARNESS_DISPATCH_DEPTH"]).toBe("1");

    vi.stubEnv("HARNESS_DISPATCH_DEPTH", "1");
    const refused = await run();
    expect(refused.success).toBe(false);
    expect(refused.inputRejected).toBe(true);
    expect(refused.error).toMatch(/may not dispatch at all/);
    expect(refused.output).toBe("");
});
});
