/**
 * Parsing an OpenAI-style request into something the router can act on.
 *
 * Split out of http/server.ts, which mixed this with transport wiring. The
 * separation is worth making because this file is the HTTP surface's half of
 * the safety boundary, and it has repeatedly been the half that drifted: the
 * MCP tool rejected an unknown fanout target by name while this one silently
 * returned fewer arms, capped context files while this one accepted an
 * unbounded list, and rejected misplaced hint keys while this one ignored
 * them. Every one of those was found as "same input, two answers".
 *
 * Anything rejected here must be rejected the same way the MCP schema
 * rejects it (see mcp/tool-schemas.ts). BadRequestError is what maps a
 * refusal to HTTP 400 rather than letting it fail later as a 500.
 */

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import type { RouteHints, WorkspacePolicy } from "../types.js";
import { resolveWorkingDir, validateWorkingDir, workingDirWarning } from "../working-dir.js";
import { MAX_TIMEOUT_MS } from "../mcp/tool-schemas.js";

/** Raised for anything the caller can fix; mapped to HTTP 400 by the server. */
export class PayloadTooLargeError extends Error {}

export interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

export interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  prompt?: unknown;
  stream?: unknown;
  workingDir?: unknown;
  files?: unknown;
  mode?: unknown;
  models?: unknown;
  hints?: unknown;
  // Hints this surface also accepts at the top level, because OpenAI bodies
  // are flat. See parseHints for why the placement rule diverges from MCP.
  safetyProfile?: unknown;
  workspacePolicy?: unknown;
  taskType?: unknown;
  routePolicy?: unknown;
  preferLargeContext?: unknown;
  timeoutMs?: unknown;
  // Accepted by the MCP tool, refused here rather than silently discarded.
  contextJobs?: unknown;
  service?: unknown;
  escalate?: unknown;
}

// Local-only server, but still worth bounding: an unbounded body read lets
// any authorized (or, if --host is opened beyond loopback, network-adjacent)
// caller exhaust process memory with one oversized POST.
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/**
 * A request the CALLER can fix — malformed JSON, a missing required field, a
 * working directory that does not exist.
 *
 * Everything except the 413 was returned as 500. PRODUCT.md names CI and cron
 * as consumers of this surface, and retry-on-5xx will happily retry a request
 * that can never succeed. A 4xx says "stop and fix the request", which is the
 * true statement.
 */
export class BadRequestError extends Error {}

/** Mirrors MAX_CONTEXT_FILES in mcp/tools.ts — the two surfaces must agree. */
export const MAX_CONTEXT_FILES_HTTP = 64;

export async function readJson(
  req: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      // Don't destroy() the socket here — that races with the 413 response
      // write and the client sees a connection reset instead of a clean
      // status code. Just stop buffering (the memory-exhaustion risk this
      // guards against) and let the normal response path write the 413.
      throw new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BadRequestError(
      `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesToPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return (messages as ChatMessage[])
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "user";
      const text = contentToText(message.content);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

const TASK_TYPES = ["execute", "plan", "review", "local"] as const;
const SAFETY_PROFILES = ["read_only", "workspace_edit", "full_auto"] as const;
const WORKSPACE_POLICIES = ["shared", "shared_locked", "copy", "git_worktree"] as const;
// "standard" belongs here: it is in the RoutePolicy type, it is the router's
// own default, and the MCP description advertises it as `'standard'
// (default)`. Omitting it meant a caller copying the documented default into
// an HTTP body got `invalid value "standard"` for naming the thing that
// already happens.
const ROUTE_POLICIES = ["standard", "local_only", "approval_required", "blocked"] as const;

const MODES = ["single", "fanout"] as const;

/**
 * A positive integer of milliseconds, bounded by what setTimeout can hold —
 * the SAME bound the MCP schema advertises, imported rather than restated so
 * the two cannot drift. Above it Node clamps to 1ms, so the longest timeout a
 * caller can ask for becomes the shortest possible: identical harm to the `0`
 * case, from the opposite end, and a ms/µs unit slip lands in that range
 * easily.
 */
function timeoutField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMEOUT_MS) {
    throw new BadRequestError(
      `${field}: expected an integer from 1 to ${MAX_TIMEOUT_MS}, got ${JSON.stringify(value)}.`,
    );
  }
  return value as number;
}

