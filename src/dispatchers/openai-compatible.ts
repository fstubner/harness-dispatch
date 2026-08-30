/**
 * HTTP endpoint dispatcher for harness-dispatch — handles both wire protocols
 * a `type: openai_compatible` route can speak, selected by `wire_protocol:`
 * in config (default `openai_chat_completions`):
 *
 *   openai_chat_completions  POST /chat/completions — Ollama, LM Studio,
 *                            OpenRouter, OpenAI API, NVIDIA NIM, and any
 *                            other OpenAI-compatible endpoint.
 *   anthropic_messages       POST /messages — Anthropic's API directly, or
 *                            any third-party host that mirrors its Messages
 *                            API shape (different auth headers, request/
 *                            response body, and SSE event framing from
 *                            OpenAI's — see the wire-protocol-specific
 *                            helpers below).
 *
 * Transport: global `fetch` (Node 24+). No subprocess, no extra deps.
 * Quota:     reactive — parses x-ratelimit- and anthropic-ratelimit- headers
 *            on every response. Local endpoints (Ollama, LM Studio) have no
 *            rate limits.
 *
 * R3: `dispatch()` retains the buffered POST for simplicity + compatibility
 * with tests that mock `fetch`. `stream()` switches to SSE streaming by
 * setting `stream: true` in the request body and parsing wire-protocol-
 * specific SSE frames as they arrive. The `completion` event is built from
 * the summed delta content across all events.
 */

import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig, WireProtocol } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { parseRetryAfter } from "./shared/rate-limit-headers.js";
import { redactEndpointHost } from "../status.js";

const CHAT_PATH = "/chat/completions";
const MESSAGES_PATH = "/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 120_000;
/** SSE frames are separated by a blank line — spec-legal as \n\n or \r\n\r\n. */
const SSE_FRAME_BOUNDARY = /\r?\n\r?\n/;
/**
 * How much of an unusable response body to quote back. Enough to recognise an
 * HTML error page or a JSON error envelope; short enough that a multi-megabyte
 * body does not become the error message.
 */
const RAW_HEAD_CHARS = 300;

/**
 * Append `path` onto `baseUrl`, inserting `/v1` unless it's already there.
 * Exported so callers other than this dispatcher (e.g. the `usage` tool's
 * listModels, which hits GET {baseUrl}/models on the same endpoint) build
 * URLs the same way — a baseUrl configured without a /v1 suffix must not
 * 404 on one code path while working on the other.
 */
