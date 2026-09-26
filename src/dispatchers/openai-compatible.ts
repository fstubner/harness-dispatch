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
 *                            API shape (different auth headers, body and SSE
 *                            framing from OpenAI's — see the wire-protocol
 *                            helpers below).
 *
 * Transport: global `fetch` (Node 24+). No subprocess, no extra deps.
 * Quota:     reactive — parses x-ratelimit- and anthropic-ratelimit- headers
 *            on every response. Local endpoints have no rate limits.
 *
 * `dispatch()` is a buffered POST; `stream()` sets `stream: true` and parses
 * wire-protocol-specific SSE frames as they arrive, building its `completion`
 * event from the summed delta content across all events.
 */

import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig, WireProtocol } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { parseRetryAfter } from "./shared/rate-limit-headers.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./shared/stream-subprocess.js";
import { redactEndpointHost, scrubEndpointSecrets } from "../status.js";

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
 * Append `path` onto `baseUrl`, inserting `/v1` only when the base URL has no
 * path of its own.
 *
 * Exported so callers other than this dispatcher (e.g. the `usage` tool's
 * listModels, which hits GET {baseUrl}/models) build URLs the same way — a bare
 * baseUrl must not 404 on one code path while working on the other.
 *
 * "Append /v1 unless it already ENDS in /v1" mangles any other path:
 * `https://generativelanguage.googleapis.com/v1beta/openai` becomes
 * `/v1beta/openai/v1/chat/completions`, which Google does not serve, and a
 * third-party `anthropic_messages` host on a non-/v1 path is unconfigurable.
 * Every documented example already spells out its own `/v1`, and a bare origin
 * still gets one, which is what makes `https://api.anthropic.com` work.
 */
export function endpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let hasPath: boolean;
  try {
    const parsed = new URL(trimmed);
    hasPath = parsed.pathname !== "" && parsed.pathname !== "/";
  } catch {
    // Not parseable as a URL — fall back to the suffix test rather than
    // guessing.
    hasPath = trimmed.endsWith("/v1");
  }
  return hasPath ? `${trimmed}${path}` : `${trimmed}/v1${path}`;
}
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert software engineer. " +
  "Respond with clear, working code and concise explanations.";
const _MAX_FILE_BYTES = 512 * 1024; // 512 KB per file
/**
 * Cap across ALL files in one prompt (2 MB).
 *
 * The per-file limit alone bounds nothing useful: 64 files just under 512 KB
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

/**
 * The assistant text carried by one SSE frame's choices, if any.
 *
 * `delta` on a streaming frame, `message` on a non-streaming one — an endpoint
 * may send either shape mid-stream, so both are read.
 */
function deltaTexts(choices: ChatChoice[] | undefined): string[] {
  if (!Array.isArray(choices)) return [];
  const out: string[] = [];
  for (const choice of choices) {
    const content = (choice.delta ?? choice.message)?.content;
    if (typeof content === "string" && content.length > 0) out.push(content);
  }
  return out;
}

/**
 * Token counts from an SSE frame, or undefined when it carries none.
 *
 * BOTH numbers must be present: a frame with only one is a partial usage
 * report, and recording it as a complete pair would understate the other half.
 */
