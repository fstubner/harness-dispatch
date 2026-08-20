import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { ensureHttpToken, isAuthorized } from "../auth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildMcpServer,
  buildMcpServerInstance,
  type BuildMcpOptions,
  type McpHandle,
} from "../mcp/server.js";
import { buildStatus, buildUsage } from "../status.js";
import type { RouteHints, RouteSkip } from "../types.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import type { Router } from "../router.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { workingDirWarning } from "../working-dir.js";
import { getAsyncJob, startAsyncJobTracked } from "../jobs.js";
import {
  BadRequestError,
  completionEnvelope,
  parseChatRequest,
  PayloadTooLargeError,
  readJson,
} from "./parse.js";

// Re-exported: BadRequestError is part of this module's public surface
// (tests and the CLI import it from here) and moving its definition should
// not move where callers get it from.
export { BadRequestError };
import type { RuntimeHolder } from "../mcp/config-hot-reload.js";

export interface HttpServerHandle extends McpHandle {
  port: number;
  host: string;
  token: string | null;
}

export interface StartHttpOptions extends BuildMcpOptions {
  port?: number;
  host?: string;
  mcpRoute?: string;
  token?: string | null;
}



function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isLoopbackHost(host: string): boolean {
  // "::" (IPv6 unspecified, equivalent to 0.0.0.0) is deliberately NOT
  // included — it means "bind all interfaces," the opposite of loopback.
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}









/**
 * Run fanout arms to completion INDEPENDENTLY of one another.
 *
 * Promise.all rejected the whole batch when one arm threw (workspace lock
 * timeout, worktree setup failure), discarding every other arm's completed —
 * and possibly billed — work behind a single 500. Each arm now settles on its
 * own; a thrown arm becomes a failed row naming its route. One row shape for
 * the streaming and non-streaming branches on purpose: they used to differ
 * (streaming omitted success/error), the one-sibling-guarded pattern again.
 */
async function runFanoutArms(
  router: Router,
  routes: string[],
  parsed: { prompt: string; files: string[]; workingDir: string; hints: RouteHints },
): Promise<
  Array<{ route: string; success: boolean; output: string; error?: string; workspace?: unknown }>
> {
  const settled = await Promise.allSettled(
    routes.map((route) =>
      router.routeTo(route, parsed.prompt, parsed.files, parsed.workingDir, {
        ...(parsed.hints.safetyProfile !== undefined
          ? { safetyProfile: parsed.hints.safetyProfile }
          : {}),
        ...(parsed.hints.workspacePolicy !== undefined
          ? { workspacePolicy: parsed.hints.workspacePolicy }
          : {}),
        ...(parsed.hints.taskType !== undefined ? { taskType: parsed.hints.taskType } : {}),
      }),
    ),
  );
  return settled.map((s, i) => {
    if (s.status === "fulfilled") {
      const r = s.value.result;
      return {
        route: r.service,
        success: r.success,
        output: r.output,
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.workspace !== undefined ? { workspace: r.workspace } : {}),
      };
    }
    return {
      route: routes[i]!,
      success: false,
      output: "",
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });
}

/**
 * One request's SSE state, shared with the top-level catch so a mid-stream
 * failure ends with an error frame instead of a silent truncation.
 */
interface SseState {
  started: boolean;
}

/**
 * POST /v1/chat/completions — extracted from the request callback, where
 * this logic sat eleven brace-levels deep (the smell checker's worst
 * finding for the whole repo). Behaviour is unchanged; only the nesting
 * moved.
 */
