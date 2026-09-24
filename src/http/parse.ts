/**
 * Parsing an OpenAI-style request into something the router can act on.
 *
 * This file is the HTTP surface's half of the safety boundary, and it is the
 * half that drifts: where it is more lenient than MCP, the same input gets two
 * different answers and the looser one is usually the unsafe one.
 *
 * Anything rejected here must be rejected the same way the MCP schema
 * rejects it (see mcp/tool-schemas.ts). BadRequestError is what maps a
 * refusal to HTTP 400 rather than letting it fail later as a 500.
 */

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import type { RouteHints } from "../types.js";
import { nearMissHintKey, nearMissMessage } from "../near-miss.js";
import { resolveWorkingDir, validateWorkingDir, workingDirWarning } from "../working-dir.js";
import { MAX_CONTEXT_FILES, MAX_TIMEOUT_MS } from "../mcp/tool-schemas.js";

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
 * PRODUCT.md names CI and cron as consumers of this surface, and retry-on-5xx
 * will happily retry a request that can never succeed. A 4xx says "stop and
 * fix the request", which is the true statement.
 */
export class BadRequestError extends Error {}

/** The MCP surface's own limit, imported rather than copied so it cannot drift. */
export const MAX_CONTEXT_FILES_HTTP = MAX_CONTEXT_FILES;

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
// (default)`, so a caller can reasonably send it explicitly.
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
  // `null` is a VALUE, refused like any other wrong one — enumField refuses it
  // too, so the same key at the same placement answers the same way.
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMEOUT_MS) {
    throw new BadRequestError(
      `${field}: expected an integer from 1 to ${MAX_TIMEOUT_MS}, got ${JSON.stringify(value)}.`,
    );
  }
  return value as number;
}

