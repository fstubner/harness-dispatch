import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SubprocessResult,
  RunSubprocessOpts,
} from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/harness-presets.js";

const CLAUDE_CODE_PROTOCOL = PROTOCOL_PRESETS.claude_code!;

// There is no ClaudeCodeDispatcher class — Claude Code is GenericCliDispatcher
// parameterized by the claude_code preset (see the shipped config.default.yaml).
// This suite exercises that exact protocol through the shared interpreter.

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

/** Typed accessor for the positional `runSubprocess(command, args, opts?)` call. */
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

function mockFound(commandPath = "/usr/local/bin/claude"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({
    command: commandPath,
    prefixArgs: [],
  });
}

function claudeCode(overrides: Partial<ServiceConfig> = {}) {
  return new GenericCliDispatcher({
    name: "claude_code",
    enabled: true,
    type: "cli",
    harness: "claude_code",
    command: "claude",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol: CLAUDE_CODE_PROTOCOL,
    ...overrides,
  } as ServiceConfig);
}

beforeEach(() => {
  runSubprocessMock.mockReset();
  resolveCliCommandMock.mockReset();
  whichMock.mockReset();
});

describe("Claude Code (GenericCliDispatcher + CLAUDE_CODE_PROTOCOL)", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = claudeCode();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("claude_code");
    expect(res.error).toMatch(/'claude' not found on PATH/i);
    expect(res.output).toBe("");
    expect(runSubprocessMock).not.toHaveBeenCalled();
    expect(resolveCliCommandMock).not.toHaveBeenCalled();
  });

  it("parses structured JSON output on a successful run", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "hello",
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      }),
    );

    const d = claudeCode();
    const res = await d.dispatch("do thing", [], "/tmp/work");

    expect(res.success).toBe(true);
    expect(res.service).toBe("claude_code");
    expect(res.output).toBe("hello");
    expect(res.tokensUsed).toEqual({ input: 10, output: 20 });
    expect(res.durationMs).toBe(42);
  });

  it("falls back to raw stdout when JSON parsing fails but exit code is 0", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: "not valid json at all" }),
    );

    const d = claudeCode();
    const res = await d.dispatch("do thing", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("not valid json at all");
    expect(res.tokensUsed).toBeUndefined();
  });

  it("reports failure on non-zero exit code", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "boom",
        exitCode: 1,
      }),
    );

    const d = claudeCode();
    const res = await d.dispatch("do thing", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toBe("boom");
  });

  it("passes --model <override> through to the subprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = claudeCode();
    await d.dispatch("do thing", [], "", {
      modelOverride: "claude-opus-4-6",
    });

    expect(runSubprocessMock).toHaveBeenCalledTimes(1);
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-opus-4-6");
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "ok" }) }),
    );

    const d = claudeCode();
    await d.dispatch("go", [], "", { timeoutMs: 5000 });

    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(5000);
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

    const d = claudeCode();
    const res = await d.dispatch("go", [], "", { timeoutMs: 100 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it("reports 'unknown' quota", async () => {
    const d = claudeCode();
    const q = await d.checkQuota();
    expect(q.service).toBe("claude_code");
    expect(q.source).toBe("unknown");
  });

  it("has a stable id and reports itself as available", () => {
    const d = claudeCode();
    expect(d.id).toBe("claude_code");
    expect(d.isAvailable()).toBe(true);
  });

  it("a config-level protocol: override replaces the built-in default entirely", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "plain text reply" }));

    const d = claudeCode({
      protocol: {
        args: ["{{prompt}}"],
        output: { mode: "text" },
        successRequiresOutput: false,
      },
    });

    const res = await d.dispatch("do thing", [], "/tmp");
    expect(res.success).toBe(true);
    expect(res.output).toBe("plain text reply");

    const { args } = captureSubprocessCall(0);
    // The overriding protocol has no -p flag or --output-format json — proof
    // the built-in default wasn't silently used underneath the override.
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--output-format");
    expect(args[args.length - 1]).toBe("do thing");
  });
});
