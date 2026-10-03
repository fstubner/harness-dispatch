/**
 * Nested dispatch: an agent that harness-dispatch started may not dispatch.
 *
 * Every agent started for a job carries HARNESS_DISPATCH_DEPTH, one deeper than
 * the process that started it. A delegate with a shell, or with this server
 * among its own MCP servers, could otherwise dispatch again without bound
 * (audit5 F7).
 *
 * The decision is read from the environment of the process that ACCEPTS the
 * dispatch (the MCP server, the HTTP server, the CLI), never from the process
 * that eventually runs the job. Background jobs run in shared supervisor
 * processes started once, by whichever session happened to need one, so the
 * supervisor's environment says nothing about who is asking now.
 */

/** Deepest an agent may be and still dispatch. 0 means only a session no dispatch started. */
const MAX_DISPATCHING_DEPTH = 0;

/** How many dispatches deep the process owning `env` is. Unset or unparseable is 0. */
export function dispatchDepth(env: NodeJS.ProcessEnv = process.env): number {
  return Number.parseInt(env["HARNESS_DISPATCH_DEPTH"] ?? "0", 10) || 0;
}

/**
 * The explanation to refuse with, or undefined when this process may dispatch.
 * One sentence for every caller, so the refusal reads the same wherever it lands.
 */
export function nestedDispatchRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const depth = dispatchDepth(env);
  if (depth <= MAX_DISPATCHING_DEPTH) return undefined;
  return (
    `refused: this dispatch comes from an agent that was itself started by a dispatch ` +
    `(HARNESS_DISPATCH_DEPTH=${depth}). A delegate may not dispatch at all, so delegation ` +
    `cannot nest without bound. Do the work directly instead.`
  );
}

/** Thrown by a dispatch entry point. Nothing was started, so no route is blamed. */
export class NestedDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedDispatchError";
  }
}

/** Throws NestedDispatchError when this process may not dispatch. */
export function assertMayDispatch(env: NodeJS.ProcessEnv = process.env): void {
  const refusal = nestedDispatchRefusal(env);
  if (refusal !== undefined) throw new NestedDispatchError(refusal);
}