async function handleChatCompletions(
  holder: RuntimeHolder,
  parsed: ReturnType<typeof parseChatRequest>,
  res: ServerResponse,
  sse: SseState,
): Promise<void> {
  const state = holder.state;
  if (parsed.mode === "fanout") {
    const fanoutSafetyProfile = parsed.hints.safetyProfile ?? "read_only";
    if (
      fanoutSafetyProfile !== "read_only" &&
      (parsed.hints.workspacePolicy === undefined ||
        !isIsolatedWorkspacePolicy(parsed.hints.workspacePolicy))
    ) {
      sendJson(res, 400, {
        error: {
          message:
            "write-capable fanout requires workspacePolicy=copy or workspacePolicy=git_worktree; use read_only fanout or run single-route workspace_edit",
          code: "workspace_isolation_required",
        },
      });
      return;
    }
    parsed.hints.safetyProfile = fanoutSafetyProfile;
  }
  const eligibleRoutes = (requestedRoutes: string[]): { routes: string[]; skippedRoutes: RouteSkip[] } => {
    const routes: string[] = [];
    const skippedRoutes: RouteSkip[] = [];
    for (const route of requestedRoutes) {
      const svc = state.config.services[route];
      if (!svc) {
        // The MCP tool rejects unknown fanout targets by name; this
        // surface silently skipped them, returning 200 with fewer arms
        // and an empty skippedRoutes. Same input, two answers.
        throw new BadRequestError(
          `Unknown fanout target: ${route}. Valid route ids: ` +
            `${Object.keys(state.config.services).join(", ")}.`,
        );
      }
      const dispatcher = state.dispatchers[route];
      const breaker = state.router.getBreaker(route);
      const policy = evaluateRoutePolicy(route, svc, {
        ...(dispatcher !== undefined ? { dispatcher } : {}),
        circuitBroken: Boolean(breaker?.isTripped),
        ...(parsed.hints.safetyProfile !== undefined
          ? { requestedSafetyProfile: parsed.hints.safetyProfile }
          : {}),
      });
      if (policy.skipped) skippedRoutes.push(policy.skipped);
      if (!policy.blocked) routes.push(route);
    }
    return { routes, skippedRoutes };
  };
  if (parsed.stream) {
    // Resolve fanout targets BEFORE writing SSE headers.
    //
    // eligibleRoutes throws BadRequestError for an unknown route, but it
    // was called after writeHead — so headersSent was true, the error
    // handler could only res.end(), and the caller got HTTP 200 with a
    // zero-byte body. The non-streaming path returns a proper 400 with
    // the valid ids. Same input, two answers, again.
    // Default to every dispatchable route when `models` is omitted,
    // exactly as the non-streaming branch does. Streaming passed
    // parsed.models straight through, so {"mode":"fanout","stream":true}
    // with no models fanned out to ZERO routes and reported success —
    // content "[]", empty skippedRoutes, HTTP 200.
    const preSelected =
      parsed.mode === "fanout"
        ? eligibleRoutes(
            parsed.models.length > 0
              ? parsed.models
              : Object.keys(state.config.services).filter(
                  (route) => route in state.dispatchers,
                ),
          )
        : undefined;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse.started = true;
    if (parsed.mode === "fanout") {
      const selected = preSelected!;
      const rows = await runFanoutArms(state.router, selected.routes, parsed);
      writeSse(res, {
        choices: [
          {
            index: 0,
            delta: {
              content: JSON.stringify(rows),
            },
            finish_reason: null,
          },
        ],
        harness_dispatch: {
          mode: "fanout",
          skippedRoutes: selected.skippedRoutes,
          ...(parsed.workingDirWarning !== undefined
            ? { warning: parsed.workingDirWarning }
            : {}),
        },
      });
    } else {
      for await (const { event, decision } of state.router.stream(
        parsed.prompt,
        parsed.files,
        parsed.workingDir,
        { hints: parsed.hints, maxFallbacks: 2 },
      )) {
        if (event.type === "stdout") {
          writeSse(res, {
            choices: [
              {
                index: 0,
                delta: { content: event.chunk },
                finish_reason: null,
              },
            ],
            harness_dispatch: decision ? { route: decision.service } : undefined,
          });
        } else if (event.type === "completion" && !event.result.success) {
          writeSse(res, {
            error: {
              message: event.result.error ?? "routing failed",
              route: event.result.service,
            },
          });
        }
      }
    }
    writeSse(res, {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (parsed.mode === "fanout") {
    const routes =
      parsed.models.length > 0
        ? parsed.models
        : Object.keys(state.config.services).filter((route) => route in state.dispatchers);
    const selected = eligibleRoutes(routes);
    const rows = await runFanoutArms(state.router, selected.routes, parsed);
    sendJson(
      res,
      200,
      completionEnvelope(
        JSON.stringify(rows, null, 2),
        typeof parsed.hints.model === "string" ? parsed.hints.model : "harness-dispatch",
        {
          harness_dispatch: {
            mode: "fanout",
            skippedRoutes: selected.skippedRoutes,
            ...(parsed.workingDirWarning !== undefined
              ? { warning: parsed.workingDirWarning }
              : {}),
          },
        },
      ),
    );
    return;
  }

  // Backed by a persisted job, not a bare in-process await. This
  // surface's users are curl/CI/cron — exactly the clients that enforce
  // their own request timeouts — and a direct await meant a client that
  // gave up mid-run lost the finished result with no way to retrieve
  // it. The job survives (it runs detached and lands on disk); the
  // jobId is exposed in the response AND in a header so even a caller
  // that only captured headers before timing out can recover the
  // result via `job_status`.
  const { status: jobStatus, completion } = await startAsyncJobTracked(
    { holder },
    {
      prompt: parsed.prompt,
      files: parsed.files,
      workingDir: parsed.workingDir,
      hints: parsed.hints,
    },
  );
  res.setHeader("x-harness-dispatch-job-id", jobStatus.jobId);
  await completion;
  const job = await getAsyncJob(jobStatus.jobId);
  const result = job.result?.result;
  const decision = job.result?.decision ?? undefined;
  if (result === undefined) {
    // Terminal without a result payload: the runner died or was
    // orphaned. The job dir still names what happened.
    sendJson(res, 500, {
      error: `job ${jobStatus.jobId} ended without a result (status: ${job.status.status}); ` +
        `check job_status for details`,
      jobId: jobStatus.jobId,
    });
    return;
  }
  sendJson(
    res,
    200,
    completionEnvelope(result.output, decision?.model ?? parsed.hints.model ?? "harness-dispatch", {
      harness_dispatch: {
        jobId: jobStatus.jobId,
        route: result.service,
        success: result.success,
        error: result.error,
        workspace: result.workspace,
        routing: decision,
        skippedRoutes: decision?.skippedRoutes ?? result.skippedRoutes,
        ...(parsed.workingDirWarning !== undefined
          ? { warning: parsed.workingDirWarning }
          : {}),
      },
    }),
  );
  return;
}


function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startHttpServer(opts: StartHttpOptions = {}): Promise<HttpServerHandle> {
  // buildMcpServer's own `server` is only used for the stdio (one transport,
  // one session, ever) case. HTTP MCP needs a fresh McpServer per session —
  // Protocol.connect() throws if called twice on the same instance — so
  // reuse just the shared runtime state (holder/reloader) here.
  const { holder, reloader } = await buildMcpServer(opts);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const mcpRoute = opts.mcpRoute ?? "/mcp";
  const token = opts.token === undefined ? await ensureHttpToken() : opts.token;

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionServers = new Set<McpServer>();

  const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isAuthorized(req.headers.authorization, token)) return true;
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  };

  // A bare IPv6 host must be bracketed to be legal inside a URL:
  // new URL("/mcp", "http://::1") throws "Invalid URL", which turned EVERY
  // request to a server bound on ::1 into a 500 — the bind succeeded and the
  // loopback check blessed the address, so nothing else ever caught it.
  const urlBase = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}`;

  const http: NodeHttpServer = createServer(async (req, res) => {
    // Shared with handleChatCompletions, read by the catch below.
    const sse: SseState = { started: false };
    try {
      const url = new URL(req.url ?? "/", urlBase);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        if (!requireAuth(req, res)) return;
        await reloader.maybeReload();
        const state = holder.state;
        const status = await buildStatus(
          state.config,
          state.dispatchers,
          state.quota,
          state.router,
          state.leaderboard,
        );
        const created = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
          object: "list",
          data: status.routes.map((route) => ({
            id: route.id,
            object: "model",
            created,
            owned_by: "harness-dispatch",
            harness_dispatch: {
              harness: route.harness,
              enabled: route.enabled,
              available: route.available,
              ready: status.ready.includes(route.id),
              tier: route.tier,
              model: route.model ?? null,
              billingKind: route.billing.kind,
              safetyProfile: route.effectiveSafetyProfile,
              skipped: route.skipped ?? null,
            },
          })),
        });
        return;
      }

      if (url.pathname === "/v1/usage" && req.method === "GET") {
        if (!requireAuth(req, res)) return;
        await reloader.maybeReload();
        const state = holder.state;
        const status = await buildStatus(
          state.config,
          state.dispatchers,
          state.quota,
          state.router,
          state.leaderboard,
        );
        sendJson(res, 200, buildUsage(status));
        return;
      }

      if (url.pathname === "/v1/status" && req.method === "GET") {
        if (!requireAuth(req, res)) return;
        await reloader.maybeReload();
        const state = holder.state;
        sendJson(
          res,
          200,
          await buildStatus(
            state.config,
            state.dispatchers,
            state.quota,
            state.router,
            state.leaderboard,
          ),
        );
        return;
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        if (!requireAuth(req, res)) return;
        await reloader.maybeReload();
        const parsed = parseChatRequest(await readJson(req));
        await handleChatCompletions(holder, parsed, res, sse);
        return;
      }

      if (url.pathname === mcpRoute) {
        if (!requireAuth(req, res)) return;
        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
        } else {
          const sessionServer = buildMcpServerInstance(holder, reloader);
          sessionServers.add(sessionServer);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });
          // Bookkeeping only — do NOT call sessionServer.close() here.
          // McpServer.close() -> Protocol.close() -> transport.close() again,
          // and transport.close() calls this same onclose handler, so doing
          // so recurses infinitely. The SDK's connect() already wraps
          // whatever onclose was set before it ran with its own internal
          // Protocol cleanup, so closing the transport (whether client-
          // initiated or via our shutdown path below) is sufficient on its
          // own to tear down sessionServer's Protocol-side state too.
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
            sessionServers.delete(sessionServer);
          };
          await sessionServer.connect(transport as unknown as Transport);
        }
        await transport.handleRequest(req, res);
        return;
      }

      sendText(res, 404, "not found");
    } catch (err) {
      if (sse.started) {
        // Mid-stream failure: the client already holds a 200 and possibly
        // partial frames, and a bare end() made a truncated stream
        // indistinguishable from a complete one. Emit an error frame and the
        // stream terminator so the caller can tell.
        try {
          writeSse(res, { error: { message: err instanceof Error ? err.message : String(err) } });
          res.write("data: [DONE]\n\n");
        } catch {
          // Socket already gone; nothing left to tell it.
        }
        res.end();
      } else if (!res.headersSent) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
        } else if (err instanceof BadRequestError) {
          sendJson(res, 400, { error: err.message });
        } else {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    http.listen(port, host, () => resolve());
  });
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  if (!isLoopbackHost(host)) {
    process.stderr.write(
      `WARNING: harness-dispatch is binding to ${host}, not loopback. This exposes ` +
        `a bearer-token-gated server — and everything the dispatched harness can ` +
        `do (spawn CLIs, read/write files in workingDir) — to your network, not ` +
        `just this machine. Only do this if you specifically intend to reach it ` +
        `from another host.\n`,
    );
  }

  return {
    port: actualPort,
    host,
    token,
    async close() {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          // best effort
        }
      }
      transports.clear();
      for (const sessionServer of sessionServers) {
        try {
          await sessionServer.close();
        } catch {
          // best effort
        }
      }
      sessionServers.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export const startMcpHttpServer = startHttpServer;
