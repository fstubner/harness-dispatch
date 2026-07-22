import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceConfig } from "../../src/types.js";
import { PROTOCOL_PRESETS } from "../../src/config.js";

const ANTIGRAVITY_PROTOCOL = PROTOCOL_PRESETS.antigravity_cli!;

// There is no AntigravityDispatcher class — Antigravity is
// GenericCliDispatcher parameterized by the antigravity_cli preset (see
// the shipped config.default.yaml).

vi.mock("../../src/dispatchers/shared/stream-subprocess.js", () => ({
  streamSubprocess: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/windows-cmd.js", () => ({
  resolveCliCommand: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/which-available.js", () => ({
  commandAvailable: vi.fn(),
}));
vi.mock("which", () => ({
  default: vi.fn(),
}));

const { streamSubprocess } = await import(
  "../../src/dispatchers/shared/stream-subprocess.js"
);
const { resolveCliCommand } = await import(
  "../../src/dispatchers/shared/windows-cmd.js"
);
const { commandAvailable } = await import(
  "../../src/dispatchers/shared/which-available.js"
);
const { default: which } = await import("which");
const { GenericCliDispatcher } = await import(
  "../../src/dispatchers/generic-cli.js"
);

const streamSubprocessMock = streamSubprocess as unknown as ReturnType<
  typeof vi.fn
>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<
  typeof vi.fn
>;
const commandAvailableMock = commandAvailable as unknown as ReturnType<
  typeof vi.fn
>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

type StreamEvent =
  | { stream: "stdout" | "stderr"; chunk: string }
  | { exitCode: number; durationMs: number; timedOut: boolean };

function mockStream(events: StreamEvent[]): void {
  streamSubprocessMock.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

function exit(
  overrides: Partial<{
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  }> = {},
): StreamEvent {
  return { exitCode: 0, durationMs: 10, timedOut: false, ...overrides };
}

function mockFound(commandPath = "/usr/local/bin/agy"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({
    command: commandPath,
    prefixArgs: [],
  });
}

function baseSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "antigravity_cli",
    enabled: true,
    type: "cli",
    harness: "antigravity_cli",
    command: "agy",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    escalateOn: [],
    capabilities: {},
    protocol: ANTIGRAVITY_PROTOCOL,
    ...overrides,
  } as ServiceConfig;
}

async function runToCompletion(
  dispatcher: InstanceType<typeof GenericCliDispatcher>,
  prompt: string,
  files: string[] = [],
  workingDir = "/repo",
  opts: Record<string, unknown> = {},
) {
  let completion: unknown;
  for await (const event of dispatcher.stream(prompt, files, workingDir, opts)) {
    if ((event as { type: string }).type === "completion") {
      completion = (event as { result: unknown }).result;
    }
  }
  return completion as {
    output: string;
    service: string;
    success: boolean;
    error?: string;
    rateLimited?: boolean;
    retryAfter?: number;
  };
}

function capturedArgs(index = 0): string[] {
  const call = streamSubprocessMock.mock.calls[index];
  if (!call) throw new Error(`streamSubprocess call #${index} not recorded`);
  return call[1] as string[];
}

beforeEach(() => {
  streamSubprocessMock.mockReset();
  resolveCliCommandMock.mockReset();
  commandAvailableMock.mockReset();
  whichMock.mockReset();
});