function readSseUsage(
  usage: ChatCompletionResponse["usage"],
): { input: number; output: number } | undefined {
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { input, output };
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
 * choosing between endpoints, "which endpoint, and what went wrong" is the
 * entire content of the message. The host is redacted, so this stays safe to
 * paste into a bug report.
 */
function describeFetchFailure(err: unknown, baseUrl: string, apiKey?: string): string {
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
  // The wrapped message is scrubbed too, not just the URL appended after it:
  // undici embeds the URL it was handed, so a base_url carrying userinfo or a
  // key in the query would put the raw credential into this string, which
  // reaches the terminal and `logs/dispatches.jsonl`. Same for the hint, which
  // can be `cause.message`.
  const safe = (text: string): string => scrubEndpointSecrets(text, baseUrl, apiKey);
  return hint ? `${safe(message)} (${where}: ${safe(hint)})` : `${safe(message)} (${where})`;
}

/**
 * Why a 200 produced no answer — asked identically by both request paths, so
 * that "the two surfaces agree" is something the code enforces rather than
 * something a comment claims.
 *
 * It reports what was observed and nothing else. Working out WHY a body is
 * unusable means guessing, and every guess is wrong one case over.
 */
function describeUnusableBody(raw: string, readError?: string): string {
  if (readError !== undefined) {
    // "No body" would be a claim about what the endpoint sent, and a failed
    // read is not evidence of that — the bytes below may be a partial answer.
    return raw.length === 0
      ? `Response body could not be read: ${readError}`
      : `Response body could not be read: ${readError} (partial body: ${raw.slice(0, RAW_HEAD_CHARS)})`;
  }
  return raw.length === 0
    ? "Empty response: the endpoint returned 200 with no body"
    : // Deliberately not a claim about the SHAPE being wrong — a well-formed
      // stream that carried nothing lands here too.
      `No answer in response body: ${raw.slice(0, RAW_HEAD_CHARS)}`;
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

  /**
   * Strip our credentials out of text the ENDPOINT wrote.
   *
   * One method rather than a call per site: a per-site scrub is how an
   * unscrubbed branch survives, returning up to 300 characters of raw
   * endpoint body to the caller and into `logs/dispatches.jsonl`.
   *
   * Enumerated rather than asserted, because a claim like "every branch goes
   * through here" is exactly what drifts. The branches assigning
   * `DispatchResult.error`: rate-limited and "No response body" (ours, no
   * endpoint text); `HTTP <status>`, the unusable-body describe, the stream's
   * thrown error and the mid-stream SSE error (all scrubbed here); and the
   * fetch-failure path, which scrubs inside `describeFetchFailure`. Anything
   * added to that list that carries endpoint text belongs here too.
   */
  #safe(text: string): string {
    return scrubEndpointSecrets(text, this.baseUrl ?? "", this.apiKey);
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
    // during streaming, so tokensUsed would be silently missing for every
    // call that goes through stream().
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
    // An empty string is not an answer — as in the anthropic_messages branch
    // above. Returning any string would make a well-formed 200 carrying
    // `content: ""` a SUCCESS with no output.
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
   * Parse one SSE frame (`event:`/`data:` lines separated by a blank line) into
   * DispatcherEvents. Anthropic frames carry a named `event:` line; OpenAI
   * frames don't (only `data:`, with a `[DONE]` sentinel) — both use the same
   * blank-line boundary, so the caller's chunking is shared.
   *
   * `usage` is PARTIAL per frame on purpose: Anthropic splits input_tokens
   * (message_start) and output_tokens (message_delta) across two frames, where
   * OpenAI sends both together. The caller merges rather than overwrites.
   *
   * `error`, when set, means the upstream sent a mid-stream error event AFTER
   * returning 200 and streaming some content — a case the HTTP-status checks in
   * #runStream never see. The caller must treat it as a failed completion,
   * keeping whatever partial output accumulated, not report success.
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
      // text: this IS the answer — an endpoint streams assistant content, not
      // a protocol, so it can be shown as it arrives.
      for (const chunk of deltaTexts(obj.choices)) {
        out.push({ type: "stdout", chunk, text: true });
      }
      usage = readSseUsage(obj.usage) ?? usage;
    }
    return error !== undefined ? { events: out, usage, error } : { events: out, usage };
  }

  /**
   * Anthropic streams message_start (initial input_tokens),
   * content_block_delta (text_delta chunks), message_delta (final
   * output_tokens), and on failure a named error event. Every `data:` line in
   * the frame accumulates rather than the last one winning: a proxy that
   * coalesces writes can land several real SSE events in what we treat as one
   * frame, and keeping only the last would silently lose content or usage.
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
   * Everything both request paths do before they diverge, in one place: the
   * URL, the headers, the timeout timer, the abort wiring, and the mapping of
   * a thrown fetch into a failure. Kept together because two hand-synchronised
   * copies drift — a credential leak fixed in one body-built error message and
   * missed in the other is the shape this prevents.
   *
   * `streaming` stays a parameter because it is the one thing that genuinely
   * differs: `dispatch()` sends `stream: false` and asks for JSON.
   *
   * The timer is handed back UNCLEARED on purpose — it has to span the body
   * read that follows, which is where a half-dead endpoint stalls. The caller
   * clears it.
   */
  async #openRequest(
    prompt: string,
    files: string[],
    opts: DispatchOpts,
    streaming: boolean,
  ): Promise<
    | { ok: true; res: Response; timer: ReturnType<typeof setTimeout>; timeoutMs: number; start: number }
    | { ok: false; failure: DispatchResult; start: number }
  > {
    const start = Date.now();
    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = this.#url();
    const model = opts.modelOverride ?? this.model;
    const body = this.#body(model, fullPrompt, streaming);
    const headers = this.#headers(streaming ? "text/event-stream" : "application/json");

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

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { ok: true, res, timer, timeoutMs, start };
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      return {
        ok: false,
        start,
        failure: {
          output: "",
          service: this.id,
          success: false,
          error: aborted
            ? `Timed out after ${timeoutMs}ms`
            : describeFetchFailure(err, this.baseUrl ?? "", this.apiKey),
          durationMs: Date.now() - start,
        },
      };
    }
  }

  override async dispatch(
    prompt: string,
    files: string[],
    _workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const opened = await this.#openRequest(prompt, files, opts, false);
    if (!opened.ok) return opened.failure;
    const { res, timer, start } = opened;
    // NOT cleared here — the timer must span the body read below.
    //
    // Clearing on headers leaves `res.text()` unbounded, so a route configured
    // with `timeout_ms: 120000` can sit far past it on a stalled body, with
    // only undici's 300s inactivity default as a backstop. The streaming
    // sibling below spans its own read the same way.
    const responseHeaders = headersToObject(res.headers);
    const durationMs = Date.now() - start;

    let rawBody = "";
    // Distinguished from an empty body: they are different events with
    // different fixes. A server that sends 200 plus a partial body and then
    // resets the connection must not be reported as "the endpoint returned 200
    // with no body", which is what the streaming path's own wording agrees on.
    let bodyReadError: string | undefined;
    try {
      rawBody = await readBodyCapped(res);
    } catch (err) {
      bodyReadError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
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
      // Scrubbed against the base URL, like every other error this
      // dispatcher returns. An endpoint that echoes the request URL back in
      // its own error body — several do — otherwise hands the caller their
      // own key in the query string, and the same string is written to
      // logs/dispatches.jsonl.
      const errMessage = this.#safe(
        this.#extractErrorMessage(parsedBody, rawBody),
      );
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
        // Same questions the streaming path asks, in the same order.
        error: this.#safe(describeUnusableBody(rawBody, bodyReadError)),
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
    const opened = await this.#openRequest(prompt, files, opts, true);
    if (!opened.ok) {
      yield { type: "completion", result: opened.failure };
      return;
    }
    const { res, timer, start } = opened;

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
      // The timeout spans the error body too, as it does in dispatch() above:
      // cleared first, an endpoint that sent an error status and then stalled
      // held the dispatch far past its time limit (measured: still pending at
      // 8 s on a 1 s limit).
      const rawBody = await readBodyCapped(res).catch(() => "");
      clearTimeout(timer);
      const parsedBody = this.#parseBody(rawBody);
      // Scrubbed against the base URL, like every other error this
      // dispatcher returns. An endpoint that echoes the request URL back in
      // its own error body — several do — otherwise hands the caller their
      // own key in the query string, and the same string is written to
      // logs/dispatches.jsonl.
      const errMessage = this.#safe(
        this.#extractErrorMessage(parsedBody, rawBody),
      );
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

    // SSE frames are separated by a blank line, which the spec allows as \n\n
    // OR \r\n\r\n — hence a regex boundary: a literal indexOf("\n\n") never
    // matches a CRLF-framed stream, so the whole body would silently pile up
    // in the trailing flush as one "frame".
    const chunks: string[] = [];
    let buffer = "";
    // The head of the body exactly as it arrived, kept because `buffer` is
    // consumed frame by frame and is empty by the time a failure is reported.
    // Without it the failure message could only say what was NOT found.
    //
    // Truncated to RAW_HEAD_CHARS, not "stopped once past it": appending whole
    // chunks while under the limit lets one chunk carry it to any length, so
    // the same 2 KB body would be classified differently depending on how the
    // network split it.
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

    let received = 0;
    try {
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // The same ceiling a CLI route's output has. Unbounded, a broken or
        // hostile endpoint streaming without frame boundaries grew this buffer
        // until the process ran short of memory: measured, 64 MiB in took
        // 768 MiB at peak.
        received += value.byteLength;
        if (received > DEFAULT_MAX_OUTPUT_BYTES) {
          streamError = `response exceeded the ${DEFAULT_MAX_OUTPUT_BYTES / (1024 * 1024)} MB limit — stopped reading`;
          break outer;
        }
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
      // Scrubbed, like every other error leaving this dispatcher. undici embeds
      // the request URL in its failure messages, so a base_url carrying
      // userinfo or an api key in the query string would land verbatim in
      // `result.error` — and from there in job status, stderr.log and
      // dispatches.jsonl.
      const errMsg = this.#safe(
        err instanceof Error ? err.message : String(err),
      );
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

    // An endpoint that ignores `stream: true` and answers with an ordinary
    // completion body still answered.
    //
    // Nothing in that body is SSE, so no frame parses out of it and the stream
    // yields nothing — the failure would read "No answer in response body:
    // {…"content":"pong"…}", quoting the answer it was about to throw away.
    // Real servers and gateways do ignore the flag. Read with the SAME
    // extractor the buffered path uses rather than inferring from shape, so
    // either the parser finds a completion or nothing happens.
    if (streamError === undefined && chunks.length === 0 && buffer.trim()) {
      const parsed = this.#parseBody(buffer);
      const recovered = parsed ? this.#extractContent(parsed) : null;
      if (recovered !== null && recovered !== "") {
        chunks.push(recovered);
        yield { type: "stdout", chunk: recovered };
        if (parsed) mergeUsage(this.#extractUsage(parsed) ?? null);
      }
    }

    const output = chunks.join("");
    // A 200 that yields no answer is not a successful empty answer. jobs.ts
    // only ever streams, so `success: true` with empty output would reach the
    // MCP surface an orchestrating agent branches on — and since the breaker
    // heals on a success, a route serving nothing but empty 200s would be
    // recorded as healthy forever and never trip.
    //
    // The message asks one question — did ANYTHING come back? — and leaves the
    // classifying to the reader. Guessing gets cases backwards: "no content"
    // mislabels an HTML error page, and a looks-like-SSE test discards the real
    // answer of a stream in a dialect this parser does not read, calls a
    // provider's comment keepalives an unexpected shape, and reads an HTML page
    // containing any `data:` line as empty. So a well-formed empty stream
    // reports its own `data: [DONE]` — less polished, and it cannot be wrong.
    const emptyAnswer = streamError === undefined && output.length === 0;
    const result: DispatchResult =
      streamError !== undefined || emptyAnswer
        ? {
            output,
            service: this.id,
            success: false,
            error: this.#safe(streamError ?? describeUnusableBody(rawSeen)),
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

/**
 * The rate-limit headers of a response, and nothing else.
 *
 * Every header used to be kept, under the name `rateLimitHeaders`, and written
 * into each job's result.json — `set-cookie` included.
 */
function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    if (/ratelimit|rate-limit|retry-after/i.test(key)) out[key] = value;
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
        // Announced per skipped file so the delegate knows exactly which
        // context it is missing.
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

/**
 * A response body as text, refusing past the same ceiling a CLI route's
 * output has. `res.text()` read any size into memory.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response exceeded the ${maxBytes / (1024 * 1024)} MB limit — stopped reading`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
