/**
 * Catch a near-miss TOP-LEVEL key on the MCP surface, before the SDK drops it.
 *
 * WHAT IT GUARDS. Without this, `safteyProfile: "read_only"` is accepted in
 * silence and the dispatch runs at the `workspace_edit` default: asking for
 * read-only by way of a typo gets you write access, with nothing said on any
 * surface. The HTTP surface rejects the same input (`http/parse.ts` runs
 * exactly the check below), so the two surfaces would otherwise give opposite
 * answers to one input.
 *
 * WHY NOT A SCHEMA CHANGE. The SDK validates arguments against
 * `z.object(inputShape)` before any handler runs, and zod STRIPS unknown keys
 * rather than reporting them — so by the time our code sees the arguments, the
 * misspelled key is already gone. `hints` is `.strict()`, which is why the
 * nested form is caught; the outer object cannot be, because MCP carries
 * `_meta` there and rejecting that would break legitimate callers. The named
 * traps in `tool-schemas.ts` close the predictable snake_case slips, but a
 * plain typo is not enumerable — generating every one-edit spelling of every
 * hint name would put dozens of `z.never()` fields into the advertised schema.
 *
 * WHY WRAPPING setRequestHandler RATHER THAN REPLACING THE ROUTE. Registering
 * our own `CallToolRequestSchema` handler means reimplementing the SDK's
 * routing: tool lookup, enable checks, task support, input and OUTPUT schema
 * validation, and the `extra` argument that carries the progress token the
 * fanout tap writes to. This wraps the handler the SDK installs, inspects the
 * raw arguments, and delegates: routing is untouched.
 *
 * Ordering matters. `McpServer` installs its CallTool handler lazily on the
 * first `registerTool`, and calls `assertCanSetRequestHandler` first — so a
 * handler registered ahead of it would make that assertion throw. This must be
 * installed BEFORE `registerTools`, and it is a no-op until the SDK registers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { nearMissHintKey, nearMissMessage } from "../near-miss.js";

/** The method string the SDK keys its CallTool handler by. */
const CALL_TOOL_METHOD = "tools/call";

interface RawCallToolRequest {
  params?: { name?: unknown; arguments?: unknown };
}

/**
 * Keys that mean nothing at the top level of `dispatch`, each with the message
 * the caller is refused with.
 *
 * `hints` is .strict(), so `hints: { safety_profile: ... }` is rejected. The
 * OUTER object cannot be, so without these moving the same key up one level
 * makes it vanish silently instead:
 *
 *   hints.safetyProfile = read_only      -> honoured
 *   TOP-LEVEL safetyProfile = read_only  -> dropped, runs with write access
 *
 * Full .strict() on the outer object is deliberately NOT used: MCP clients may
 * attach their own fields (_meta and similar). Naming the specific misplaced
 * keys closes the trap without guessing at what else may legitimately arrive.
 */
function hintKeyMessage(key: string): string {
  return (
    `${key} belongs inside \`hints\`, not at the top level — e.g. hints: { ${key}: ... }. ` +
    `At the top level it does nothing, which for a safety setting means the dispatch ` +
    `runs with MORE access than you asked for.`
  );
}

/**
 * A snake_case near-miss at the top level.
 *
 * `where` is per key and not a constant: `workingDir` and `contextJobs` are
 * top-level dispatch parameters, so telling a caller to move them "inside
 * `hints`" produces a SECOND error ("Unrecognized key"), costing the round trip
 * this exists to save.
 */
function snakeCaseMessage(wrong: string, right: string, where: string): string {
  return (
    `${wrong} is not a field — this tool spells it ${right}, ${where}. As written it ` +
    `does nothing, which for a safety setting means the dispatch runs with MORE ` +
    `access than you asked for.`
  );
}

const IN_HINTS = "inside `hints`";
const TOP_LEVEL = "at the top level";