/** A boolean field: rejected when it is a non-boolean, not coerced. */
function boolField(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new BadRequestError(`${field}: expected boolean, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Every one of these ends up in an argv array — `files` as `--add-dir`
 * grants, `models` as route ids, `hints.model` as `--model`. A NUL fails deep
 * inside cross-spawn with "The argument 'args[N]' must be a string without
 * null bytes", which is the raw Node internal a boundary rejection replaces.
 * The prompt was guarded and these three were not, on BOTH surfaces — so
 * parity held while both were wrong, which no parity row can catch.
 */
export function noNul(value: string, field: string): void {
  if (value.includes("\u0000")) {
    throw new BadRequestError(`${field}: must not contain NUL bytes.`);
  }
}

/** A string array: rejected entry by entry rather than silently filtered. */
function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${field}: must be an array of strings.`);
  }
  const bad = value.findIndex((v) => typeof v !== "string");
  if (bad >= 0) {
    throw new BadRequestError(
      `${field}[${bad}]: expected string, got ${JSON.stringify(value[bad])}.`,
    );
  }
  (value as string[]).forEach((v, i) => noNul(v, `${field}[${i}]`));
  return value as string[];
}

/**
 * An enum-valued field: accepted when it is one of the listed values, REJECTED
 * when it is anything else.
 *
 * Each of these used to be an `if (v === a || v === b)` that simply did not
 * assign on a miss, so a typo was DROPPED and the default applied. For
 * safetyProfile that default is less restrictive than what the caller was
 * reaching for: `"read_onlyy"` returned 200 and ran the dispatch
 * write-capable, while the MCP surface rejects the identical input by name.
 *
 * The unknown-KEY check further down was added for precisely this failure and
 * covers only half of it. The config loader gets the value case right and says
 * so loudly ("IGNORED, and the default applies instead, which is less
 * restrictive than what this looks like it was meant to set"); this surface is
 * the one PRODUCT.md points CI and cron at, and it was the one failing open.
 */
function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new BadRequestError(
    `${field}: invalid value ${JSON.stringify(value)}. Valid: ${allowed.join(", ")}.`,
  );
}

/**
 * Hints this surface accepts at the TOP LEVEL as well as inside `hints`.
 *
 * MCP refuses top-level placement outright (misplacedTopLevelKeys), because
 * there a stripped key is a safety setting that silently does nothing. This
 * surface speaks the OpenAI wire format, where bodies are flat and callers
 * reasonably reach for a flat key — and it already honoured `safetyProfile`
 * and `workspacePolicy` there, which taught exactly that. The other four were
 * DROPPED on a 200: `{"routePolicy":"local_only"}` returned success and the
 * dispatch left the machine anyway.
 *
 * So the placement rule diverges from MCP deliberately and the guarantee does
 * not: on both surfaces a hint you set either takes effect or you are told.
 * Nested wins when both are given — the more specific one — on both surfaces.
 */
