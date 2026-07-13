/**
 * MCP server entry points for harness-router.
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

const SERVER_NAME = "harness-router";
const SERVER_VERSION = VERSION;

const SERVER_INSTRUCTIONS =
  "Delegate bounded coding work you'd otherwise do yourself — implement, fix, review, " +
  "or plan a task in a project — to whichever configured harness (Claude Code, Codex, " +
  "Cursor, Antigravity, or an endpoint) best fits it, freeing your own context/quota for " +
  "orchestration. Prefer the `job` tool: action=start returns a jobId right away and " +
  "tells you how long to wait before polling action=get for partial or final output; " +
  "`code` blocks synchronously and is only safe for sub-1-2-minute tasks. Always pass " +
  "workingDir (the caller's project root — it is NOT inferred) and hints.taskType " +
  "(execute | plan | review | local) on every call; omitting either degrades routing or " +
  "runs the task in the wrong directory. Call `usage` before using an unfamiliar " +
  "hints.model, service, or models value — those are unvalidated and silently ignored " +
  "if they don't match a real route id. Read harness-router://status or " +
  "harness-router://status.json for route readiness, billing policy, and safety detail.";

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

/** Bootstrap runtime state + build an `McpServer` with all tools registered. */
export async function buildMcpServer(opts: BuildMcpOptions = {}): Promise<BuiltMcp> {
  // Initialize OpenTelemetry once. Idempotent; no-op when OTEL_SDK_DISABLED=true.
  await initObservability();

  const stateOpts: { configPath?: string } = {};
  if (opts.configPath !== undefined) stateOpts.configPath = opts.configPath;
  const state = await bootstrapRuntime(stateOpts);
  const holder = new RuntimeHolder(state);
  const reloader = new ConfigHotReloader(holder, opts.configPath);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, { holder, reloader });
  registerResources(server, { holder, reloader });
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
