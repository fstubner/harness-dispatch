import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamFromBuffered } from "../support/buffered-stream.js";
import type {
  SubprocessResult,
  RunSubprocessOpts,
} from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/harness-presets.js";

const CODEX_PROTOCOL = PROTOCOL_PRESETS.codex!;

// There is no CodexDispatcher class — Codex is GenericCliDispatcher
// parameterized by the codex preset (see the shipped config.default.yaml),
// including its real tool_use/thinking/usage event semantics via eventRules.

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

function mockFound(commandPath = "/usr/local/bin/codex"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({
    command: commandPath,
    prefixArgs: [],
  });
}

function codex(overrides: Partial<ServiceConfig> = {}) {
  return new GenericCliDispatcher({
    name: "codex",
    enabled: true,
    type: "cli",
    harness: "codex",
    command: "codex",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol: CODEX_PROTOCOL,
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
  // Restore env to avoid bleed across tests.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("Codex (GenericCliDispatcher + CODEX_PROTOCOL)", () => {
  // The shared contract every shipped preset owes — a missing CLI, a non-zero
  // exit, a model override, a timeout, id and availability — lives in
  // shipped-presets.test.ts, asserted once per harness from one table. What
  // remains below is what is specific to this harness.

  it("extracts the last agent_message item from JSONL output", async () => {
    mockFound();
    const jsonl = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "first" },
        usage: { input_tokens: 4, output_tokens: 5 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "final answer" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: jsonl }));

    const d = codex();
    const res = await d.dispatch("write code", [], "");

    expect(res.success).toBe(true);
    expect(res.service).toBe("codex");
    expect(res.output).toBe("final answer");
    // Usage is summed across events.
    expect(res.tokensUsed).toEqual({ input: 6, output: 8 });
  });

  it("appends --cd <workingDir> when workingDir is non-empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = codex();
    await d.dispatch("go", [], "/tmp/project");

    const { args, opts } = captureSubprocessCall(0);
    expect(args).toContain("--cd");
    const idx = args.indexOf("--cd");
    expect(args[idx + 1]).toBe("/tmp/project");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.at(-1)).toBe("-");
    expect(opts?.stdin).toBe("go");
  });

  it("does NOT append --cd when workingDir is empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = codex();
    await d.dispatch("go", [], "");

    const { args } = captureSubprocessCall(0);
    expect(args).not.toContain("--cd");
  });

  it("forwards only a configured OPENAI_API_KEY to the subprocess", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-12345";
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = codex({ apiKey: "configured-key" });
    await d.dispatch("go", [], "");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env).toBeDefined();
    expect(opts?.env?.["OPENAI_API_KEY"]).toBe("configured-key");
  });

  it("does NOT forward OPENAI_API_KEY when the env var is unset", async () => {
    delete process.env["OPENAI_API_KEY"];
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = codex();
    await d.dispatch("go", [], "");

    const { opts } = captureSubprocessCall(0);
    // env should either be undefined or not contain the key.
    if (opts?.env) {
      expect(opts.env["OPENAI_API_KEY"]).toBeUndefined();
    }
  });

  it("uses Codex harness-native Ollama routing when configured", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = codex({
      name: "codex_ollama",
      model: "qwen3-coder:latest",
      tier: 3,
      endpointMode: "harness_native_endpoint",
      endpointProvider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      wireProtocol: "openai_chat_completions",
    });
    await d.dispatch("go", [], "");

    const { args, opts } = captureSubprocessCall(0);
    expect(args).toContain("--oss");
    expect(args).toContain("--local-provider");
    expect(args[args.indexOf("--local-provider") + 1]).toBe("ollama");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("qwen3-coder:latest");
    expect(opts?.env?.["OPENAI_API_KEY"]).toBeUndefined();
  });

  it("reports 'unknown' quota", async () => {
    const d = codex();
    const q = await d.checkQuota();
    expect(q.service).toBe("codex");
    expect(q.source).toBe("unknown");
  });

});
