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
 * A loose (passthrough) input schema would let a handler see the extra key,
 * but it changes the schema every client is shown and turns the refusal into
 * a tool result instead of a protocol error, so it is not used either.
 *
 * WHY WRAPPING setRequestHandler RATHER THAN REPLACING THE ROUTE. Registering
 * our own `tools/call` handler means reimplementing the SDK's routing: tool
 * lookup, enable checks, input and OUTPUT schema validation, the per-protocol
 * result projection, and the context argument that carries the progress token
 * and `notify` the progress tap writes to. This wraps the handler the SDK
 * installs, inspects the raw arguments, and delegates: routing is untouched.
 *
 * SDK v2 (2.3.1) has no public hook that sees a request before schema
 * validation: no middleware, and `Server._wrapHandler` is protected on a
 * `Server` that `McpServer` constructs itself. `setRequestHandler(method,
 * handler)` and `assertCanSetRequestHandler(method)` ARE public, so this wraps
 * the public method on this one instance. `installNearMissGuard` returns a
 * check that throws unless the wrap actually caught the `tools/call`
 * registration, and `buildMcpServerInstance` runs it after registering tools:
 * an SDK change that installs the handler some other way becomes a startup
 * failure instead of a silently absent safety check.
 *
 * Ordering matters. `McpServer` installs its `tools/call` handler lazily on
 * the first `registerTool`, and calls `assertCanSetRequestHandler` first — so
 * a handler registered ahead of it would make that assertion throw. This must
 * be installed BEFORE `registerTools`, and it is a no-op until the SDK
 * registers.
 */

import { ProtocolError, ProtocolErrorCode, type McpServer } from "@modelcontextprotocol/server";

import { nearMissHintKey, nearMissMessage } from "../near-miss.js";

/** The method the SDK registers its tool-call handler under. */
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
 * Wrap the `tools/call` handler the SDK is about to install.
 *
 * Call BEFORE `registerTools`. The server is patched in place. The returned
 * function throws unless a `tools/call` handler went through the wrapper;
 * call it once the tools are registered.
 */
export function installNearMissGuard(server: McpServer): () => void {
  const inner = server.server;
  // Installing after `registerTools` is inert — the SDK's handler is already
  // in place and this would wrap nothing — and the failure mode of getting the
  // order wrong is a SILENT safety hole rather than an error. One line turns
  // "safety check quietly absent" into a startup failure.
  inner.assertCanSetRequestHandler(CALL_TOOL_METHOD);
  let wrapped = false;
  const original = inner.setRequestHandler.bind(inner) as (...args: unknown[]) => void;
  // The cast is confined to this assignment. The SDK types `setRequestHandler`
  // as an overload set keyed by method, and this wrapper is deliberately
  // method-agnostic: everything other than the two-argument `tools/call`
  // registration is passed straight through.
  (inner as unknown as { setRequestHandler: (...args: unknown[]) => void }).setRequestHandler = (
    ...args: unknown[]
  ): void => {
    const [method, handler] = args;
    if (method !== CALL_TOOL_METHOD || args.length !== 2 || typeof handler !== "function") {
      original(...args);
      return;
    }
    const delegate = handler as (request: unknown, ctx: unknown) => unknown;
    const guarded = async (request: unknown, ctx: unknown): Promise<unknown> => {
      const params = (request as RawCallToolRequest)?.params;
      const message = nearMissInArguments(
        params?.arguments,
        typeof params?.name === "string" ? params.name : undefined,
      );
      // InvalidParams, so it reaches the caller as a protocol error naming the
      // key rather than as a tool result they might not read. The HTTP surface
      // answers 400 for the same input.
      if (message !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
      // The context is forwarded untouched: it carries the progress token and
      // `notify`, so dropping it would silence progress for every tool call.
      return delegate(request, ctx);
    };
    wrapped = true;
    original(method, guarded);
  };
  return () => {
    if (!wrapped) {
      throw new Error(
        "near-miss guard did not wrap the SDK's tools/call handler: the SDK installs it some " +
          "other way now, and dispatch would silently drop misspelled safety settings",
      );
    }
  };
}
