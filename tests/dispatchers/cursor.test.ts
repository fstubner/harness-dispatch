import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = cursor();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("cursor");
    expect(res.error).toMatch(/'cursor-agent' not found on PATH/i);
    expect(res.output).toBe("");
    expect(runSubprocessMock).not.toHaveBeenCalled();
    expect(resolveCliCommandMock).not.toHaveBeenCalled();
  });

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

  it("passes --model <override> through to the subprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = cursor();
    await d.dispatch("go", [], "/tmp", { modelOverride: "claude-4-cursor" });

    expect(runSubprocessMock).toHaveBeenCalledTimes(1);
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-4-cursor");
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

  it("reports failure on a non-zero exit code", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: "", stderr: "bad thing", exitCode: 2 }),
    );

    const d = cursor();
    const res = await d.dispatch("go", [], "/tmp");

    expect(res.success).toBe(false);
    expect(res.error).toBe("bad thing");
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

  it("returns a timed-out DispatchResult when the subprocess times out", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "",
        exitCode: 124,
        timedOut: true,
      }),
    );

    const d = cursor();
    const res = await d.dispatch("go", [], "/tmp", { timeoutMs: 100 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
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

  it("has a stable id and reports itself as available", () => {
    const d = cursor();
    expect(d.id).toBe("cursor");
    expect(d.isAvailable()).toBe(true);
  });
});
