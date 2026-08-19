import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SubprocessResult, RunSubprocessOpts } from "../../src/dispatchers/shared/subprocess.js";
import type { CliProtocolConfig, ServiceConfig } from "../../src/types.js";

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
const { GenericCliDispatcher, detectRateLimit } = await import(
  "../../src/dispatchers/generic-cli.js"
);

const runSubprocessMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<typeof vi.fn>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return { stdout: "", stderr: "", exitCode: 0, durationMs: 42, timedOut: false, ...overrides };
}

function captureSubprocessCall(index: number): {
  command: string;
  args: string[];
  opts: RunSubprocessOpts | undefined;
} {
  const call = runSubprocessMock.mock.calls[index];
  if (!call) throw new Error(`runSubprocess call #${index} not recorded`);
  return { command: call[0] as string, args: call[1] as string[], opts: call[2] as RunSubprocessOpts | undefined };
}

function mockFound(commandPath = "/usr/local/bin/my-cli"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({ command: commandPath, prefixArgs: [] });
}

function svc(protocol: CliProtocolConfig, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "my_cli",
    enabled: true,
    type: "cli",
    harness: "generic",
    command: "my-cli",
    tier: 3,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol,
    ...overrides,
  } as ServiceConfig;
}

beforeEach(() => {
  runSubprocessMock.mockReset();
  resolveCliCommandMock.mockReset();
  whichMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GenericCliDispatcher", () => {
  it("errors without dispatching when command or protocol is missing", async () => {
    const noProtocol = new GenericCliDispatcher({
      name: "x",
      enabled: true,
      type: "cli",
      harness: "generic",
      command: "my-cli",
      tier: 3,
      weight: 1,
      cliCapability: 1,
      capabilities: {},
      escalateOn: [],
    } as ServiceConfig);
    const res = await noProtocol.dispatch("hi", [], "/tmp");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missing 'command' and\/or 'protocol'/);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("errors when the configured binary isn't found on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    const res = await d.dispatch("hi", [], "/tmp");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found on PATH/);
  });

  it("substitutes {{prompt}} wherever it's placed in args", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "the answer" }));
    const d = new GenericCliDispatcher(svc({ args: ["-p", "{{prompt}}"], output: { mode: "text" } }));
    await d.dispatch("do the thing", [], "/tmp");
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("-p");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("do the thing");
  });

  it("appends the prompt positionally when {{prompt}} is the last token", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    await d.dispatch("go", [], "/tmp");
    const { args } = captureSubprocessCall(0);
    expect(args[args.length - 1]).toBe("go");
  });

  it("writes the prompt to stdin and omits {{prompt}} from args when stdin: true", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "text" } }));
    await d.dispatch("secret prompt", [], "/tmp");
    const { args, opts } = captureSubprocessCall(0);
    expect(args).not.toContain("secret prompt");
    expect(opts?.stdin).toBe("secret prompt");
  });

  it("passes the working-dir flag when configured", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({
        args: ["{{prompt}}", "{{working_dir}}"],
        workingDir: { flag: "--cd" },
        output: { mode: "text" },
      }),
    );
    await d.dispatch("go", [], "/tmp/project");
    const { args, opts } = captureSubprocessCall(0);
    const idx = args.indexOf("--cd");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/project");
    expect(opts?.cwd).toBe("/tmp/project");
  });

  it("relies on subprocess cwd alone (no flag) when workingDir isn't configured", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    await d.dispatch("go", [], "/tmp/project");
    const { args, opts } = captureSubprocessCall(0);
    expect(args).not.toContain("/tmp/project");
    expect(opts?.cwd).toBe("/tmp/project");
  });

  it("passes the model flag only when both model.flag is configured and a model override is given", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}", "{{model}}"], model: { flag: "--model" }, output: { mode: "text" } }),
    );
    await d.dispatch("go", [], "/tmp", { modelOverride: "some-model" });
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("some-model");
  });

  it("appends per-safety-profile args for the requested profile only", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({
        args: ["{{prompt}}", "{{safety}}"],
        output: { mode: "text" },
        safety: {
          read_only: ["--mode", "plan"],
          full_auto: ["--dangerous"],
        },
      }),
    );
    await d.dispatch("go", [], "/tmp", { safetyProfile: "read_only" });
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
    expect(args).not.toContain("--dangerous");
  });

  it("always includes literal args from the template", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}", "--trust"], output: { mode: "text" } }),
    );
    await d.dispatch("go", [], "/tmp");
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--trust");
  });

  it("output mode 'text' uses raw trimmed stdout as the output", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "  plain text answer  \n" }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(true);
    expect(res.output).toBe("plain text answer");
  });

  it("output mode 'json_field' extracts the first matching field, in priority order", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ output: "from output field", text: "from text field" }) }),
    );
    const d = new GenericCliDispatcher(
      svc({
        args: ["{{prompt}}"],
        output: { mode: "json_field", fields: ["result", "output", "text"] },
      }),
    );
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(true);
    expect(res.output).toBe("from output field");
  });

  it("output mode 'json_field' supports dotted paths for nested fields", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ message: { content: "nested answer" } }) }));
    const d = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}"], output: { mode: "json_field", fields: ["message.content"] } }),
    );
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(true);
    expect(res.output).toBe("nested answer");
  });

  it("output mode 'jsonl_stream' concatenates the field from each JSON line", async () => {
    mockFound();
    const lines = [
      JSON.stringify({ text: "Hello, " }),
      "not json — ignored",
      JSON.stringify({ text: "world!" }),
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: lines }));
    const d = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}"], output: { mode: "jsonl_stream", fields: ["text"] } }),
    );
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(true);
    expect(res.output).toBe("Hello, world!");
  });

  it("reports failure on a non-zero exit code", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "bad thing", exitCode: 2 }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(false);
    expect(res.error).toBe("bad thing");
  });

  it("marks rateLimited=true from a 429 signal in combined output", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: "", stderr: "Error: 429 Too Many Requests — retry-after: 12", exitCode: 1 }),
    );
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    const res = await d.dispatch("go", [], "/tmp");
    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(12);
  });

  it("returns a timed-out DispatchResult when the subprocess times out", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "", exitCode: 124, timedOut: true }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    const res = await d.dispatch("go", [], "/tmp", { timeoutMs: 100 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    await d.dispatch("go", [], "/tmp", { timeoutMs: 9999 });
    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(9999);
  });

  it("uses the route's configured name as its dispatcher id", () => {
    const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
    expect(d.id).toBe("my_cli");
  });

  it("reports unavailable when command or protocol is missing", () => {
    const missingProtocol = new GenericCliDispatcher({
      name: "x",
      enabled: true,
      type: "cli",
      harness: "generic",
      command: "my-cli",
      tier: 3,
      weight: 1,
      cliCapability: 1,
      capabilities: {},
      escalateOn: [],
    } as ServiceConfig);
    expect(missingProtocol.isAvailable()).toBe(false);

    const missingCommand = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}"], output: { mode: "text" } }, { command: "" }),
    );
    expect(missingCommand.isAvailable()).toBe(false);
  });

  it("falls back to the route's configured model when no per-call override is given", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc(
        { args: ["{{prompt}}", "{{model}}"], model: { flag: "--model" }, output: { mode: "text" } },
        { model: "configured-default" },
      ),
    );
    await d.dispatch("go", [], "/tmp");
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("configured-default");
  });

  it("prefers a per-call model override over the configured default", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc(
        { args: ["{{prompt}}", "{{model}}"], model: { flag: "--model" }, output: { mode: "text" } },
        { model: "configured-default" },
      ),
    );
    await d.dispatch("go", [], "/tmp", { modelOverride: "override-model" });
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("override-model");
  });

  it("appends extra working-dir args only when workingDir is actually set", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({
        args: ["{{prompt}}", "{{working_dir}}"],
        workingDir: { flag: "--cd", extraArgsWhenSet: ["--skip-git-repo-check"] },
        output: { mode: "text" },
      }),
    );
    await d.dispatch("go", [], "/tmp/project");
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--skip-git-repo-check");

    runSubprocessMock.mockClear();
    await d.dispatch("go", [], "");
    const { args: argsNoWd } = captureSubprocessCall(0);
    expect(argsNoWd).not.toContain("--skip-git-repo-check");
  });

  it("repeats fileDirs.flag once per unique absolute file directory, excluding workingDir", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({
        args: ["{{prompt}}", "{{file_dirs}}"],
        fileDirs: { flag: "--add-dir" },
        output: { mode: "text" },
      }),
    );
    await d.dispatch(
      "go",
      ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/docs/readme.md", "not/absolute.ts"],
      "/repo",
    );
    const { args } = captureSubprocessCall(0);
    const dirFlags = args.reduce<string[]>((acc, a, i) => {
      if (a === "--add-dir") acc.push(args[i + 1]!);
      return acc;
    }, []);
    expect(dirFlags.sort()).toEqual(["/repo/docs", "/repo/src"]);
  });

  it("appends a file list to the prompt using fileListHeader/fileListBullet when configured", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({
        args: ["-p", "{{prompt}}"],
        fileListHeader: "Focus on these files:",
        fileListBullet: "  - ",
        output: { mode: "text" },
      }),
    );
    await d.dispatch("do it", ["/repo/a.ts"], "/repo");
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("-p");
    expect(args[idx + 1]).toContain("Focus on these files:\n  - /repo/a.ts");
  });

  it("omits the file list entirely when fileListHeader isn't configured", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svc({ args: ["-p", "{{prompt}}"], output: { mode: "text" } }));
    await d.dispatch("do it", ["/repo/a.ts"], "/repo");
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("-p");
    expect(args[idx + 1]).toBe("do it");
  });

  it("injects the configured api key under apiKeyEnvVar", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc(
        { args: ["{{prompt}}"], apiKeyEnvVar: "MY_CLI_API_KEY", output: { mode: "text" } },
        { apiKey: "configured-key" },
      ),
    );
    await d.dispatch("go", [], "/tmp");
    const { opts } = captureSubprocessCall(0);
    expect(opts?.env?.["MY_CLI_API_KEY"]).toBe("configured-key");
  });

  it("clears an ambient apiKeyEnvVar when no api_key is configured, so it never leaks into the child", async () => {
    vi.stubEnv("MY_CLI_API_KEY", "leaked-ambient-key");
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svc({ args: ["{{prompt}}"], apiKeyEnvVar: "MY_CLI_API_KEY", output: { mode: "text" } }),
    );
    await d.dispatch("go", [], "/tmp");
    const { opts } = captureSubprocessCall(0);
    expect(opts?.env?.["MY_CLI_API_KEY"]).toBe("");
  });

  describe("output mode 'jsonl_stream' with eventRules — Codex-parity event semantics", () => {
    const codexLikeRules = [
      {
        when: { type: "item.completed", "item.type": "agent_message" },
        emit: "text" as const,
        textField: "item.text",
      },
      { when: { type: "message" }, emit: "text" as const, textField: "message.content" },
      {
        when: { "item.type": "tool_use" },
        emit: "tool_use" as const,
        nameField: "item.name",
        inputField: "item.input",
      },
      { when: { type: "thinking" }, emit: "thinking" as const, chunkField: "item.text" },
      {
        when: {},
        emit: "usage" as const,
        inputTokenFields: ["usage.input_tokens", "usage.prompt_tokens"],
        outputTokenFields: ["usage.output_tokens", "usage.completion_tokens"],
      },
    ];

    it("sets the final text from an item.completed/agent_message event", async () => {
      mockFound();
      const lines = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } })];
      runSubprocessMock.mockResolvedValue(ok({ stdout: lines.join("\n") + "\n" }));
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "jsonl_stream", eventRules: codexLikeRules } }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(true);
      expect(res.output).toBe("final answer");
    });

    it("emits tool_use and thinking events mid-stream, before the completion event", async () => {
      mockFound();
      const lines = [
        JSON.stringify({ type: "thinking", item: { text: "pondering..." } }),
        JSON.stringify({ item: { type: "tool_use", name: "Read", input: { path: "a.ts" } } }),
        JSON.stringify({ type: "message", message: { content: "done" } }),
      ];
      runSubprocessMock.mockResolvedValue(ok({ stdout: lines.join("\n") + "\n" }));
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "jsonl_stream", eventRules: codexLikeRules } }),
      );

      const events: Array<{ type: string }> = [];
      for await (const evt of d.stream("go", [], "/tmp")) events.push(evt);

      expect(events.some((e) => e.type === "thinking")).toBe(true);
      expect(events.some((e) => e.type === "tool_use")).toBe(true);
      const completion = events.find((e) => e.type === "completion") as { result: { output: string } } | undefined;
      expect(completion?.result.output).toBe("done");
    });

    it("aggregates usage tokens across lines using fallback field names", async () => {
      mockFound();
      const lines = [
        JSON.stringify({ type: "message", message: { content: "ok" }, usage: { input_tokens: 10, output_tokens: 5 } }),
        JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      ];
      runSubprocessMock.mockResolvedValue(ok({ stdout: lines.join("\n") + "\n" }));
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "jsonl_stream", eventRules: codexLikeRules } }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.tokensUsed).toEqual({ input: 13, output: 7 });
    });

    it("reports the parsed agent message as the error on a non-zero exit, not the raw event stream", async () => {
      // Field shape from 2026-08-03: nine real Codex runs emitted valid JSONL
      // and then exited non-zero with no turn.failed event. errorDetail fell
      // through to rawErrorFallback — which for jsonl_stream is stdout — so
      // the caller was shown ~300 chars of {"type":"thread.started",...} as
      // the error message after waiting 11-88s, while the actual message sat
      // parsed and unused.
      mockFound();
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: "019fc90f-4117-7e71-8d67-ecb7b6b1" }),
        JSON.stringify({ type: "message", message: { content: "I could not reach the sandbox." } }),
      ];
      runSubprocessMock.mockResolvedValue(
        ok({ stdout: lines.join("\n") + "\n", exitCode: 1 }),
      );
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "jsonl_stream", eventRules: codexLikeRules } }),
      );
      const res = await d.dispatch("go", [], "/tmp");

      expect(res.success).toBe(false);
      expect(res.error).toBe("I could not reach the sandbox.");
      expect(res.error).not.toContain("thread.started");
    });

    it("falls back to parsing stderr lines when nothing parsed from stdout", async () => {
      mockFound();
      const stderrLines = [JSON.stringify({ type: "message", message: { content: "from stderr" } })];
      runSubprocessMock.mockResolvedValue(
        ok({ stdout: "not json at all", stderr: stderrLines.join("\n") }),
      );
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], stdin: true, output: { mode: "jsonl_stream", eventRules: codexLikeRules } }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.output).toBe("from stderr");
    });
  });

  describe("structured error detection — quota/failure signals that survive exit code 0", () => {
    it("jsonl_stream: an emit:'error' rule forces failure even on exit 0, extracting the message field", async () => {
      mockFound();
      const lines = [
        JSON.stringify({ type: "error", message: "You've hit your usage limit. try again at Jul 28th, 2026." }),
      ];
      runSubprocessMock.mockResolvedValue(ok({ stdout: lines.join("\n") + "\n", exitCode: 0 }));
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          stdin: true,
          output: {
            mode: "jsonl_stream",
            eventRules: [{ when: { type: "error" }, emit: "error", messageField: "message" }],
          },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toBe("You've hit your usage limit. try again at Jul 28th, 2026.");
      expect(res.rateLimited).toBe(true);
    });

    it("jsonl_stream: a later emit:'error' rule (turn.failed) also matches, via a nested message path", async () => {
      mockFound();
      const lines = [JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } })];
      runSubprocessMock.mockResolvedValue(ok({ stdout: lines.join("\n") + "\n", exitCode: 0 }));
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          stdin: true,
          output: {
            mode: "jsonl_stream",
            eventRules: [{ when: { type: "turn.failed" }, emit: "error", messageField: "error.message" }],
          },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toBe("quota exceeded");
    });

    it("json_field: protocol.output.error's boolean field forces failure on exit 0 (Claude Code is_error pattern)", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(
        ok({ stdout: JSON.stringify({ result: "something went wrong upstream", is_error: true }), exitCode: 0 }),
      );
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          output: { mode: "json_field", fields: ["result"], error: { field: "is_error" } },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toBe("something went wrong upstream");
    });

    it("json_field: is_error: false leaves the lenient success path untouched", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(
        ok({ stdout: JSON.stringify({ result: "all good", is_error: false }), exitCode: 0 }),
      );
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          output: { mode: "json_field", fields: ["result"], error: { field: "is_error" } },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(true);
      expect(res.output).toBe("all good");
    });

    it("json_field: falls back to a generic message when the flagged error has no extractable text field", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ is_error: true }), exitCode: 0 }));
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          output: { mode: "json_field", fields: ["result"], error: { field: "is_error" } },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/is_error/);
    });

    it("json_field on a non-zero exit prefers stdout's real payload over stderr banner noise", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(
        ok({
          stdout: JSON.stringify({ error: "the real failure reason" }),
          stderr: "Reading additional input from stdin...",
          exitCode: 1,
        }),
      );
      const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "json_field", fields: ["result"] } }));
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toContain("the real failure reason");
      expect(res.error).not.toContain("Reading additional input");
    });

    it("text mode keeps preferring stderr over stdout on failure (unchanged behavior)", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(ok({ stdout: "some stray stdout", stderr: "the real error", exitCode: 1 }));
      const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toBe("the real error");
    });

    it("detectRateLimit recognizes OpenAI Codex's real 'usage limit' phrasing", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(
        ok({ stdout: "", stderr: "You've hit your usage limit. Upgrade to Pro.", exitCode: 1 }),
      );
      const d = new GenericCliDispatcher(svc({ args: ["{{prompt}}"], output: { mode: "text" } }));
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.rateLimited).toBe(true);
    });
  });

  describe("successRequiresOutput: false — lenient success (Claude Code/Codex/Antigravity pattern)", () => {
    it("succeeds on exit 0 even when the configured field can't be parsed, falling back to raw stdout", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(ok({ stdout: "not valid json at all" }));
      const d = new GenericCliDispatcher(
        svc({
          args: ["{{prompt}}"],
          output: { mode: "json_field", fields: ["result"] },
          successRequiresOutput: false,
        }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(true);
      expect(res.output).toBe("not valid json at all");
    });

    it("still fails on a non-zero exit code", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "boom", exitCode: 1 }));
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], output: { mode: "text" }, successRequiresOutput: false }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
      expect(res.error).toBe("boom");
    });

    it("defaults to strict mode (requires non-empty parsed output) when unset", async () => {
      mockFound();
      runSubprocessMock.mockResolvedValue(ok({ stdout: "not valid json at all" }));
      const d = new GenericCliDispatcher(
        svc({ args: ["{{prompt}}"], output: { mode: "json_field", fields: ["result"] } }),
      );
      const res = await d.dispatch("go", [], "/tmp");
      expect(res.success).toBe(false);
    });
  });
});

describe("detectRateLimit — 429 needs HTTP context", () => {
  // One flag trips the breaker with NO threshold and blocks the route for
  // 300s, so the false-positive space here is a route-availability bug, not a
  // cosmetic one. A failed run whose 10 MB transcript merely mentioned the
  // number — a port, a line number, a test count — used to read as a rate
  // limit.
  it.each([
    "listening on port 4290 then crashed",
    "assertion failed at src/app.ts:429:17",
    "429 tests passed, 1 failed",
    "processed 429 files before the crash",
  ])("does not flag innocent output: %s", (text) => {
    expect(detectRateLimit(text).rateLimited).toBe(false);
  });

  it.each([
    "HTTP 429 returned by upstream",
    "status: 429",
    "status_code=429",
    'request failed with {"code": 429}',
    "Error 429 from api.example.com",
    "429 Too Many Requests",
  ])("flags a real status signal: %s", (text) => {
    expect(detectRateLimit(text).rateLimited).toBe(true);
  });

  it("still extracts retry-after next to a contextual 429", () => {
    const r = detectRateLimit("HTTP 429: slow down. retry-after: 42");
    expect(r).toEqual({ rateLimited: true, retryAfter: 42 });
  });
});
