import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamFromBuffered } from "../support/buffered-stream.js";

import type { SubprocessResult } from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/harness-presets.js";

// The contract EVERY shipped harness preset owes, asserted once per harness
// instead of once per file.
//
// There is no per-harness dispatcher class: each built-in harness is
// GenericCliDispatcher parameterised by a protocol block in
// config.default.yaml. So "does Codex report a missing CLI correctly" is not a
// Codex question, it is a question about the shared interpreter driven by
// Codex's preset — and it was written out four times, once in each of
// claude-code/codex/cursor/antigravity.test.ts, drifting slightly as it went
// (three files check `resolveCliCommand` was not called, one does not; two
// assert the empty output, two do not).
//
// What stays in those files is what is genuinely specific: Codex's JSONL
// agent_message extraction and `--cd` handling, Cursor's `--workspace` default
// and Retry-After parsing, Antigravity's live streaming and safety-flag
// mapping, Claude Code's raw-stdout fallback. Those differ per harness for
// real reasons and a table would flatten them into nothing.
//
// Adding a harness to config.default.yaml and forgetting to test it is now
// visible: the table is derived from PROTOCOL_PRESETS, and a preset with no
// row here fails the completeness check at the bottom.

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
// The dispatcher calls `streamSubprocess`, never `runSubprocess`. Production
// code used to notice the mock above and quietly reroute through a buffered
// adapter; that branch is gone, so the seam is declared here instead. The
// buffered mock stays because every assertion below reads argv, env and stdin
// off it.
vi.mock("../../src/dispatchers/shared/stream-subprocess.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/dispatchers/shared/stream-subprocess.js")
  >()),
  streamSubprocess: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/windows-cmd.js", () => ({
  resolveCliCommand: vi.fn(),
}));
// `sync` is load-bearing: commandAvailable() uses which.sync(), and it fails
// CLOSED when that is not a function. A bare vi.fn() with no .sync is not what
// the real package looks like, and mocking it that way is what let a fail-open
// branch sit unnoticed.
vi.mock("which", () => {
  const fn = vi.fn() as unknown as { sync: (cmd: string) => string | null };
  fn.sync = () => "/usr/local/bin/stub";
  return { default: fn };
});

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { streamSubprocess } = await import(
  "../../src/dispatchers/shared/stream-subprocess.js"
);
const streamSubprocessMock = streamSubprocess as unknown as ReturnType<
  typeof vi.fn
>;
const { resolveCliCommand } = await import("../../src/dispatchers/shared/windows-cmd.js");
const { default: which } = await import("which");
const { GenericCliDispatcher } = await import("../../src/dispatchers/generic-cli.js");

const runSubprocessMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<typeof vi.fn>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return { stdout: "", stderr: "", exitCode: 0, durationMs: 42, timedOut: false, ...overrides };
}

/** Every harness the shipped config defines a protocol for. */
const HARNESSES = [
  { harness: "claude_code", command: "claude" },
  { harness: "codex", command: "codex" },
  { harness: "cursor", command: "cursor-agent" },
  { harness: "antigravity_cli", command: "agy" },
] as const;

function dispatcherFor(harness: string, command: string, overrides: Partial<ServiceConfig> = {}) {
  return new GenericCliDispatcher({
    name: harness,
    enabled: true,
    type: "cli",
    harness,
    command,
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol: PROTOCOL_PRESETS[harness]!,
    ...overrides,
  } as ServiceConfig);
}

function mockFound(commandPath: string): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({ command: commandPath, prefixArgs: [] });
}

beforeEach(() => {
  runSubprocessMock.mockReset();
  streamSubprocessMock.mockImplementation(streamFromBuffered(runSubprocessMock));
  resolveCliCommandMock.mockReset();
  whichMock.mockReset();
});

describe.each(HARNESSES)("$harness, driven by its shipped preset", ({ harness, command }) => {
  it("reports a missing CLI without spawning anything", async () => {
    whichMock.mockResolvedValue(null);

    const res = await dispatcherFor(harness, command).dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe(harness);
    expect(res.error, "the error does not name the command the user must install").toMatch(
      new RegExp(`'${command}' not found on PATH`, "i"),
    );
    expect(res.output).toBe("");
    // Nothing may be spawned, and nothing may even be resolved: both were
    // asserted in some of the four files and not others.
    expect(runSubprocessMock).not.toHaveBeenCalled();
    expect(resolveCliCommandMock).not.toHaveBeenCalled();
  });

  it("reports failure on a non-zero exit", async () => {
    mockFound(`/usr/local/bin/${command}`);
    runSubprocessMock.mockResolvedValue(ok({ exitCode: 2, stderr: "boom" }));

    const res = await dispatcherFor(harness, command).dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe(harness);
  });

  it("passes a model override through to the subprocess", async () => {
    mockFound(`/usr/local/bin/${command}`);
    runSubprocessMock.mockResolvedValue(ok({ stdout: "done" }));

    await dispatcherFor(harness, command).dispatch("hi", [], "", { modelOverride: "some-model" });

    const args = runSubprocessMock.mock.calls[0]?.[1] as string[];
    expect(args, "the override never reached the command line").toContain("some-model");
  });

  it("reports a timed-out run as a failure rather than a success with no output", async () => {
    mockFound(`/usr/local/bin/${command}`);
    runSubprocessMock.mockResolvedValue(ok({ timedOut: true }));

    const res = await dispatcherFor(harness, command).dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/timed out/i);
  });

  it("has a stable id and reports availability from the command on PATH", async () => {
    const d = dispatcherFor(harness, command);
    expect(d.id).toBe(harness);
    expect(d.isAvailable()).toBe(true);
  });
});

it("covers every harness the shipped config defines a protocol for", () => {
  // The guard against this table decaying. A new preset in config.default.yaml
  // with no row above would otherwise ship with none of the contract asserted
  // — which is how the per-file version drifted in the first place.
  const covered = new Set(HARNESSES.map((h) => h.harness));
  const missing = Object.keys(PROTOCOL_PRESETS).filter((name) => !covered.has(name as never));
  expect(missing, `shipped presets with no contract row: ${missing.join(", ")}`).toEqual([]);
});
