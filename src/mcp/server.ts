/**
 * MCP server entry points for harness-dispatch.
 *
 * Exposes:
 *   startMcpServer({ configPath })            — stdio transport (default).
 * The HTTP transport lives in ../http/server.ts so MCP-over-HTTP and the
 * OpenAI-compatible REST API share one authenticated server.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { bootstrapRuntime, ConfigHotReloader, RuntimeHolder } from "./config-hot-reload.js";
import { orphanStrandedSlotQueue } from "../jobs.js";
import { installNearMissGuard } from "./near-miss-guard.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { initObservability } from "../observability/index.js";
import { VERSION } from "../version.js";
import { scrubSecrets, collectSecrets } from "../redaction.js";
import type { RouterConfig } from "../types.js";

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
  "full result once done, or omit jobId to list the 20 most recent jobs) — nothing is ever " +
  "lost to a timeout, including this MCP call's own. Always pass workingDir " +
  "(the caller's project root — it is NOT inferred) and hints.taskType " +
  "(execute | plan | review | local) on every " +
  "call; omitting either degrades routing or runs the task in the wrong directory. " +
  "Choose the model's strength with hints.modelTier (cheap | standard | strong): the " +
  "router picks the route and that route runs its own model for the tier, on a " +
  "fallback too. Do not set `service` unless the task needs that exact route — a " +
  "named route gets no fallback when it is rate-limited or fails. Use hints.model " +
  "(an exact model id) only together with `service`. Fanout `models` only selects " +
  "which routes run. Read harness-dispatch://status or " +
  "harness-dispatch://status.json for route readiness, billing policy, and safety " +
  "detail.";

/**
 * What a connecting agent is told: the server's own instructions, then the
 * operator's from config.yaml — a top-level `instructions:` block and each
 * enabled route's `instructions:`. Written once in config, this reaches every
 * client, instead of being repeated in each one's own instruction file.
 *
 * Read when a session connects, so an edit reaches new sessions only. Secret
 * values are scrubbed: config is interpolated as a whole, so a `${VAR}` in
 * this text would otherwise expand to the variable's value.
 */
export function serverInstructions(config: RouterConfig | undefined): string {
  if (config === undefined) return SERVER_INSTRUCTIONS;
  const parts = [SERVER_INSTRUCTIONS];
  if (config.instructions !== undefined) {
    parts.push(`Operator instructions for this machine (from its config.yaml):\n${config.instructions}`);
  }
  const perRoute = Object.entries(config.services)
    .filter(([, svc]) => svc.enabled !== false && svc.instructions !== undefined)
    .map(([id, svc]) => `- ${id}: ${svc.instructions}`);
  if (perRoute.length > 0) {
    parts.push(`Operator instructions per route (also shown in \`usage\`):\n${perRoute.join("\n")}`);
  }
  return scrubSecrets(parts.join("\n\n"), collectSecrets(config));
}

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

export interface McpInstanceOptions {
  /**
   * Whether the instance stands for a connection (stdio, or a legacy HTTP
   * session) and so mints a connection id its dispatches are recorded under.
   * False for a 2026-07-28 HTTP request, which gets an instance of its own.
   * Defaults to true.
   */
  connection?: boolean;
}

/**
 * Build a fresh `McpServer` with all tools/resources registered against
 * existing runtime state. An SDK server serves one connection at a time
 * (`connect()` rejects while it is connected elsewhere), and the SDK's serving
 * entries take a factory for exactly that reason: `serveStdio` calls it once
 * per connection, `createMcpHandler` once per 2026-07-28 HTTP request, and the
 * legacy HTTP leg once per session. holder/reloader are cheap to share; the
 * McpServer wrapper is not.
 *
 * The instructions are passed to the SDK, which answers them in the
 * `initialize` result for a 2025-era client and in the `server/discover`
 * result for a 2026-07-28 one.
 */