function parseHints(body: ChatRequest): RouteHints {
  const hints: RouteHints = {};
  // `escalate` is honoured nowhere: escalation is per-route config
  // (escalate_model / escalate_on), never per call. MCP says so by name; this
  // surface swallowed it, so a caller could believe they had asked for it.
  if ((body as Record<string, unknown>)["escalate"] !== undefined) {
    throw new BadRequestError(
      "escalate is not a dispatch field — escalation is configured per route in " +
        "config.yaml (escalate_model / escalate_on), not per call.",
    );
  }
  // MCP parameters this surface does not implement. Both were accepted and
  // DISCARDED on a 200: `contextJobs` meant the delegate ran without the prior
  // work the caller believed it had sent — the same harm that justified
  // rejecting a non-string `files` entry — and `service` meant an explicit
  // route choice was silently overridden by the router's pick. Refused by name
  // until this surface implements them; saying so is the whole contract.
  for (const key of ["contextJobs", "service"] as const) {
    if ((body as Record<string, unknown>)[key] !== undefined) {
      throw new BadRequestError(
        `${key} is not supported on the HTTP surface — it is an MCP tool parameter. ` +
          `It was previously accepted and silently ignored.`,
      );
    }
  }
  const topTaskType = enumField(body.taskType, TASK_TYPES, "taskType");
  if (topTaskType !== undefined) hints.taskType = topTaskType;
  const topRoutePolicy = enumField(body.routePolicy, ROUTE_POLICIES, "routePolicy");
  if (topRoutePolicy !== undefined) hints.routePolicy = topRoutePolicy;
  if (body.preferLargeContext !== undefined && body.preferLargeContext !== null) {
    hints.preferLargeContext = boolField(body.preferLargeContext, "preferLargeContext");
  }
  const topTimeout = timeoutField(body.timeoutMs, "timeoutMs");
  if (topTimeout !== undefined) hints.timeoutMs = topTimeout;
  // Dropped rather than rejected, unlike `hints.model` below: this is the
  // OpenAI protocol's own field, which clients fill in unconditionally and
  // often with a placeholder, so leniency is the point. Whitespace is dropped
  // for the same reason "" always was — it is not a model name, and it is
  // TRUTHY, so it survived to `--model "   "` on a CLI route and cost a real
  // provider call, a route failure and breaker credit on an HTTP 200.
  if (typeof body.model === "string" && body.model.trim() !== "") hints.model = body.model;
  const topSafety = enumField(body.safetyProfile, SAFETY_PROFILES, "safetyProfile");
  if (topSafety !== undefined) hints.safetyProfile = topSafety;
  if (body.hints !== undefined && body.hints !== null) {
    // `hints: "x"` / `[]` / `7` used to fall through this branch and vanish,
    // so every hint in it — including the safety ones — was silently ignored
    // on a 200. Arrays are typeof "object", so they got in and then matched no
    // key. MCP rejects each by name.
    if (typeof body.hints !== "object" || Array.isArray(body.hints)) {
      throw new BadRequestError(`hints: must be an object, got ${JSON.stringify(body.hints)}.`);
    }
    const raw = body.hints as Record<string, unknown>;
    // A known key with the WRONG TYPE was dropped by the if-chain below, the
    // same half-measure the unknown-KEY rule was added to close: parse.ts's
    // header requires anything rejected here to be rejected the way the MCP
    // schema rejects it, and MCP answers invalid_type for each of these.
    // enumField already does this for the safety-bearing fields; these three
    // are the ones it does not cover.
    for (const [key, expected] of [
      ["model", "string"],
      ["preferLargeContext", "boolean"],
      ["timeoutMs", "number"],
    ] as const) {
      const value = raw[key];
      if (value !== undefined && typeof value !== expected) {
        throw new BadRequestError(
          `hints.${key}: expected ${expected}, got ${JSON.stringify(value)}.`,
        );
      }
    }
    // Blank is REJECTED, matching the MCP surface — for the same reason the
    // unknown-key rule below exists. An empty string is not "no preference":
    // it beat the route's configured model, so the harness ran with no model
    // flag and the response reported model: "". Rejected rather than dropped
    // because this key is harness-dispatch's own, not the OpenAI protocol's:
    // nobody sets it by accident, so a blank one is a mistake worth naming.
    if (typeof raw.model === "string") {
      if (raw.model.trim() === "") {
        throw new BadRequestError(
          `hints.model: must not be empty — omit it entirely for no preference.`,
        );
      }
      noNul(raw.model, "hints.model");
      hints.model = raw.model;
    }
    const taskType = enumField(raw.taskType, TASK_TYPES, "hints.taskType");
    if (taskType !== undefined) hints.taskType = taskType;
    if (typeof raw.preferLargeContext === "boolean") {
      hints.preferLargeContext = raw.preferLargeContext;
    }
    const safetyProfile = enumField(raw.safetyProfile, SAFETY_PROFILES, "hints.safetyProfile");
    if (safetyProfile !== undefined) hints.safetyProfile = safetyProfile;
    const workspacePolicy = enumField(
      raw.workspacePolicy,
      WORKSPACE_POLICIES,
      "hints.workspacePolicy",
    );
    if (workspacePolicy !== undefined) hints.workspacePolicy = workspacePolicy;
    // routePolicy was never read here at all. evaluateRoutePolicy implements
    // local_only, approval_required and blocked in full, and on this surface
    // they were wired to nothing: POST {"hints":{"routePolicy":"blocked"}}
    // returned 200 and dispatched. PRODUCT.md names CI and cron as this
    // surface's consumers, and calls a guarantee that reads correctly and does
    // nothing at runtime its own counter-signal.
    const routePolicy = enumField(raw.routePolicy, ROUTE_POLICIES, "hints.routePolicy");
    if (routePolicy !== undefined) hints.routePolicy = routePolicy;
    // The VALUE, not just the type. `0` is not nullish, so it won every
    // coalesce down to setTimeout, fired on the first tick, SIGTERMed the
    // child, and came back "Timed out after 0ms" — recorded as a route failure
    // with breaker credit, behind an HTTP 200. See timeoutField for the upper
    // bound, which does the same damage from the other end.
    const nestedTimeout = timeoutField(raw.timeoutMs, "hints.timeoutMs");
    if (nestedTimeout !== undefined) hints.timeoutMs = nestedTimeout;
    // Unknown keys are REJECTED, matching the MCP surface. The whole point of
    // making hints strict there was that `safety_profile` (the config
    // spelling) silently disabled a safety limit; accepting it here left the
    // identical typo failing open on the other surface.
    const known = new Set([
      "model",
      "taskType",
      "preferLargeContext",
      "safetyProfile",
      "workspacePolicy",
      "routePolicy",
      "timeoutMs",
    ]);
    const unknown = Object.keys(raw).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw new BadRequestError(
        `unknown hints key(s): ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`,
      );
    }
  }
  const topPolicy = enumField(body.workspacePolicy, WORKSPACE_POLICIES, "workspacePolicy");
  if (topPolicy !== undefined) hints.workspacePolicy = topPolicy;
  return hints;
}

