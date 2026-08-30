/**
 * Catch a near-miss TOP-LEVEL key on the MCP surface, before the SDK drops it.
 *
 * THE DEFECT. `safteyProfile: "read_only"` was accepted in silence and the
 * dispatch then ran at the `workspace_edit` default — an acceptance pass
 * measured it writing a file into the project. Asking for read-only by way of
 * a typo got you write access, with nothing said on any surface. The HTTP
 * surface has rejected the same input all along (`http/parse.ts` runs exactly
 * the check below), so the two surfaces gave opposite answers to one input,
 * which is the class the parity suite exists to end.
 *
 * WHY IT NEEDED THIS AND NOT A SCHEMA CHANGE. The SDK validates arguments
 * against `z.object(inputShape)` before any handler runs, and zod STRIPS
 * unknown keys rather than reporting them — so by the time our code sees the
 * arguments, the misspelled key is already gone. `hints` is `.strict()`, which
 * is why the nested form is caught; the outer object cannot be, because MCP
 * carries `_meta` there and rejecting that would break legitimate callers. The
 * named traps in `tool-schemas.ts` close the predictable snake_case slips, but
 * a plain typo is not enumerable — generating every one-edit spelling of every
 * hint name would put dozens of `z.never()` fields into the advertised schema.
 *
 * WHY WRAPPING setRequestHandler RATHER THAN REPLACING THE ROUTE. The obvious
 * alternative — register our own `CallToolRequestSchema` handler — means
 * reimplementing the SDK's routing: tool lookup, enable checks, task support,
 * input and OUTPUT schema validation, and the `extra` argument that carries
 * the progress token our fanout tap writes to. Replacing all of that to add
 * one check would be trading a silent safety hole for a much larger surface of
 * things to get wrong. This wraps the handler the SDK installs, inspects the
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

interface RawCallToolRequest {
  params?: { arguments?: unknown };
}

/** The near-miss message for the first offending key, or undefined. */
export function nearMissInArguments(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    const meant = nearMissHintKey(key);
    if (meant !== undefined) return nearMissMessage(key, meant);
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
      const message = nearMissInArguments((request as RawCallToolRequest)?.params?.arguments);
      // InvalidParams, so it reaches the caller as a protocol error naming the
      // key rather than as a tool result they might not read. The HTTP surface
      // answers 400 for the same input.
      if (message !== undefined) throw new McpError(ErrorCode.InvalidParams, message);
      return handler(request, extra);
    };
    return (original as unknown as (...a: unknown[]) => unknown)(schema, guarded, ...rest);
  }) as unknown;
}
