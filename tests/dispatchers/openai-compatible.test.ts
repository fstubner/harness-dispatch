import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ServiceConfig } from "../../src/types.js";

const { OpenAICompatibleDispatcher } = await import(
  "../../src/dispatchers/openai-compatible.js"
);

type FetchMock = ReturnType<typeof vi.fn>;

const realFetch = globalThis.fetch;
let fetchMock: FetchMock;

function baseSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "test-provider",
    enabled: true,
    type: "openai_compatible",
    tier: 1,
    weight: 1,
    cliCapability: 0,
    escalateOn: [],
    capabilities: {},
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-abc",
    model: "test-model",
    ...overrides,
  };
}

function mockJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers({
    "content-type": "application/json",
    ...(init.headers ?? {}),
  });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function chatCompletion(content: string): Record<string, unknown> {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OpenAICompatibleDispatcher", () => {
  it("POSTs to <baseUrl>/v1/chat/completions with Bearer auth and expected body", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("hello there")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("say hi", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("hello there");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer sk-test-abc");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const parsedBody = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(parsedBody.model).toBe("test-model");
    expect(parsedBody.stream).toBe(false);
    expect(parsedBody.messages[0]?.role).toBe("system");
    expect(parsedBody.messages[1]?.role).toBe("user");
    expect(parsedBody.messages[1]?.content).toContain("say hi");
  });

  it("strips trailing slashes from baseUrl", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(
      baseSvc({ baseUrl: "https://api.example.com/v1///" }),
    );
    await d.dispatch("go", [], "");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("populates usage.prompt/completion tokens into tokensUsed", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.tokensUsed).toEqual({ input: 11, output: 13 });
  });

  it("uses modelOverride when provided", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    await d.dispatch("go", [], "", { modelOverride: "override-model" });

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { body: string },
    ];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("override-model");
  });

  it("returns rateLimited:true with retryAfter from Retry-After header on 429", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { error: { message: "Too many requests" } },
        {
          status: 429,
          headers: {
            "retry-after": "42",
            "x-ratelimit-remaining": "0",
          },
        },
      ),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(42);
    expect(res.rateLimitHeaders?.["retry-after"]).toBe("42");
    expect(res.rateLimitHeaders?.["x-ratelimit-remaining"]).toBe("0");
  });

  it("does not set retryAfter when Retry-After header is absent on 429", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { error: { message: "Slow down" } },
        { status: 429 },
      ),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBeUndefined();
  });

  it("returns a formatted error message on HTTP 400+", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { error: { message: "invalid model" } },
        { status: 400 },
      ),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBeUndefined();
    expect(res.error).toBe("HTTP 400: invalid model");
  });

  it("includes reasoning_effort in body when thinkingLevel is set", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(
      baseSvc({ thinkingLevel: "high" }),
    );
    await d.dispatch("go", [], "");

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { body: string },
    ];
    const body = JSON.parse(init.body) as { reasoning_effort?: string };
    expect(body.reasoning_effort).toBe("high");
  });

  it("omits Authorization header when apiKey is empty (local endpoints)", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(
      baseSvc({
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
      }),
    );
    await d.dispatch("go", [], "");

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("reports network errors with the underlying message", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("uses svc.name as the dispatcher id", () => {
    const d = new OpenAICompatibleDispatcher(
      baseSvc({ name: "openrouter" }),
    );
    expect(d.id).toBe("openrouter");
    expect(d.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wire_protocol: anthropic_messages
// ---------------------------------------------------------------------------

function anthropicMessage(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 21, output_tokens: 34 },
    ...overrides,
  };
}

function anthropicSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return baseSvc({
    baseUrl: "https://api.anthropic.com/v1",
    wireProtocol: "anthropic_messages",
    model: "claude-opus-4-6",
    ...overrides,
  });
}

/** A streaming Response whose body yields the given raw SSE text in one chunk. */
function sseResponse(rawText: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(rawText));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: new Headers({ "content-type": "text/event-stream", ...(init.headers ?? {}) }),
  });
}

/** Drain a dispatcher's stream() down to just its completion result. */
async function drainStream(
  iter: AsyncIterable<{ type: string; result?: unknown }>,
): Promise<{ success: boolean; output: string; tokensUsed?: { input: number; output: number }; error?: string }> {
  let completion:
    | { success: boolean; output: string; tokensUsed?: { input: number; output: number }; error?: string }
    | undefined;
  for await (const evt of iter) {
    if (evt.type === "completion") {
      completion = evt.result as typeof completion;
    }
  }
  if (!completion) throw new Error("stream ended without a completion event");
  return completion;
}

