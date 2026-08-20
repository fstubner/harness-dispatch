/**
 * harness-dispatch — TypeScript package.
 *
 * Public library surface.
 */

export { Router } from "./router.js";
export type { RouterStreamEvent } from "./router.js";
export { CircuitBreaker } from "./circuit-breaker.js";
// Exported so a caller that must not touch the user's real breaker state —
// the live agent smoke script, chiefly — can hand Router an isolated store.
export { BreakerStore } from "./breaker-store.js";
export { QuotaCache, QuotaState } from "./quota.js";
export { LeaderboardCache } from "./leaderboard.js";
export { loadConfig, watchConfig } from "./config.js";
export * from "./types.js";
export type { Dispatcher, DispatchOpts } from "./dispatchers/base.js";
export { BaseDispatcher, drainDispatcherStream } from "./dispatchers/base.js";

// Shared streaming subprocess helper (R3)
export {
  streamSubprocess,
  drainSubprocessStream,
  type SubprocessChunk,
  type SubprocessEnd,
  type SubprocessStreamEvent,
  type StreamSubprocessOpts,
} from "./dispatchers/shared/stream-subprocess.js";

// MCP surface (R2)
export {
  buildMcpServer,
  startMcpServer,
  type BuildMcpOptions,
  type McpHandle,
} from "./mcp/server.js";
export {
  startHttpServer,
  startMcpHttpServer,
  type StartHttpOptions,
  type HttpServerHandle,
} from "./http/server.js";
export { buildDispatchers } from "./mcp/dispatcher-factory.js";
export { TOOL_NAMES } from "./mcp/tools.js";
export { buildStatus, renderStatusText, type HarnessDispatchStatus } from "./status.js";
export { ensureHttpToken, readHttpToken, rotateHttpToken } from "./auth.js";
export { buildRouteBilling, billingIsBlocked, billingIsUnknown } from "./billing.js";
export { evaluateRoutePolicy } from "./route-policy.js";

// Observability (R3)
export {
  initObservability,
  shutdownObservability,
  withDispatcherSpan,
  withRouterSpan,
  withMcpToolSpan,
  type InitObservabilityOpts,
  type SpanAttrs,
} from "./observability/index.js";


export { VERSION } from "./version.js";