export const MISPLACED_TOP_LEVEL_KEYS: Readonly<Record<string, string>> = {
  safety_profile: snakeCaseMessage("safety_profile", "safetyProfile", IN_HINTS),
  route_policy: snakeCaseMessage("route_policy", "routePolicy", IN_HINTS),
  task_type: snakeCaseMessage("task_type", "taskType", IN_HINTS),
  prefer_large_context: snakeCaseMessage("prefer_large_context", "preferLargeContext", IN_HINTS),
  timeout_ms: snakeCaseMessage("timeout_ms", "timeoutMs", IN_HINTS),
  // Accepted in BOTH placements — a real top-level parameter as well as a
  // hint, with the top-level value winning when both are given.
  workspace_policy: snakeCaseMessage(
    "workspace_policy",
    "workspacePolicy",
    `${TOP_LEVEL} or ${IN_HINTS}`,
  ),
  working_dir: snakeCaseMessage("working_dir", "workingDir", TOP_LEVEL),
  context_jobs: snakeCaseMessage("context_jobs", "contextJobs", TOP_LEVEL),
  safetyProfile: hintKeyMessage("safetyProfile"),
  routePolicy: hintKeyMessage("routePolicy"),
  taskType: hintKeyMessage("taskType"),
  preferLargeContext: hintKeyMessage("preferLargeContext"),
  timeoutMs: hintKeyMessage("timeoutMs"),
  model:
    "model belongs inside `hints` for single mode — hints: { model: ... }. " +
    "In fanout mode use the top-level `models` array instead. At the top " +
    "level it does nothing.",
  escalate:
    "escalate is not a dispatch field — escalation is configured per route in " +
    "config.yaml (escalate_model / escalate_on), not per call.",
};

/** The refusal for the first offending key, or undefined. */
export function nearMissInArguments(args: unknown, toolName?: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  // Only `dispatch` has hints or a top level worth guarding; own keys only, so
  // an argument named `constructor` is not read as a trap.
  if (toolName === undefined || toolName === "dispatch") {
    for (const [key, message] of Object.entries(MISPLACED_TOP_LEVEL_KEYS)) {
      if (Object.hasOwn(record, key) && record[key] !== undefined) return message;
    }
  }
  for (const key of Object.keys(record)) {
    const meant = nearMissHintKey(key);
    if (meant !== undefined) {
      // The TOOL is passed on, because the advice differs by it: on a tool
      // that takes no hints, the corrected spelling is not a field either, and
      // a message telling the caller to fix the spelling sends them to a key
      // that is silently ignored — the class this guard exists to close,
      // reopened one step later.
      return nearMissMessage(key, meant, {
        surface: "mcp",
        ...(toolName !== undefined ? { toolName } : {}),
      });
    }
  }
  return undefined;
}

/**
 * Wrap the CallTool handler the SDK is about to install.
 *
 * Call BEFORE `registerTools`. Returns nothing; the server is patched in place.
 */
export function installNearMissGuard(server: McpServer): void {
  const inner = server.server;
  // Installing after `registerTools` is inert — the SDK's handler is already
  // in place and this would wrap nothing — and the failure mode of getting the
  // order wrong is a SILENT safety hole rather than an error. One line turns
  // "safety check quietly absent" into a startup failure.
  if (inner.assertCanSetRequestHandler !== undefined) {
    inner.assertCanSetRequestHandler(CALL_TOOL_METHOD);
  }
  const original = inner.setRequestHandler.bind(inner);
  // The cast is confined to this one line. The SDK types `setRequestHandler`
  // against the specific schema it is given, and this wrapper is deliberately
  // schema-agnostic: everything other than CallTool is passed straight through.
  (inner as unknown as { setRequestHandler: unknown }).setRequestHandler = ((
    schema: unknown,
    handler: (request: unknown, extra: unknown) => unknown,
    ...rest: unknown[]
  ) => {
    if (schema !== CallToolRequestSchema) {
      return (original as unknown as (...a: unknown[]) => unknown)(schema, handler, ...rest);
    }
    const guarded = async (request: unknown, extra: unknown): Promise<unknown> => {
      const params = (request as RawCallToolRequest)?.params;
      const message = nearMissInArguments(
        params?.arguments,
        typeof params?.name === "string" ? params.name : undefined,
      );
      // InvalidParams, so it reaches the caller as a protocol error naming the
      // key rather than as a tool result they might not read. The HTTP surface
      // answers 400 for the same input.
      if (message !== undefined) throw new McpError(ErrorCode.InvalidParams, message);
      return handler(request, extra);
    };
    return (original as unknown as (...a: unknown[]) => unknown)(schema, guarded, ...rest);
  }) as unknown;
}