export function endpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}${path}` : `${trimmed}/v1${path}`;
}
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert software engineer. " +
  "Respond with clear, working code and concise explanations.";
const _MAX_FILE_BYTES = 512 * 1024; // 512 KB per file
/**
 * Cap across ALL files in one prompt (2 MB).
 *
 * The per-file limit alone bounded nothing useful: 64 files just under 512 KB
 * each is a 32 MB prompt posted to a metered endpoint. This is the total that
 * actually reaches the wire.
 */
const _MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// openai_chat_completions response shapes
// ---------------------------------------------------------------------------

interface ChatChoice {
  message?: {
    content?: unknown;
    role?: unknown;
  };
  delta?: {
    content?: unknown;
    role?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: unknown;
    type?: unknown;
  };
}

// ---------------------------------------------------------------------------
// anthropic_messages response shapes
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicMessageResponse {
  type?: unknown; // "message" | "error"
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
  error?: {
    type?: unknown;
    message?: unknown;
  };
}

/** One `event: <name>` + `data: {...}` SSE frame in Anthropic's streaming shape. */
interface AnthropicStreamEvent {
  type?: unknown; // "message_start" | "content_block_delta" | "message_delta" | "message_stop" | "error" | ...
  message?: { usage?: AnthropicUsage };
  delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
  usage?: AnthropicUsage;
  error?: { message?: unknown };
}

type ParsedResponse = ChatCompletionResponse | AnthropicMessageResponse;

/**
 * Turn a fetch failure into something a reader can act on.
 *
 * Node's undici says exactly "fetch failed" for DNS failures, refused
 * connections and TLS errors alike — no host, no port, no cause. For a router
 * whose whole job is choosing between endpoints, "which endpoint, and what
 * went wrong" is the entire content of the message. The host is redacted the
 * same way the rest of the output redacts it, so this stays safe to paste into
 * a bug report.
 */
function describeFetchFailure(err: unknown, baseUrl: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code;
  const hint =
    code === "ENOTFOUND"
      ? "host does not resolve"
      : code === "ECONNREFUSED"
        ? "connection refused — is the server running on that port?"
        : code === "ETIMEDOUT"
          ? "connection timed out"
          : code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
            ? "TLS certificate rejected"
            : (cause?.message ?? undefined);
  const where = redactEndpointHost(baseUrl);
  return hint ? `${message} (${where}: ${hint})` : `${message} (${where})`;
}

export class OpenAICompatibleDispatcher extends BaseDispatcher {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly thinkingLevel?: string | undefined;
  private readonly wireProtocol: WireProtocol;
  private readonly maxTokens: number;

  constructor(svc: ServiceConfig) {
    super();
    this.id = svc.name;
    const base = svc.baseUrl ?? "";
    this.baseUrl = base.replace(/\/+$/, "");
    this.model = svc.model ?? "";
    this.apiKey = svc.apiKey ?? "";
    if (svc.thinkingLevel) this.thinkingLevel = svc.thinkingLevel;
    this.wireProtocol = svc.wireProtocol ?? "openai_chat_completions";
    this.maxTokens = svc.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  }

  isAvailable(): boolean {
    return this.baseUrl.length > 0 && this.model.length > 0;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }

  // ---------------------------------------------------------------------
  // Wire-protocol-specific request building
  // ---------------------------------------------------------------------

  #url(): string {
    const path = this.wireProtocol === "anthropic_messages" ? MESSAGES_PATH : CHAT_PATH;
    return endpointUrl(this.baseUrl, path);
  }

  #headers(accept: "application/json" | "text/event-stream"): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept,
    };
    if (!this.apiKey) return headers;
    if (this.wireProtocol === "anthropic_messages") {
      headers["x-api-key"] = this.apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    } else {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  #body(model: string, fullPrompt: string, stream: boolean): Record<string, unknown> {
    if (this.wireProtocol === "anthropic_messages") {
      // Anthropic requires max_tokens and puts the system prompt at the
      // top level, not as a messages[] entry. thinking_level isn't
      // translated to Anthropic's extended-thinking `thinking:` param yet
      // (different shape: {type, budget_tokens} with its own max_tokens
      // interplay) — omitted rather than sent wrong.
      return {
        model,
        max_tokens: this.maxTokens,
        system: DEFAULT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: fullPrompt }],
        stream,
      };
    }
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: fullPrompt },
      ],
      stream,
    };
    if (this.thinkingLevel) body["reasoning_effort"] = this.thinkingLevel.toLowerCase();
    // Without this, most OpenAI-compatible servers omit the usage frame
    // during streaming — tokensUsed would silently be missing for every
    // `job` and progress-token `code` call (both always use stream()),
    // while the buffered dispatch() path got it for free.
    if (stream) body["stream_options"] = { include_usage: true };
    return body;
  }

  // ---------------------------------------------------------------------
  // Wire-protocol-specific response parsing
  // ---------------------------------------------------------------------

  #extractContent(body: ParsedResponse): string | null {
    if (this.wireProtocol === "anthropic_messages") {
      const blocks = (body as AnthropicMessageResponse).content;
      if (!Array.isArray(blocks)) return null;
      const text = blocks
        .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      return text.length > 0 ? text : null;
    }
    const choices = (body as ChatCompletionResponse).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (!first || typeof first !== "object") return null;
    const msg = first.message;
    if (!msg || typeof msg !== "object") return null;
    const content = (msg as { content?: unknown }).content;
    // An empty string is not an answer. The anthropic_messages branch above has
    // always said so (`text.length > 0 ? text : null`); this one returned any
    // string, so a well-formed 200 carrying `content: ""` was a SUCCESS with no
    // output — the same silent-empty-success this dispatcher was just fixed for
    // on the streaming side, still live here. An acceptance pass caught the
    // fix's own claim ("the streaming path now refuses this the same way the
    // buffered path does") asserting a guard that did not exist.
    return typeof content === "string" && content.length > 0 ? content : null;
  }

  #extractUsage(body: ParsedResponse): { input: number; output: number } | undefined {
    if (this.wireProtocol === "anthropic_messages") {
      const usage = (body as AnthropicMessageResponse).usage;
      if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
        return { input: usage.input_tokens, output: usage.output_tokens };
      }
      return undefined;
    }
    const usage = (body as ChatCompletionResponse).usage;
    if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
      return { input: usage.prompt_tokens, output: usage.completion_tokens };
    }
    return undefined;
  }

  #extractErrorMessage(body: ParsedResponse | null, rawBody: string): string {
    if (this.wireProtocol === "anthropic_messages") {
      const message = (body as AnthropicMessageResponse | null)?.error?.message;
      if (typeof message === "string") return message;
    } else {
      const message = (body as ChatCompletionResponse | null)?.error?.message;
      if (typeof message === "string") return message;
    }
    return rawBody.slice(0, 200) || "(empty body)";
  }

  #parseBody(rawBody: string): ParsedResponse | null {
    if (!rawBody) return null;
    try {
      return JSON.parse(rawBody) as ParsedResponse;
    } catch {
      return null;
    }
  }

  /**
   * Parse one SSE frame (`event:`/`data:` lines separated by a blank line)
   * into DispatcherEvents. Anthropic frames carry a named `event:` line;
   * OpenAI frames don't (only `data:`, with a `[DONE]` sentinel) — both use
   * the same blank-line frame boundary, so the caller's chunking is shared.
   */
  /**
   * `usage` is PARTIAL per frame on purpose — Anthropic splits input_tokens
   * (message_start) and output_tokens (message_delta) across two different
   * frames, unlike OpenAI which sends both together in its one usage-
   * bearing frame. The caller merges partial updates across the whole
   * stream rather than overwriting on each frame.
   *
   * `error`, when set, means the upstream sent a mid-stream error event
   * AFTER already returning 200 and streaming some content — a case the
   * HTTP-status checks earlier in #runStream never see. The caller must
   * treat this as a failed completion (using whatever partial output
   * accumulated so far), not silently report success.
   */
  #parseSseFrame(frame: string): {
    events: DispatcherEvent[];
    usage: { input?: number; output?: number } | null;
    error?: string;
  } {
    return this.wireProtocol === "anthropic_messages"
      ? this.#parseAnthropicSseFrame(frame)
      : this.#parseOpenAiSseFrame(frame);
  }

  #parseOpenAiSseFrame(frame: string): {
    events: DispatcherEvent[];
    usage: { input?: number; output?: number } | null;
    error?: string;
  } {
    const out: DispatcherEvent[] = [];
    let usage: { input: number; output: number } | null = null;
    let error: string | undefined;
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;
      let obj: ChatCompletionResponse;
      try {
        obj = JSON.parse(payload) as ChatCompletionResponse;
      } catch {
        continue;
      }
      if (obj.error) {
        error = typeof obj.error.message === "string" ? obj.error.message : "upstream error mid-stream";
        continue;
      }
      const choices = obj.choices;
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const delta = c.delta ?? c.message;
          const content = delta?.content;
          if (typeof content === "string" && content.length > 0) {
            // text: this IS the answer — an endpoint streams assistant content, not
            // a protocol, so it can be shown as it arrives.
            out.push({ type: "stdout", chunk: content, text: true });
          }
        }
      }
      if (obj.usage) {
        const input = obj.usage.prompt_tokens;
        const output = obj.usage.completion_tokens;
        if (typeof input === "number" && typeof output === "number") {
          usage = { input, output };
        }
      }
    }
    return error !== undefined ? { events: out, usage, error } : { events: out, usage };
  }

  /**
   * Anthropic streams message_start (initial input_tokens),
   * content_block_delta (text_delta chunks), message_delta (final
   * output_tokens), and (on failure) a named error event — accumulate
   * across every `data:` line in the frame rather than keeping only the
   * last one. That matters beyond just "a frame with two events": if frame
   * boundaries ever get miscounted upstream (e.g. a proxy that coalesces
   * writes), multiple real SSE events can land in what we treat as one
   * frame — dropping all but the last would silently lose content or usage.
   */
  #parseAnthropicSseFrame(frame: string): {
    events: DispatcherEvent[];
    usage: { input?: number; output?: number } | null;
    error?: string;
  } {
    const out: DispatcherEvent[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let error: string | undefined;
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    for (const dataLine of dataLines) {
      let obj: AnthropicStreamEvent;
      try {
        obj = JSON.parse(dataLine) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      if (obj.type === "message_start") {
        const v = obj.message?.usage?.input_tokens;
        if (typeof v === "number") inputTokens = v;
      } else if (obj.type === "content_block_delta") {
        const text = obj.delta?.type === "text_delta" ? obj.delta.text : undefined;
        if (typeof text === "string" && text.length > 0) {
          out.push({ type: "stdout", chunk: text, text: true });
        }
      } else if (obj.type === "message_delta") {
        const v = obj.usage?.output_tokens;
        if (typeof v === "number") outputTokens = v;
      } else if (obj.type === "error") {
        error = typeof obj.error?.message === "string" ? obj.error.message : "upstream error mid-stream";
      }
    }
    const usage: { input?: number; output?: number } | null =
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            ...(inputTokens !== undefined ? { input: inputTokens } : {}),
            ...(outputTokens !== undefined ? { output: outputTokens } : {}),
          }
        : null;
    return error !== undefined ? { events: out, usage, error } : { events: out, usage };
  }

  // ---------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------

  /**
   * Buffered one-shot: POST with stream=false, parse a single JSON body.
   * Kept as a fast-path (no incremental parsing overhead) and to preserve
   * existing mocked-fetch tests.
   */
  override async dispatch(
    prompt: string,
    files: string[],
    _workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const start = Date.now();
    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = this.#url();
    const model = opts.modelOverride ?? this.model;
    const body = this.#body(model, fullPrompt, false);
    const headers = this.#headers("application/json");

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    // A cancellation aborts the in-flight request the same way the timeout
    // does, so a cancelled endpoint call stops paying for tokens it will
    // never read.
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      return {
        output: "",
        service: this.id,
        success: false,
        error: aborted
            ? `Timed out after ${timeoutMs}ms`
            : describeFetchFailure(err, this.baseUrl ?? ""),
        durationMs: Date.now() - start,
      };
    }
    clearTimeout(timer);

    const responseHeaders = headersToObject(res.headers);
    const durationMs = Date.now() - start;

    let rawBody = "";
    try {
      rawBody = await res.text();
    } catch {
      // Body read failed — treat as empty.
    }
    const parsedBody = this.#parseBody(rawBody);

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(responseHeaders);
      const result: DispatchResult = {
        output: "",
        service: this.id,
        success: false,
        error: `Rate limited by ${this.id}`,
        rateLimited: true,
        rateLimitHeaders: responseHeaders,
        durationMs,
      };
      if (retryAfter !== null) result.retryAfter = retryAfter;
      return result;
    }

    if (res.status >= 400) {
      const errMessage = this.#extractErrorMessage(parsedBody, rawBody);
      return {
        output: "",
        service: this.id,
        success: false,
        error: `HTTP ${res.status}: ${errMessage}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const content = parsedBody ? this.#extractContent(parsedBody) : null;
    if (content === null) {
      return {
        output: "",
        service: this.id,
        success: false,
        // Same one question the streaming path asks, and the same two answers.
        // This path used to emit a dangling "Unexpected response shape: " with
        // nothing after the colon for an empty body — technically true and
        // useless, and the worse half of an agreement the streaming comment
        // claimed the two paths already had.
        error:
          rawBody.length === 0
            ? "Empty response: the endpoint returned 200 with no body"
            : `Unexpected response shape: ${rawBody.slice(0, RAW_HEAD_CHARS)}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const result: DispatchResult = {
      output: content,
      service: this.id,
      success: true,
      durationMs,
      rateLimitHeaders: responseHeaders,
    };

    if (parsedBody) {
      const tokensUsed = this.#extractUsage(parsedBody);
      if (tokensUsed) result.tokensUsed = tokensUsed;
    }

    return result;
  }

  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<DispatcherEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    _workingDir: string,
    opts: DispatchOpts,
  ): AsyncGenerator<DispatcherEvent> {
    const start = Date.now();
    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = this.#url();
    const model = opts.modelOverride ?? this.model;
    const body = this.#body(model, fullPrompt, true);
    const headers = this.#headers("text/event-stream");

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    // A cancellation aborts the in-flight request the same way the timeout
    // does, so a cancelled endpoint call stops paying for tokens it will
    // never read.
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: aborted
            ? `Timed out after ${timeoutMs}ms`
            : describeFetchFailure(err, this.baseUrl ?? ""),
          durationMs: Date.now() - start,
        },
      };
      return;
    }

    const responseHeaders = headersToObject(res.headers);

    if (res.status === 429) {
      clearTimeout(timer);
      const retryAfter = parseRetryAfter(responseHeaders);
      const result: DispatchResult = {
        output: "",
        service: this.id,
        success: false,
        error: `Rate limited by ${this.id}`,
        rateLimited: true,
        rateLimitHeaders: responseHeaders,
        durationMs: Date.now() - start,
      };
      if (retryAfter !== null) result.retryAfter = retryAfter;
      yield { type: "completion", result };
      return;
    }

    if (res.status >= 400) {
      clearTimeout(timer);
      const rawBody = await res.text().catch(() => "");
      const parsedBody = this.#parseBody(rawBody);
      const errMessage = this.#extractErrorMessage(parsedBody, rawBody);
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: `HTTP ${res.status}: ${errMessage}`,
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }

    // Stream body — SSE frames are separated by a blank line, which the
    // spec allows as \n\n OR \r\n\r\n. A literal indexOf("\n\n") never
    // matches CRLF-framed streams, so the whole body silently piles up in
    // the trailing flush as one "frame" — use a regex boundary instead.
    const chunks: string[] = [];
    let buffer = "";
    // The head of the body exactly as it arrived, kept because `buffer` is
    // consumed frame by frame and is empty by the time a failure is reported.
    // Without it the failure message could only say what was NOT found.
    //
    // Truncated to RAW_HEAD_CHARS, not "stopped once past it": the previous
    // version appended whole chunks while under the limit, so one chunk could
    // carry it to any length. That was invisible until it mattered — the same
    // 2 KB body classified two different ways depending on how the network
    // split it, decided by bytes the message never showed.
    let rawSeen = "";
    // Merged across frames, not overwritten — Anthropic's input/output
    // token counts arrive on two DIFFERENT frames (see #parseSseFrame).
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let streamError: string | undefined;
    const mergeUsage = (u: { input?: number; output?: number } | null): void => {
      if (!u) return;
      if (u.input !== undefined) inputTokens = u.input;
      if (u.output !== undefined) outputTokens = u.output;
    };

    if (!res.body) {
      clearTimeout(timer);
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: "No response body",
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        if (rawSeen.length < RAW_HEAD_CHARS) rawSeen = (rawSeen + text).slice(0, RAW_HEAD_CHARS);

        let boundary = SSE_FRAME_BOUNDARY.exec(buffer);
        while (boundary !== null) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const evts = this.#parseSseFrame(frame);
          for (const e of evts.events) {
            yield e;
            if (e.type === "stdout") chunks.push(e.chunk);
          }
          mergeUsage(evts.usage);
          if (evts.error !== undefined) {
            streamError = evts.error;
            break outer; // Upstream sent a mid-stream error — stop reading.
          }
          boundary = SSE_FRAME_BOUNDARY.exec(buffer);
        }
      }
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      yield {
        type: "completion",
        result: {
          output: chunks.join(""),
          service: this.id,
          success: false,
          error: errMsg,
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }
    clearTimeout(timer);

    // A mid-stream error broke out of the read loop with the response body
    // still open — cancel it so the connection is released now instead of
    // whenever the server or GC gets around to it.
    if (streamError !== undefined) {
      try {
        await reader.cancel();
      } catch {
        // Releasing a broken stream is best-effort.
      }
    }

    // Flush trailing frame if any (skipped if a mid-stream error already
    // ended the read loop early — nothing meaningful left to parse).
    if (streamError === undefined && buffer.trim()) {
      const evts = this.#parseSseFrame(buffer);
      for (const e of evts.events) {
        yield e;
        if (e.type === "stdout") chunks.push(e.chunk);
      }
      mergeUsage(evts.usage);
      if (evts.error !== undefined) streamError = evts.error;
    }

    const output = chunks.join("");
    // A 200 that yields no answer is not a successful empty answer. jobs.ts
    // only ever streams, so the MCP surface (the primary one, and the one an
    // orchestrating agent branches on) reported `success: true` with an empty
    // output. The breaker heals on a success, so a route serving nothing but
    // empty 200s was recorded as healthy forever and never tripped.
    //
    // The message asks one question — did ANYTHING come back? — and does not
    // try to work out why what came back was unusable.
    //
    // Two previous versions did try, and both were wrong in ways nobody
    // noticed until an acceptance pass went looking. The first reported "no
    // content" for anything that yielded no text, so an HTML error page, plain
    // prose and a gateway that ignored `stream: true` were all described as
    // empty. The second tested whether the body looked like SSE, and got three
    // more cases backwards: a stream in a dialect this parser does not read
    // (Anthropic's, on a route configured as OpenAI's) has its real answer
    // discarded and called empty; SSE comment keepalives — `: OPENROUTER
    // PROCESSING`, sent by a real provider — are well-formed SSE carrying
    // nothing and were called an unexpected shape; and an HTML page containing
    // any `data:` line was called empty.
    //
    // Each fix was right about the case in front of it and wrong one case
    // over, which is the signal that the classification itself does not belong
    // here. This dispatcher knows one thing for certain: whether bytes
    // arrived. Everything else is the reader's to judge, and showing them the
    // body is what lets them. A well-formed empty stream now reports its own
    // `data: [DONE]` rather than a friendlier sentence about it — less
    // polished, and it cannot be wrong.
    const emptyAnswer = streamError === undefined && output.length === 0;
    const emptyAnswerError =
      rawSeen.length === 0
        ? "Empty response: the endpoint returned 200 with no body"
        : `Unexpected response shape: ${rawSeen}`;
    const result: DispatchResult =
      streamError !== undefined || emptyAnswer
        ? {
            output,
            service: this.id,
            success: false,
            error: streamError ?? emptyAnswerError,
            durationMs: Date.now() - start,
            rateLimitHeaders: responseHeaders,
          }
        : {
            output,
            service: this.id,
            success: true,
            durationMs: Date.now() - start,
            rateLimitHeaders: responseHeaders,
          };
    if (inputTokens !== undefined && outputTokens !== undefined) {
      result.tokensUsed = { input: inputTokens, output: outputTokens };
    }
    yield { type: "completion", result };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function buildPromptWithFiles(
  prompt: string,
  files: string[],
): Promise<string> {
  if (files.length === 0) return prompt;
  const parts: string[] = [prompt];
  const { stat, readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  let totalBytes = 0;
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        parts.push(`\n# Not a file: ${filePath}`);
        continue;
      }
      if (info.size > _MAX_FILE_BYTES) {
        parts.push(
          `\n# Skipped ${filePath}: file too large (${Math.floor(
            info.size / 1024,
          )} KB > ${_MAX_FILE_BYTES / 1024} KB limit)`,
        );
        continue;
      }
      if (totalBytes + info.size > _MAX_TOTAL_FILE_BYTES) {
        // The per-file limit alone bounds nothing useful — this is the check
        // that keeps 64 × ~500 KB from becoming a 32 MB post to a metered
        // endpoint. Announced per skipped file so the delegate knows exactly
        // which context it is missing.
        parts.push(
          `\n# Skipped ${filePath}: total file budget exhausted ` +
            `(${_MAX_TOTAL_FILE_BYTES / 1024} KB across all files)`,
        );
        continue;
      }
      totalBytes += info.size;
      const content = await readFile(filePath, "utf8");
      const ext = extname(filePath).replace(/^\./, "");
      parts.push(`\n\n\`\`\`${ext}\n# ${filePath}\n${content}\n\`\`\``);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        parts.push(`\n# File not found: ${filePath}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        parts.push(`\n# Could not read ${filePath}: ${msg}`);
      }
    }
  }
  return parts.join("\n");
}
