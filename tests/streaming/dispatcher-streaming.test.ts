/**
 * Dispatcher streaming tests — mock `runSubprocess` (which the streaming
 * subprocess helper delegates to in test mode) and assert the events
 * emitted by GenericCliDispatcher's `stream()` method, parameterized by
 * each built-in harness's protocol (see the shipped config.default.yaml). There
 * is no per-harness dispatcher class — every CLI route runs through the same
 * `stream()` implementation, so this exercises that shared streaming
 * contract (stdout events before completion) against each harness's real
 * flags/output shape.
 *
 * The adapter in `stream-subprocess.ts` detects the vi.fn() mock on
 * runSubprocess and synthesises a stream from its buffered result.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubprocessResult } from "../../src/dispatchers/shared/subprocess.js";
import type { DispatcherEvent, ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/config.js";

const ANTIGRAVITY_PROTOCOL = PROTOCOL_PRESETS.antigravity_cli!;
const CLAUDE_CODE_PROTOCOL = PROTOCOL_PRESETS.claude_code!;
const CODEX_PROTOCOL = PROTOCOL_PRESETS.codex!;
const CURSOR_PROTOCOL = PROTOCOL_PRESETS.cursor!;

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

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { resolveCliCommand } = await import("../../src/dispatchers/shared/windows-cmd.js");
const { default: which } = await import("which");
const { GenericCliDispatcher } = await import("../../src/dispatchers/generic-cli.js");

const runMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveMock = resolveCliCommand as unknown as ReturnType<typeof vi.fn>;
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

function mockFound(cmd = "/usr/local/bin/fake"): void {
  whichMock.mockResolvedValue(cmd);
  resolveMock.mockResolvedValue({ command: cmd, prefixArgs: [] });
}

async function collect(iter: AsyncIterable<DispatcherEvent>): Promise<DispatcherEvent[]> {
  const out: DispatcherEvent[] = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

function makeSvc(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    ...overrides,
  } as ServiceConfig;
}

beforeEach(() => {
  runMock.mockReset();
  resolveMock.mockReset();
  whichMock.mockReset();
});

describe("Claude Code .stream()", () => {
  it("yields stdout then a completion event", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "hi there", usage: { input_tokens: 3, output_tokens: 4 } }) }),
    );
    const d = new GenericCliDispatcher(
      makeSvc({ name: "claude_code", command: "claude", protocol: CLAUDE_CODE_PROTOCOL }),
    );
    const events = await collect(d.stream("do it", [], "/tmp"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stdout");
    expect(types[types.length - 1]).toBe("completion");
    const last = events[events.length - 1]!;
    expect(last.type).toBe("completion");
    if (last.type === "completion") {
      expect(last.result.success).toBe(true);
      expect(last.result.output).toBe("hi there");
      expect(last.result.tokensUsed).toEqual({ input: 3, output: 4 });
    }
  });

  it("yields a failure completion when the CLI is not installed", async () => {
    whichMock.mockResolvedValue(null);
    const d = new GenericCliDispatcher(
      makeSvc({ name: "claude_code", command: "claude", protocol: CLAUDE_CODE_PROTOCOL }),
    );
    const events = await collect(d.stream("hi", [], ""));
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("completion");
    if (evt.type === "completion") {
      expect(evt.result.success).toBe(false);
      expect(evt.result.error).toMatch(/'claude' not found on PATH/);
    }
  });
});

describe("Codex .stream()", () => {
  it("emits stdout chunks and a completion with summed usage", async () => {
    mockFound();
    const jsonl =
      JSON.stringify({ type: "thread.started" }) +
      "\n" +
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "result" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }) +
      "\n";
    runMock.mockResolvedValue(ok({ stdout: jsonl }));
    const d = new GenericCliDispatcher(makeSvc({ name: "codex", command: "codex", protocol: CODEX_PROTOCOL }));
    const events = await collect(d.stream("go", [], ""));
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect(completion.result.output).toBe("result");
      expect(completion.result.tokensUsed).toEqual({ input: 2, output: 3 });
    }
  });

  it("emits a completion with error for non-zero exit", async () => {
    mockFound();
    runMock.mockResolvedValue(ok({ stdout: "", stderr: "boom", exitCode: 2 }));
    const d = new GenericCliDispatcher(makeSvc({ name: "codex", command: "codex", protocol: CODEX_PROTOCOL }));
    const events = await collect(d.stream("go", [], ""));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(false);
      expect(completion.result.error).toBe("boom");
    }
  });
});

describe("Cursor .stream()", () => {
  it("yields stdout then a completion with the parsed result", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "cursor output",
          usage: { input_tokens: 5, output_tokens: 7 },
        }),
      }),
    );
    const d = new GenericCliDispatcher(
      makeSvc({ name: "cursor", command: "cursor-agent", protocol: CURSOR_PROTOCOL }),
    );
    const events = await collect(d.stream("write tests", [], "/tmp/work"));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(true);
      expect(completion.result.output).toBe("cursor output");
      expect(completion.result.tokensUsed).toEqual({ input: 5, output: 7 });
    }
  });

  it("marks rateLimited=true on 429 indicators in stderr", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: 429 rate limit exceeded",
      }),
    );
    const d = new GenericCliDispatcher(
      makeSvc({ name: "cursor", command: "cursor-agent", protocol: CURSOR_PROTOCOL }),
    );
    const events = await collect(d.stream("go", [], "/tmp/work"));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(false);
      expect(completion.result.rateLimited).toBe(true);
    }
  });
});

describe("Antigravity .stream()", () => {
  it("runs agy in print mode and reports its output", async () => {
    mockFound("/usr/local/bin/agy");
    runMock.mockResolvedValue(ok({ stdout: "antigravity says hi" }));

    const d = new GenericCliDispatcher(
      makeSvc({ name: "antigravity_cli", command: "agy", protocol: ANTIGRAVITY_PROTOCOL }),
    );
    const events = await collect(d.stream("hi", [], "/tmp/work"));

    const completion = events.find((event) => event.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.service).toBe("antigravity_cli");
      expect(completion.result.success).toBe(true);
      expect(completion.result.output).toBe("antigravity says hi");
    }

    const args = runMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--print");
    expect(args).toContain("hi");
  });
});

describe("dispatch() still drains the stream correctly", () => {
  it("claude_code dispatch works through BaseDispatcher default", async () => {
    mockFound();
    runMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));
    const d = new GenericCliDispatcher(
      makeSvc({ name: "claude_code", command: "claude", protocol: CLAUDE_CODE_PROTOCOL }),
    );
    const res = await d.dispatch("go", [], "");
    expect(res.success).toBe(true);
    expect(res.output).toBe("ok");
  });
});
