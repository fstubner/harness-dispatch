import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamFromBuffered } from "../support/buffered-stream.js";
import type {
  SubprocessResult,
  RunSubprocessOpts,
} from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/harness-presets.js";

const CURSOR_PROTOCOL = PROTOCOL_PRESETS.cursor!;

// There is no CursorDispatcher class — Cursor is GenericCliDispatcher
// parameterized by the cursor preset (see the shipped config.default.yaml),
// including its workingDir.fallback: "home" behavior for an empty workingDir.

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
// `sync` is load-bearing: commandAvailable() uses which.sync(), and it now
// fails CLOSED when that isn't a function. A bare vi.fn() with no .sync is
// not what the real package looks like, and mocking it that way is what let
// the fail-open branch sit unnoticed.
vi.mock("which", () => {
  const fn = vi.fn() as unknown as { sync: (cmd: string) => string | null };
  fn.sync = () => "/usr/local/bin/stub";
  return { default: fn };
});

const { runSubprocess } = await import(
  "../../src/dispatchers/shared/subprocess.js"
);
const { streamSubprocess } = await import(
  "../../src/dispatchers/shared/stream-subprocess.js"
);
const streamSubprocessMock = streamSubprocess as unknown as ReturnType<
  typeof vi.fn
>;
const { resolveCliCommand } = await import(
  "../../src/dispatchers/shared/windows-cmd.js"
);
const { default: which } = await import("which");
const { GenericCliDispatcher } = await import(
  "../../src/dispatchers/generic-cli.js"
);

const runSubprocessMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<
  typeof vi.fn
>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 42,
    timedOut: false,
    ...overrides,
  };
}

function captureSubprocessCall(index: number): {
  command: string;
  args: string[];
  opts: RunSubprocessOpts | undefined;
} {
  const call = runSubprocessMock.mock.calls[index];
  if (!call) throw new Error(`runSubprocess call #${index} not recorded`);
  return {
    command: call[0] as string,
    args: call[1] as string[],
    opts: call[2] as RunSubprocessOpts | undefined,
  };
}

function mockFound(commandPath = "/usr/local/bin/cursor-agent"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({
    command: commandPath,
    prefixArgs: [],
  });
}

function cursor(overrides: Partial<ServiceConfig> = {}) {
  return new GenericCliDispatcher({
    name: "cursor",
    enabled: true,
    type: "cli",
    harness: "cursor",
    command: "cursor-agent",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol: CURSOR_PROTOCOL,
    ...overrides,
  } as ServiceConfig);
}

const savedEnv = { ...process.env };

beforeEach(() => {
  runSubprocessMock.mockReset();
  streamSubprocessMock.mockImplementation(streamFromBuffered(runSubprocessMock));
  resolveCliCommandMock.mockReset();
  whichMock.mockReset();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("Cursor (GenericCliDispatcher + CURSOR_PROTOCOL)", () => {
  // The shared contract every shipped preset owes — a missing CLI, a non-zero
  // exit, a model override, a timeout, id and availability — lives in
  // shipped-presets.test.ts, asserted once per harness from one table. What
  // remains below is what is specific to this harness.

  it("parses JSON result on a successful run", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "hello from cursor",
          usage: { input_tokens: 7, output_tokens: 13 },
        }),
      }),
    );

    const d = cursor();
    const res = await d.dispatch("do thing", [], "/tmp/work");

    expect(res.success).toBe(true);
    expect(res.service).toBe("cursor");
    expect(res.output).toBe("hello from cursor");
    expect(res.tokensUsed).toEqual({ input: 7, output: 13 });
    expect(res.durationMs).toBe(42);
  });

  it("sets --workspace <workingDir> when provided", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = cursor();
    await d.dispatch("go", [], "/tmp/project");

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--workspace");
    const idx = args.indexOf("--workspace");
    expect(args[idx + 1]).toBe("/tmp/project");
    // Also includes --trust and -p.
    expect(args).toContain("--trust");
    expect(args).toContain("-p");
    // Output format is json.
    expect(args).toContain("--output-format");
    const jidx = args.indexOf("--output-format");
    expect(args[jidx + 1]).toBe("json");
  });

  it("defaults --workspace to HOME when workingDir is empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = cursor();
    await d.dispatch("go", [], "");

    const { args } = captureSubprocessCall(0);
    const widx = args.indexOf("--workspace");
    expect(widx).toBeGreaterThanOrEqual(0);
    // Should not be an empty string.
    expect(args[widx + 1]).not.toBe("");
    expect(args[widx + 1]?.length ?? 0).toBeGreaterThan(0);
  });

  it("forwards only a configured CURSOR_API_KEY to the subprocess", async () => {
    process.env["CURSOR_API_KEY"] = "cursor-key-xyz";
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = cursor({ apiKey: "configured-cursor-key" });
    await d.dispatch("go", [], "/tmp");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env).toBeDefined();
    expect(opts?.env?.["CURSOR_API_KEY"]).toBe("configured-cursor-key");
  });

  it("marks rateLimited=true with retryAfter from 'Retry-After: N' stderr", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "Error: 429 Too Many Requests — retry-after: 30",
        exitCode: 1,
      }),
    );

    const d = cursor();
    const res = await d.dispatch("go", [], "/tmp");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(30);
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = cursor();
    await d.dispatch("go", [], "/tmp", { timeoutMs: 9999 });

    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(9999);
  });

  it("reports 'unknown' quota", async () => {
    const d = cursor();
    const q = await d.checkQuota();
    expect(q.service).toBe("cursor");
    expect(q.source).toBe("unknown");
  });

});