describe("Antigravity (GenericCliDispatcher + ANTIGRAVITY_PROTOCOL)", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    const result = await runToCompletion(dispatcher, "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(streamSubprocessMock).not.toHaveBeenCalled();
  });

  it("collects stdout and reports success on exit code 0", async () => {
    mockFound();
    mockStream([
      { stream: "stdout", chunk: "AGY " },
      { stream: "stdout", chunk: "OK\n" },
      exit(),
    ]);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    const result = await runToCompletion(dispatcher, "hello");
    expect(result.success).toBe(true);
    expect(result.output).toBe("AGY OK");
    const args = capturedArgs();
    expect(args).toContain("--print");
    expect(args[args.length - 1]).toBe("hello");
  });

  it("streams stdout events live instead of buffering until the process exits", async () => {
    mockFound();
    const order: string[] = [];
    streamSubprocessMock.mockImplementation(async function* () {
      order.push("mock:stdout1");
      yield { stream: "stdout", chunk: "first " };
      order.push("mock:stdout2");
      yield { stream: "stdout", chunk: "second" };
      order.push("mock:exit");
      yield exit();
    });

    const dispatcher = new GenericCliDispatcher(baseSvc());
    for await (const event of dispatcher.stream("hello", [], "/repo")) {
      order.push(`consumer-saw:${(event as { type: string }).type}`);
    }

    // Buffered (the bug): every mock: entry, then every consumer-saw: entry
    // — the consumer never sees anything until the subprocess has already
    // fully exited. Streamed (fixed): each mock: yield is immediately
    // followed by its matching consumer-saw: entry, interleaved.
    const firstConsumerIndex = order.findIndex((e) => e.startsWith("consumer-saw"));
    const lastMockIndex = order.reduce((acc, e, i) => (e.startsWith("mock:") ? i : acc), -1);
    expect(firstConsumerIndex).toBeLessThan(lastMockIndex);
    expect(order[0]).toBe("mock:stdout1");
    expect(order[1]).toBe("consumer-saw:stdout");
  });

  it("maps safety profiles to agy v1.1 flags", async () => {
    mockFound();
    const dispatcher = new GenericCliDispatcher(baseSvc());

    mockStream([exit()]);
    await runToCompletion(dispatcher, "x", [], "/repo", {
      safetyProfile: "read_only",
    });
    expect(capturedArgs(0).join(" ")).toContain("--mode plan");
    expect(capturedArgs(0)).toContain("--sandbox");

    mockStream([exit()]);
    await runToCompletion(dispatcher, "x", [], "/repo", {
      safetyProfile: "workspace_edit",
    });
    expect(capturedArgs(1).join(" ")).toContain("--mode accept-edits");

    mockStream([exit()]);
    await runToCompletion(dispatcher, "x", [], "/repo", {
      safetyProfile: "full_auto",
    });
    expect(capturedArgs(2)).toContain("--dangerously-skip-permissions");
  });

  it("passes --model from override, falling back to configured model", async () => {
    mockFound();
    const dispatcher = new GenericCliDispatcher(
      baseSvc({ model: "gemini-3.1-pro" } as Partial<ServiceConfig>),
    );

    mockStream([exit()]);
    await runToCompletion(dispatcher, "x", [], "/repo", {
      modelOverride: "gemini-3.1-flash",
    });
    const first = capturedArgs(0);
    expect(first[first.indexOf("--model") + 1]).toBe("gemini-3.1-flash");

    mockStream([exit()]);
    await runToCompletion(dispatcher, "x");
    const second = capturedArgs(1);
    expect(second[second.indexOf("--model") + 1]).toBe("gemini-3.1-pro");
  });

  it("appends file context to the prompt and adds external dirs via --add-dir", async () => {
    mockFound();
    mockStream([exit()]);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    await runToCompletion(
      dispatcher,
      "review this",
      ["/elsewhere/lib/a.ts"],
      "/repo",
    );
    const args = capturedArgs();
    // {{working_dir}} and {{file_dirs}} both map to --add-dir for agy: the
    // workingDir itself plus each external file's directory get context.
    const addDirs = args.reduce<string[]>((acc, a, i) => {
      if (a === "--add-dir") acc.push(args[i + 1]!);
      return acc;
    }, []);
    expect(addDirs).toContain("/repo");
    expect(addDirs).toContain("/elsewhere/lib");
    expect(args[args.length - 1]).toContain("Files to work with:");
    expect(args[args.length - 1]).toContain("/elsewhere/lib/a.ts");
  });

  it("reports failure with rate-limit detection on non-zero exit", async () => {
    mockFound();
    mockStream([
      { stream: "stderr", chunk: "429 quota exceeded, retry_after: 42" },
      exit({ exitCode: 1 }),
    ]);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    const result = await runToCompletion(dispatcher, "x");
    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfter).toBe(42);
  });

  it("returns a timed-out DispatchResult when the subprocess times out", async () => {
    mockFound();
    mockStream([exit({ exitCode: -1, timedOut: true, durationMs: 600_000 })]);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    const result = await runToCompletion(dispatcher, "x");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out");
  });

  it("has a stable id and delegates availability to commandAvailable", () => {
    commandAvailableMock.mockReturnValue(true);
    const dispatcher = new GenericCliDispatcher(baseSvc());
    expect(dispatcher.id).toBe("antigravity_cli");
    expect(dispatcher.isAvailable()).toBe(true);
    expect(commandAvailableMock).toHaveBeenCalledWith("agy");
  });
});