export function parseChatRequest(raw: unknown): {
  prompt: string;
  files: string[];
  workingDir: string;
  workingDirWarning?: string;
  stream: boolean;
  mode: "single" | "fanout";
  models: string[];
  hints: RouteHints;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    // Was a plain Error, so `null`, `"hello"` and `42` all returned 500. The
    // BadRequestError mapping was added for JSON PARSE failures only — same
    // fix, one of two paths, which is the pattern this file keeps repeating.
    throw new BadRequestError("request body must be a JSON object");
  }
  const body = raw as ChatRequest;
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt
      : messagesToPrompt(body.messages);
  if (!prompt.trim()) throw new BadRequestError("messages or prompt is required");
  // MCP refuses this at the boundary; here it reached cross-spawn and surfaced
  // as `The argument 'args[2]' must be a string without null bytes` — a raw
  // Node internal where a boundary rejection belongs, which is exactly what
  // the MCP refine was added to replace.
  if (prompt.includes("\u0000")) {
    throw new BadRequestError("prompt must not contain NUL bytes");
  }
  // MCP validates this; HTTP did not, so `workingDir: "Z:/nope"` surfaced as
  // `spawn node.EXE ENOENT` — verbatim the wrong-cause error working-dir.ts
  // exists to prevent, on the surface CI uses.
  const workingDirError = validateWorkingDir(
    typeof (body as { workingDir?: unknown }).workingDir === "string"
      ? ((body as { workingDir?: string }).workingDir as string)
      : undefined,
  );
  if (workingDirError !== undefined) throw new BadRequestError(workingDirError);
  // Same cap as the MCP surface, and for the same reason: each file's parent
  // directory becomes an --add-dir grant on CLI routes, so an unbounded list
  // is an unbounded set of directories handed to a coding agent. The cap was
  // added at the MCP boundary only; this surface accepted 500.
  if (Array.isArray(body.files) && body.files.length > MAX_CONTEXT_FILES_HTTP) {
    throw new BadRequestError(
      `files: ${body.files.length} entries exceeds the maximum of ${MAX_CONTEXT_FILES_HTTP}.`,
    );
  }
  // Non-string entries are REJECTED, not filtered out. `files: [1, "a"]`
  // returned 200 having quietly dropped an entry, so the delegate ran without
  // context the caller believed it had sent — and `models` decides which
  // fanout arms run, so a dropped entry is an opinion the caller asked for and
  // never got. MCP rejects both arrays by name.
  const files = stringArray(body.files, "files");
  const models = stringArray(body.models, "models");
  const resolvedWorkingDir = resolveWorkingDir(
    typeof body.workingDir === "string" ? body.workingDir : undefined,
  );
  const warning = workingDirWarning(resolvedWorkingDir);
  return {
    prompt,
    files,
    workingDir: resolvedWorkingDir.workingDir,
    ...(warning !== undefined ? { workingDirWarning: warning } : {}),
    // `mode` and `stream` are enum/boolean fields, not truthiness tests. A
    // typo used to DOWNGRADE silently on a 200: {"mode":"fanou"} ran one
    // dispatch and never said so, and a CI caller asking for independent
    // opinions got a single answer it could not tell apart from a real one.
    // {"stream":"true"} likewise returned a non-streaming response. This is
    // the class enumField was written for, three screens up.
    stream: boolField(body.stream, "stream"),
    mode: enumField(body.mode, MODES, "mode") ?? "single",
    models,
    hints: parseHints(body),
  };
}

export function completionEnvelope(
  content: string,
  model: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...extra,
  };
}