export function buildMcpServerInstance(
  holder: RuntimeHolder,
  reloader: ConfigHotReloader,
  opts: McpInstanceOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: serverInstructions(holder.state.config) },
  );
  // BEFORE registerTools: the SDK installs its tools/call handler on the first
  // tool registration, and this wraps that handler as it goes in. See
  // near-miss-guard.ts for why the check cannot live in the schema.
  const assertGuarded = installNearMissGuard(server);
  registerTools(server, { holder, reloader }, opts.connection === false ? { connection: false } : {});
  assertGuarded();
  registerResources(server, { holder, reloader });
  return server;
}

/** Load config and build the runtime state every MCP instance shares. */
export async function bootstrapMcpRuntime(
  opts: BuildMcpOptions = {},
): Promise<{ holder: RuntimeHolder; reloader: ConfigHotReloader }> {
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
  // Every serving entry builds its instances lazily, on a connection's first
  // message, so a build that throws (the near-miss guard's check, say) would
  // otherwise surface only as "Internal server error" on every request. One
  // throwaway build here makes it a startup failure with its own message.
  await buildMcpServerInstance(holder, reloader).close();
  return { holder, reloader };
}

/** Bootstrap runtime state + build an `McpServer` with all tools registered. */
export async function buildMcpServer(opts: BuildMcpOptions = {}): Promise<BuiltMcp> {
  const { holder, reloader } = await bootstrapMcpRuntime(opts);
  const server = buildMcpServerInstance(holder, reloader);
  return { server, holder, reloader };
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

export interface McpHandle {
  close(): Promise<void>;
}

/**
 * Report jobs stranded in the slot queue by a server that exited, rather than
 * silently running them.
 *
 * A slot-queued job is exempt from orphan detection — nothing heartbeats for
 * it, so the staleness rule would misreport every job that waits more than 90
 * seconds. The only things that drain the queue are a runner exiting and a new
 * dispatch arriving, so without this a server that died with jobs queued
 * leaves them reading `queued` forever, where a RUNNING job in the same
 * situation is reported orphaned within 90s.
 *
 * Draining the queue here instead would be worse than the gap it closes: kill
 * a server with a job queued, restart it, and that job runs to completion — in
 * its original workingDir, at whatever safety profile the manifest recorded,
 * up to `workspace_edit` or `full_auto`, with nobody watching and no
 * confirmation, bounded only by the 7-day retention window. Starting an editor
 * is not an action anyone associates with "run yesterday's abandoned agent job
 * against my repository".
 *
 * So: any job still slot-queued when a server starts belongs to a session that
 * is gone — this process has not queued anything yet — and it is marked
 * orphaned. That answers the question the caller was actually asking ("is this
 * ever going to run?") without executing anything on their behalf. The job
 * keeps its id and artifacts, and `retry_job` re-runs it deliberately.
 */
function reportStrandedQueue(): void {
  void orphanStrandedSlotQueue().catch(() => undefined);
}

/**
 * Serve MCP over this process's stdin/stdout.
 *
 * `serveStdio` decides the protocol revision from the client's first message:
 * an `initialize` pins the connection to a 2025-era instance (Codex, Cursor,
 * older Claude Code), and a `server/discover` or any request carrying the
 * 2026-07-28 `_meta` envelope pins it to a 2026-07-28 one. Either way the
 * factory runs once for the connection, so the connection id minted in
 * registerTools is shared by every dispatch on it. A client that probes with
 * `server/discover` and then falls back to `initialize` costs one extra,
 * discarded instance.
 *
 * Output still goes through `process.stdout.write`, so the process-wide
 * redaction installed by bin.ts covers every frame.
 */
export async function startMcpServer(opts: BuildMcpOptions = {}): Promise<McpHandle> {
  const { holder, reloader } = await bootstrapMcpRuntime(opts);
  const handle = serveStdio(() => buildMcpServerInstance(holder, reloader), {
    // The SDK drops these otherwise. stderr only: stdout is the protocol.
    onerror: (err) => process.stderr.write(`harness-dispatch: ${err.message}
`),
  });
  reportStrandedQueue();
  return {
    async close() {
      await handle.close();
    },
  };
}
