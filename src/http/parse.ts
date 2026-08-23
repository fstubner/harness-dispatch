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
  safetyProfile?: unknown;
  workspacePolicy?: unknown;
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
const ROUTE_POLICIES = ["local_only", "approval_required", "blocked"] as const;

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

function parseHints(body: ChatRequest): RouteHints {
  const hints: RouteHints = {};
  if (typeof body.model === "string" && body.model !== "") hints.model = body.model;
  const topSafety = enumField(body.safetyProfile, SAFETY_PROFILES, "safetyProfile");
  if (topSafety !== undefined) hints.safetyProfile = topSafety;
  if (body.hints && typeof body.hints === "object") {
    const raw = body.hints as Record<string, unknown>;
    if (typeof raw.model === "string") hints.model = raw.model;
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
    if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
      hints.timeoutMs = raw.timeoutMs;
    }
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
  const files = Array.isArray(body.files)
    ? body.files.filter((v): v is string => typeof v === "string")
    : [];
  const models = Array.isArray(body.models)
    ? body.models.filter((v): v is string => typeof v === "string")
    : [];
  const resolvedWorkingDir = resolveWorkingDir(
    typeof body.workingDir === "string" ? body.workingDir : undefined,
  );
  const warning = workingDirWarning(resolvedWorkingDir);
  return {
    prompt,
    files,
    workingDir: resolvedWorkingDir.workingDir,
    ...(warning !== undefined ? { workingDirWarning: warning } : {}),
    stream: body.stream === true,
    mode: body.mode === "fanout" ? "fanout" : "single",
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
