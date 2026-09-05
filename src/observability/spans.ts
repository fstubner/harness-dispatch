/**
 * Span helpers for harness-dispatch.
 *
 * Thin wrappers around `@opentelemetry/api` that encapsulate the three span
 * types this project emits:
 *
 *   harness-dispatch.dispatcher.*   — per-dispatch and per-stream invocations
 *   harness-dispatch.router.*       — routing decisions and route() calls
 *   harness-dispatch.mcp.tool       — MCP tool invocations
 *
 * Each helper takes a name, an attribute bag, and an async function. The
 * helper sets standard attributes, records exceptions, sets status, and
 * ensures the span is ended regardless of whether `fn` resolves or throws.
 *
 * When the SDK is not initialized, these helpers fall back to `trace.getTracer`
 * which returns a no-op tracer — span creation is essentially free.
 */

import { SpanStatusCode, trace, type Span, type Attributes } from "@opentelemetry/api";
import { redact } from "../redaction.js";

import { VERSION } from "../version.js";

const TRACER_NAME = "harness-dispatch";
// Was hardcoded "1.0.0-alpha.0" against a package at 0.4.x, so every emitted
// span was tagged with a version that never existed.
const TRACER_VERSION = VERSION;

export interface SpanAttrs {
  [key: string]: string | number | boolean | undefined;
}

function tracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

function assignAttrs(span: Span, attrs: SpanAttrs): void {
  const bag: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    bag[key] = value;
  }
  if (Object.keys(bag).length > 0) span.setAttributes(bag);
}

/**
 * Common implementation — runs `fn` inside a new span, records success /
 * exception, ends the span.
 */
async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span: Span) => {
    const t0 = Date.now();
    try {
      assignAttrs(span, attrs);
      const out = await fn(span);
      const durationMs = Date.now() - t0;
      span.setAttribute("duration_ms", durationMs);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      const durationMs = Date.now() - t0;
      span.setAttribute("duration_ms", durationMs);
      const e = err instanceof Error ? err : new Error(String(err));
      // Spans leave the process over OTLP, so this is a sink like any other —
      // and it was the one egress path outside the eight that redact. Opt-in
      // and localhost-by-default, which is why it is low rather than nothing.
      // The exception is rebuilt rather than mutated: recordException reads
      // `message` off the object it is given.
      const safe = new Error(redact(e.message));
      safe.name = e.name;
      span.recordException(safe);
      span.setStatus({ code: SpanStatusCode.ERROR, message: safe.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Dispatcher spans
// ---------------------------------------------------------------------------

export interface DispatcherSpanAttrs extends SpanAttrs {
  "dispatcher.id": string;
  "dispatcher.harness"?: string;
  model?: string;
  task_type?: string;
  "tokens.input"?: number;
  "tokens.output"?: number;
  success?: boolean;
  rate_limited?: boolean;
}

export async function withDispatcherSpan<T>(
  op: "dispatch" | "stream",
  attrs: DispatcherSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`harness-dispatch.dispatcher.${op}`, attrs, fn);
}

// ---------------------------------------------------------------------------
// Router spans
// ---------------------------------------------------------------------------

export interface RouterSpanAttrs extends SpanAttrs {
  "router.op": "route" | "pick_service" | "route_to" | "stream";
  task_type?: string;
  service?: string;
  tier?: number;
  success?: boolean;
}

export async function withRouterSpan<T>(
  attrs: RouterSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const { "router.op": op, ...rest } = attrs;
  return withSpan(`harness-dispatch.router.${op}`, { ...rest, "router.op": op }, fn);
}

// ---------------------------------------------------------------------------
// MCP tool spans
// ---------------------------------------------------------------------------

export interface McpToolSpanAttrs extends SpanAttrs {
  "tool.name": string;
  service?: string;
  success?: boolean;
}

export async function withMcpToolSpan<T>(
  attrs: McpToolSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan("harness-dispatch.mcp.tool", attrs, fn);
}