describe("OpenAICompatibleDispatcher — wire_protocol: anthropic_messages", () => {
  it("POSTs to <baseUrl>/messages with x-api-key + anthropic-version auth, not Bearer", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(anthropicMessage("hello there")));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await d.dispatch("say hi", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("hello there");

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-test-abc");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("puts the system prompt at the top level and requires max_tokens, unlike OpenAI's shape", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(anthropicMessage("ok")));

    const d = new OpenAICompatibleDispatcher(anthropicSvc({ maxOutputTokens: 2048 }));
    await d.dispatch("do the thing", [], "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.max_tokens).toBe(2048);
    expect(typeof body.system).toBe("string");
    expect(body.system.length).toBeGreaterThan(0);
    // No system-role message mixed into messages[] (unlike OpenAI).
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.messages[0]?.content).toContain("do the thing");
  });

  it("defaults max_tokens when the route declares no max_output_tokens", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(anthropicMessage("ok")));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    await d.dispatch("go", [], "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(8192);
  });

  it("joins multiple text content blocks into one output string", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        anthropicMessage("", {
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        }),
      ),
    );

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("part one part two");
  });

  it("maps usage.input_tokens/output_tokens into tokensUsed", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(anthropicMessage("ok", { usage: { input_tokens: 100, output_tokens: 50 } })),
    );

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.tokensUsed).toEqual({ input: 100, output: 50 });
  });

  it("extracts error.message from Anthropic's {type,error:{message}} error shape", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { type: "error", error: { type: "invalid_request_error", message: "model not found" } },
        { status: 404 },
      ),
    );

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toContain("model not found");
  });

  it("marks rateLimited=true on a 429 the same way as the OpenAI path", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { status: 429, headers: { "retry-after": "12" } },
      ),
    );

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(12);
  });

  it("streams content_block_delta text and aggregates usage from message_start/message_delta", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world!"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    fetchMock.mockResolvedValue(sseResponse(frames));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const stdoutChunks = events.filter((e) => e.type === "stdout") as Array<{ chunk: string }>;
    expect(stdoutChunks.map((e) => e.chunk).join("")).toBe("Hello, world!");

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean; output: string; tokensUsed?: { input: number; output: number } } }
      | undefined;
    expect(completion?.result.success).toBe(true);
    expect(completion?.result.output).toBe("Hello, world!");
    expect(completion?.result.tokensUsed).toEqual({ input: 40, output: 9 });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["Accept"]).toBe("text/event-stream");
  });

  it("treats a mid-stream error event as a failed completion, not silent success", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ].join("");
    fetchMock.mockResolvedValue(sseResponse(frames));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean; output: string; error?: string } }
      | undefined;
    expect(completion?.result.success).toBe(false);
    expect(completion?.result.error).toBe("Overloaded");
  });

  it("processes every data: line in a frame, not just the last (defends against merged/CRLF frames)", async () => {
    // Simulates what a CRLF-framed stream degrades to: multiple real SSE
    // events landing in what the boundary-splitter treats as one frame.
    const mergedFrame =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"42"}}\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
    fetchMock.mockResolvedValue(sseResponse(mergedFrame));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await drainStream(d.stream("go", [], ""));

    expect(res.success).toBe(true);
    expect(res.output).toBe("42");
    expect(res.tokensUsed).toEqual({ input: 5, output: 1 });
  });

  it("splits CRLF-framed (\\r\\n\\r\\n) SSE streams correctly, not just LF-framed ones", async () => {
    const frames = [
      'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\r\n\r\n',
      'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\r\n\r\n',
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
    ].join("");
    fetchMock.mockResolvedValue(sseResponse(frames));

    const d = new OpenAICompatibleDispatcher(anthropicSvc());
    const res = await drainStream(d.stream("go", [], ""));

    expect(res.success).toBe(true);
    expect(res.output).toBe("Hello world");
    expect(res.tokensUsed).toEqual({ input: 7, output: 2 });
  });

  it("normalizes /messages onto a baseUrl that doesn't already end in /v1", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(anthropicMessage("ok")));

    const d = new OpenAICompatibleDispatcher(anthropicSvc({ baseUrl: "https://gateway.example.com" }));
    await d.dispatch("go", [], "");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://gateway.example.com/v1/messages");
  });
});

describe("OpenAICompatibleDispatcher — mid-stream error handling (openai_chat_completions)", () => {
  it("treats a mid-stream {error} object as a failed completion, not silent success", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"The server had an error processing your request","type":"server_error"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    fetchMock.mockResolvedValue(sseResponse(frames));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean; output: string; error?: string } }
      | undefined;
    expect(completion?.result.success).toBe(false);
    expect(completion?.result.error).toContain("server had an error");
  });

  it("treats a 200 that streams no content as a failure, matching the buffered path", async () => {
    // The two paths disagreed on the same response. Buffered refused it
    // ("Unexpected response shape"); streaming called it a successful empty
    // answer — and jobs.ts only ever streams, so the MCP surface was the one
    // that got it wrong. Worse, a success HEALS the breaker, so a route
    // serving nothing but empty 200s never tripped.
    fetchMock.mockResolvedValue(sseResponse("data: [DONE]\n\n"));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean; output: string; error?: string } }
      | undefined;
    expect(completion?.result.success).toBe(false);
    expect(completion?.result.error).toContain("200 with no content");
    expect(completion?.result.output).toBe("");
  });

  it("a totally empty 200 body streams as a failure too", async () => {
    fetchMock.mockResolvedValue(sseResponse(""));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean } }
      | undefined;
    expect(completion?.result.success).toBe(false);
  });

  it("still reports success for a stream that carries real content", async () => {
    // The guard above must not fire on the normal path — an empty-output
    // check that also failed real answers would be a much worse bug than the
    // one it replaces.
    fetchMock.mockResolvedValue(
      sseResponse('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const completion = events.find((e) => e.type === "completion") as
      | { result: { success: boolean; output: string } }
      | undefined;
    expect(completion?.result.success).toBe(true);
    expect(completion?.result.output).toBe("hello");
  });

  it("includes stream_options.include_usage in streaming requests so servers return token usage", async () => {
    fetchMock.mockResolvedValue(sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string }> = [];
    for await (const evt of d.stream("go", [], "")) events.push(evt);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { stream_options?: { include_usage: boolean } };
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});