/** A boolean field: rejected when it is a non-boolean, not coerced. */
function boolField(value: unknown, field: string): boolean {
  if (value === undefined) return false;
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
 * Dropping a value that misses and applying the default fails OPEN: for
 * safetyProfile the default is less restrictive than whatever the caller was
 * reaching for, so `"read_onlyy"` would return 200 and run the dispatch
 * write-capable, while MCP rejects the identical input by name. The
 * unknown-KEY check further down covers only the other half of this.
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
 * reasonably reach for a flat key, so all seven are honoured there. The
 * placement rule diverges from MCP deliberately; the guarantee does not — on
 * both surfaces a hint you set either takes effect or you are told.
 *
 * When BOTH placements are given, nested wins — the more specific one — with
 * one exception: `workspacePolicy` takes the top-level value, because there it
 * is a real MCP parameter rather than a trap and `workspacePolicyFromInput`
 * resolves it that way. The exception is pinned by a test so it stays a
 * decision.
 */
function parseHints(body: ChatRequest): RouteHints {
  const hints: RouteHints = {};
  // `escalate` is honoured nowhere: escalation is per-route config
  // (escalate_model / escalate_on), never per call. Named rather than
  // swallowed, so a caller cannot believe they asked for it.
  if ((body as Record<string, unknown>)["escalate"] !== undefined) {
    throw new BadRequestError(
      "escalate is not a dispatch field — escalation is configured per route in " +
        "config.yaml (escalate_model / escalate_on), not per call.",
    );
  }
  // The config.yaml spelling of a hint, at the TOP level.
  //
  // `hints` is .strict() on both surfaces because `hints: { safety_profile }`
  // silently disables a safety limit. The outer object cannot be strict — MCP
  // carries `_meta`, and this surface must tolerate OpenAI's own fields — so
  // the same slip one level up needs this named list. A list rather than a
  // general rule, because an unknown top-level key is legitimate here and a
  // near-miss is not.
  //
  // The advice is per key: naming a landing spot that also refuses would cost
  // the caller the second round trip this check exists to save, and
  // `contextJobs` is not implemented on this surface at all.
  for (const [wrong, advice] of [
    ["safety_profile", "this API spells it safetyProfile"],
    ["route_policy", "this API spells it routePolicy"],
    ["task_type", "this API spells it taskType"],
    ["workspace_policy", "this API spells it workspacePolicy"],
    ["prefer_large_context", "this API spells it preferLargeContext"],
    ["timeout_ms", "this API spells it timeoutMs"],
    ["working_dir", "this API spells it workingDir"],
    ["context_jobs", "contextJobs is an MCP tool parameter and is not supported here"],
    // The key this endpoint uses in its OWN responses (http/server.ts), so
    // wrapping a request's hints in it is the natural wrong guess. Wrapped
    // that way every hint would vanish on a 200 and the dispatch would run at
    // the default workspace_edit: more access than the caller asked for.
    ["harness_dispatch", "put hints at the top level or inside `hints`"],
    ["harnessDispatch", "put hints at the top level or inside `hints`"],
    // This product's OWN CLI flag is `--safety`, which makes the bare name the
    // most plausible slip anyone will make here — and it is seven edits from
    // `safetyProfile`, so the near-miss rule below correctly declines to guess
    // and it has to be named here instead.
    ["safety", "this API spells it safetyProfile"],
  ] as const) {
    if ((body as Record<string, unknown>)[wrong] !== undefined) {
      throw new BadRequestError(
        `${wrong} is not a field — ${advice}. It was previously accepted and ` +
          `silently ignored, which for a safety setting means the dispatch ran ` +
          `with MORE access than you asked for.`,
      );
    }
  }
  // A near-miss of a hint name, at the top level.
  //
  // The named list above catches the snake_case spellings, which are the
  // predictable slip. A plain typo is not predictable and has the same
  // consequence: `safteyProfile` dropped means the dispatch runs at the looser
  // default behind a 200. The outer object cannot be strict — it carries
  // OpenAI's own fields — so this asks a narrower question: is this key ALMOST
  // one of ours? None of OpenAI's field names come near one, and a key that is
  // genuinely unrelated stays legitimate.
  for (const key of Object.keys(body as Record<string, unknown>)) {
    const meant = nearMissHintKey(key);
    if (meant !== undefined) {
      // All seven hint names are read from the top level here, so the advice
      // is "top level" — the opposite of what MCP needs for five of them.
      throw new BadRequestError(nearMissMessage(key, meant, { surface: "http" }));
    }
  }
  // MCP parameters this surface does not implement, refused by name rather
  // than discarded: a dropped `contextJobs` means the delegate runs without
  // prior work the caller believed it had sent, and a dropped `service` means
  // an explicit route choice is silently overridden by the router's pick.
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
  if (body.preferLargeContext !== undefined) {
    hints.preferLargeContext = boolField(body.preferLargeContext, "preferLargeContext");
  }
  const topTimeout = timeoutField(body.timeoutMs, "timeoutMs");
  if (topTimeout !== undefined) hints.timeoutMs = topTimeout;
  // Dropped rather than rejected, unlike `hints.model` below: this is the
  // OpenAI protocol's own field, which clients fill in unconditionally and
  // often with a placeholder, so leniency is the point. Whitespace is dropped
  // like "" — it is not a model name, and being TRUTHY it would otherwise
  // survive to `--model "   "` on a CLI route and cost a real provider call,
  // a route failure and breaker credit behind an HTTP 200.
  if (typeof body.model === "string" && body.model.trim() !== "") hints.model = body.model;
  const topSafety = enumField(body.safetyProfile, SAFETY_PROFILES, "safetyProfile");
  if (topSafety !== undefined) hints.safetyProfile = topSafety;
  if (body.hints !== undefined && body.hints !== null) {
    // `hints: "x"` / `[]` / `7` would otherwise fall through and vanish, so
    // every hint in it — including the safety ones — would be silently ignored
    // behind a 200. Arrays are typeof "object", hence the explicit check. MCP
    // rejects each by name.
    if (typeof body.hints !== "object" || Array.isArray(body.hints)) {
      throw new BadRequestError(`hints: must be an object, got ${JSON.stringify(body.hints)}.`);
    }
    const raw = body.hints as Record<string, unknown>;
    // A known key with the WRONG TYPE would be dropped by the if-chain below,
    // while MCP answers invalid_type for each of these. enumField covers the
    // safety-bearing fields; these three are the ones it does not.
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
    // Blank is REJECTED, matching the MCP surface. An empty string is not "no
    // preference": it beats the route's configured model, so the harness runs
    // with no model flag and reports model: "". Rejected rather than dropped
    // because this key is harness-dispatch's own, not the OpenAI protocol's —
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
    // evaluateRoutePolicy implements local_only, approval_required and blocked
    // in full, so this surface has to read the hint or those guarantees are
    // wired to nothing here — PRODUCT.md names CI and cron as its consumers.
    const routePolicy = enumField(raw.routePolicy, ROUTE_POLICIES, "hints.routePolicy");
    if (routePolicy !== undefined) hints.routePolicy = routePolicy;
    // The VALUE, not just the type. `0` is not nullish, so it wins every
    // coalesce down to setTimeout, fires on the first tick and SIGTERMs the
    // child — "Timed out after 0ms", recorded as a route failure with breaker
    // credit behind an HTTP 200. See timeoutField for the upper bound, which
    // does the same damage from the other end.
    const nestedTimeout = timeoutField(raw.timeoutMs, "hints.timeoutMs");
    if (nestedTimeout !== undefined) hints.timeoutMs = nestedTimeout;
    // Unknown keys are REJECTED, matching the MCP surface: `safety_profile`
    // (the config spelling) accepted here would silently disable a safety
    // limit.
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
    // A plain Error here would make `null`, `"hello"` and `42` return 500;
    // they are all caller-fixable, like a JSON parse failure.
    throw new BadRequestError("request body must be a JSON object");
  }
  const body = raw as ChatRequest;
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt
      : messagesToPrompt(body.messages);
  if (!prompt.trim()) throw new BadRequestError("messages or prompt is required");
  // Refused at the boundary like MCP does; otherwise it reaches cross-spawn
  // and surfaces as `The argument 'args[2]' must be a string without null
  // bytes` — a raw Node internal where a boundary rejection belongs.
  if (prompt.includes("\u0000")) {
    throw new BadRequestError("prompt must not contain NUL bytes");
  }
  // Validated here as MCP validates it: unchecked, `workingDir: "Z:/nope"`
  // surfaces as `spawn node.EXE ENOENT`, the wrong-cause error working-dir.ts
  // exists to prevent.
  //
  // A non-string workingDir is REJECTED, not quietly treated as absent: read
  // as "not provided", `workingDir: 123` would run a write-capable agent in
  // the SERVER's own directory behind a 200, under a warning claiming the
  // value was never provided.
  const rawWorkingDir = (body as { workingDir?: unknown }).workingDir;
  if (rawWorkingDir !== undefined && rawWorkingDir !== null && typeof rawWorkingDir !== "string") {
    throw new BadRequestError(
      `workingDir must be a string (an absolute path), received ${typeof rawWorkingDir}.`,
    );
  }
  const workingDirError = validateWorkingDir(
    typeof rawWorkingDir === "string" ? rawWorkingDir : undefined,
  );
  if (workingDirError !== undefined) throw new BadRequestError(workingDirError);
  // Same cap as the MCP surface, and for the same reason: each file's parent
  // directory becomes an --add-dir grant on CLI routes, so an unbounded list
  // is an unbounded set of directories handed to a coding agent.
  if (Array.isArray(body.files) && body.files.length > MAX_CONTEXT_FILES_HTTP) {
    throw new BadRequestError(
      `files: ${body.files.length} entries exceeds the maximum of ${MAX_CONTEXT_FILES_HTTP}.`,
    );
  }
  // Non-string entries are REJECTED, not filtered out: a quietly dropped
  // `files` entry means the delegate runs without context the caller believed
  // it had sent, and `models` decides which fanout arms run, so a dropped
  // entry is an opinion the caller asked for and never got. MCP rejects both
  // arrays by name.
  const files = stringArray(body.files, "files");
  const models = stringArray(body.models, "models");
  // An explicit `models: []` is refused here exactly as MCP refuses it:
  // treated like "omitted" it fans out to every eligible route, when a caller
  // who sent an empty array built a list that came out empty. Omitting the
  // field is how you ask for everything.
  if (Array.isArray(body.models) && models.length === 0) {
    throw new BadRequestError(
      "models: [] selects no routes. Omit `models` entirely to fan out to every " +
        "eligible route (expensive — one dispatch per route), or name at least one. " +
        "An empty list is usually a filter that matched nothing.",
    );
  }
  const resolvedWorkingDir = resolveWorkingDir(
    typeof body.workingDir === "string" ? body.workingDir : undefined,
  );
  const warning = workingDirWarning(resolvedWorkingDir);
  return {
    prompt,
    files,
    workingDir: resolvedWorkingDir.workingDir,
    ...(warning !== undefined ? { workingDirWarning: warning } : {}),
    // `mode` and `stream` are enum/boolean fields, not truthiness tests: a
    // typo would DOWNGRADE silently behind a 200, so {"mode":"fanou"} runs one
    // dispatch and a CI caller asking for independent opinions gets a single
    // answer it cannot tell apart from a real one.
    stream: boolField(body.stream, "stream"),
    mode: enumField(body.mode, MODES, "mode") ?? "single",
    models,
    hints: parseHints(body),
  };
}

/**
 * One completion id in the shape OpenAI clients expect.
 *
 * Shared with the streaming path deliberately: every chunk of one stream must
 * repeat the SAME id, so it is minted once per request there rather than per
 * frame, and the `chatcmpl-` convention lives in one place.
 */
export function newCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

/**
 * The identity every chunk of one streamed response repeats.
 *
 * `id` and `created` are fixed for the life of the stream — a client that
 * groups chunks by id (or dedupes on it) sees one response, not one per frame.
 * `model` is mutable because the route, and therefore the model that answered,
 * is not known until the router has picked one: it starts as whatever the
 * caller asked for and is filled in once a decision arrives, matching what the
 * non-streaming path reports.
 */
export interface StreamIdentity {
  id: string;
  created: number;
  model: string;
}

export function newStreamIdentity(model: string): StreamIdentity {
  return { id: newCompletionId(), created: Math.floor(Date.now() / 1000), model };
}

export function completionEnvelope(
  content: string,
  model: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: newCompletionId(),
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
