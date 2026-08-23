/**
 * MCP server entry points for harness-dispatch.
 *
 * Exposes:
 *   startMcpServer({ configPath })            — stdio transport (default).
 * The HTTP transport lives in ../http/server.ts so MCP-over-HTTP and the
 * OpenAI-compatible REST API share one authenticated server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { bootstrapRuntime, ConfigHotReloader, RuntimeHolder } from "./config-hot-reload.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { initObservability } from "../observability/index.js";
import { VERSION } from "../version.js";

const SERVER_NAME = "harness-dispatch";
const SERVER_VERSION = VERSION;

const SERVER_INSTRUCTIONS =
  "This server turns the machine's installed coding harnesses (Claude Code, Codex, " +
  "Cursor, Antigravity) and configured local/remote API endpoints into tools you can " +
  "call — delegate bounded coding work you'd otherwise do yourself (implement, fix, " +
  "review, or plan a task in a project) to whichever backend best fits it, freeing " +
  "your own context/quota for orchestration. `dispatch` always starts new work: it " +
  "runs the task as a background job and waits a short grace window — a fast task " +
  "returns its full result inline (completed: true); a slow one returns completed: " +
  "false plus a jobId. Check on it with `job_status` (partial output while running, " +
  "full result once done, or omit jobId to list every known job) — nothing is ever " +
  "lost to a timeout, including this MCP call's own. Always pass workingDir " +
  "(the caller's project root — it is NOT inferred) and hints.taskType " +
  "(execute | plan | review | local) on every " +
  "call; omitting either degrades routing or runs the task in the wrong directory. " +
  "Check the `usage` tool before passing an unfamiliar model or route name — " +
  "semantics differ per field: hints.model is forwarded to the picked harness as-is " +
  "UNLESS it names a configured route, in which case it steers routing only and the " +
  "route runs its own model (routing.modelHintDropped reports that; " +
  "routing.modelHintMatched reports whether the picked route declares it), fanout " +
  "`models` only selects which routes run (it does not set their model), and forcing " +
  "a specific backend is done with the top-level `service` param. Read " +
  "harness-dispatch://status or harness-dispatch://status.json for route readiness, " +
  "billing policy, and safety detail.";

// ---------------------------------------------------------------------------
// Builder — shared between stdio and HTTP entry points
// ---------------------------------------------------------------------------

export interface BuildMcpOptions {
  /** Path to config.yaml. Omit to auto-detect installed CLIs. */
  configPath?: string;
}

export interface BuiltMcp {
  server: McpServer;
  holder: RuntimeHolder;
  reloader: ConfigHotReloader;
}

/**
 * Build a fresh `McpServer` with all tools/resources registered against
 * existing runtime state. The SDK's Protocol.connect() throws if called
 * twice on the same Server instance ("use a separate Protocol instance per
 * connection") — so any transport that needs its own connect() call (e.g.
 * one StreamableHTTPServerTransport per HTTP MCP session) needs its own
 * McpServer instance too. holder/reloader are cheap to share; the McpServer
 * wrapper is not.
 */
export function buildMcpServerInstance(
  holder: RuntimeHolder,
  reloader: ConfigHotReloader,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, { holder, reloader });
  registerResources(server, { holder, reloader });
  return server;
}

/** Bootstrap runtime state + build an `McpServer` with all tools registered. */
export async function buildMcpServer(opts: BuildMcpOptions = {}): Promise<BuiltMcp> {
  const stateOpts: { configPath?: string } = {};
  if (opts.configPath !== undefined) stateOpts.configPath = opts.configPath;
  const state = await bootstrapRuntime(stateOpts);

  // Telemetry is opt-in: initialize only after config load, gated on
  // `telemetry: { enabled: true }` (or the HARNESS_DISPATCH_TELEMETRY env
  // var, which initObservability checks itself). Idempotent.
  if (state.config.telemetry?.enabled) {
    await initObservability({ enabled: true });
  }
  const holder = new RuntimeHolder(state);
  const reloader = new ConfigHotReloader(holder, opts.configPath);

  const server = buildMcpServerInstance(holder, reloader);
  return { server, holder, reloader };
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

export interface McpHandle {
  close(): Promise<void>;
}

export async function startMcpServer(opts: BuildMcpOptions = {}): Promise<McpHandle> {
  const { server } = await buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
    },
  };
}
