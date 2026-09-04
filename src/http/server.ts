import { randomUUID } from "node:crypto";
import { redact } from "../redaction.js";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { ensureHttpToken, httpTokenMtimeMs, isAuthorized, readHttpTokenSync } from "../auth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildMcpServer,
  buildMcpServerInstance,
  type BuildMcpOptions,
  type McpHandle,
} from "../mcp/server.js";
import { createAnswerStream } from "./answer-stream.js";
import { buildStatus, buildUsage } from "../status.js";
import { VERSION } from "../version.js";
import type { RouteHints, RouteSkip } from "../types.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { getAsyncJob, orphanStrandedSlotQueue, startAsyncJobTracked } from "../jobs.js";
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
  /** Live per-session MCP servers. See the implementation for why it is exposed. */
  openMcpSessions: () => number;
}

export interface StartHttpOptions extends BuildMcpOptions {
  port?: number;
  host?: string;
  mcpRoute?: string;
  token?: string | null;
}


function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  // Sink: every JSON response leaves over the wire.
  const text = redact(JSON.stringify(body, null, 2));
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
 * Run fanout arms to completion INDEPENDENTLY of one another, and DURABLY.
 *
 * Promise.all rejected the whole batch when one arm threw (workspace lock
 * timeout, worktree setup failure), discarding every other arm's completed —
 * and possibly billed — work behind a single 500. Each arm now settles on its
 * own; a thrown arm becomes a failed row naming its route. One row shape for
 * the streaming and non-streaming branches on purpose: they used to differ
 * (streaming omitted success/error), the one-sibling-guarded pattern again.
 *
 * JOB-BACKED, like the MCP fanout. These arms called `router.routeTo`
 * directly, so an arm's work existed ONLY inside the HTTP request: no job
 * directory, no manifest, no partial log. Kill the client — or the server —
 * mid-fanout and every arm's output was gone, with nothing on disk to salvage.
 * PRODUCT.md names that as the defining failure ("a wasted attempt with no
 * trail"), and the MCP surface had been durable all along; an acceptance pass
 * caught the two surfaces disagreeing about the product's central promise.
 *
 * The RESPONSE SHAPE IS UNCHANGED. This awaits each arm's completion and
 * returns the same rows it always did, so an OpenAI-compatible client sees
 * exactly what it saw before — durability was never a contract change, which
 * is what made deferring this to a breaking release the wrong call. The one
 * addition is `jobId` per row: additive, inside the `harness_dispatch`
 * extension namespace, and the thing that makes salvage possible at all.
 */
async function runFanoutArms(
  holder: RuntimeHolder,
  routes: string[],
  parsed: { prompt: string; files: string[]; workingDir: string; hints: RouteHints },
): Promise<
  Array<{
    route: string;
    jobId?: string;
    success: boolean;
    output: string;
    error?: string;
    workspace?: unknown;
  }>
> {
  const settled = await Promise.allSettled(
    routes.map(async (route) => {
      const started = await startAsyncJobTracked(
        { holder },
        {
          prompt: parsed.prompt,
          files: parsed.files,
          workingDir: parsed.workingDir,
          hints: parsed.hints,
          service: route,
        },
      );
      // `completion` never rejects and resolves on a terminal state, so the
      // await below cannot hang on a crashed arm.
      await started.completion;
      return { route, job: await getAsyncJob(started.status.jobId) };
    }),
  );
  return settled.map((s, i) => {
    if (s.status === "fulfilled") {
      const { route, job } = s.value;
      const r = job.result?.result;
      return {
        route,
        jobId: job.status.jobId,
        success: r?.success ?? false,
        // A job that ended without a result still hands back whatever it got
        // to — the same salvage rule the orphan path follows.
        output: r?.output ?? job.partialOutput ?? "",
        ...(r?.error !== undefined
          ? { error: r.error }
          : job.status.error !== undefined
            ? { error: job.status.error }
            : {}),
        ...(r?.workspace !== undefined ? { workspace: r.workspace } : {}),
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
      // routePolicy is the half that decides ELIGIBILITY — local_only,
      // approval_required and blocked are enforced here, not in routeTo. It
      // was omitted, so a fanout arm ran whatever the policy forbade.
      const policy = evaluateRoutePolicy(route, svc, {
        ...(dispatcher !== undefined ? { dispatcher } : {}),
        circuitBroken: Boolean(breaker?.isTripped),
        ...(parsed.hints.safetyProfile !== undefined
          ? { requestedSafetyProfile: parsed.hints.safetyProfile }
          : {}),
        ...(parsed.hints.routePolicy !== undefined
          ? { routePolicy: parsed.hints.routePolicy }
          : {}),
        // Same refusal as every other surface: an HTTP endpoint route cannot
        // carry an `execute` task. Omitted here, this surface would keep
        // routing execution to endpoints after the others stopped.
        ...(parsed.hints.taskType !== undefined ? { taskType: parsed.hints.taskType } : {}),
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
    // Refuse BEFORE writeHead, while a real status code is still available.
    //
    // The non-streaming branch has the same check; this one is here rather
    // than beside it because once the 200 and the SSE headers are out, the
    // only way to report a refusal is an error frame inside a successful
    // stream — which is exactly the "vacuously true" shape being fixed.
    if (preSelected !== undefined && preSelected.routes.length === 0) {
      const why = preSelected.skippedRoutes.map((s) => `${s.route} (${s.code}): ${s.message}`).join("; ");
      sendJson(res, 400, {
        error: {
          message:
            `No fanout route can run this request${why ? ` — ${why}` : ""}. ` +
            `Check /v1/usage for route readiness, or adjust models/safetyProfile/routePolicy.`,
          type: "invalid_request_error",
        },
        // Structured as well as prose: a caller that was reading
        // `skippedRoutes` off the old 200 keeps its machine-readable reason.
        harness_dispatch: { mode: "fanout", skippedRoutes: preSelected.skippedRoutes },
      });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse.started = true;
    if (parsed.mode === "fanout") {
      const selected = preSelected!;
      const rows = await runFanoutArms(holder, selected.routes, parsed);
      writeSse(
        res,
        sseContent(JSON.stringify(rows), {
          harness_dispatch: {
            mode: "fanout",
            skippedRoutes: selected.skippedRoutes,
            ...(parsed.workingDirWarning !== undefined
              ? { warning: parsed.workingDirWarning }
              : {}),
          },
        }),
      );
    } else {
      // What reaches `delta.content` must be the ANSWER.
      //
      // This forwarded every stdout chunk, so a client concatenating deltas
      // from a CLI harness received protocol JSONL and internal thread ids —
      // `{"type":"thread.started",...}` — while the non-streaming call on this
      // same endpoint returned "pong". Two answers to one question, and the
      // streaming one was unusable by the clients this envelope exists for.
      //
      // An endpoint route streams real assistant text and marks it `text`;
      // those chunks go out as they arrive, which is what streaming is for. A
      // CLI harness produces protocol on stdout and its answer only once
      // parsed, so it is sent at completion. Never both, or the answer would
      // arrive twice.
      const answer = createAnswerStream();
      let succeeded = false;
      let pendingFailure: { error: { message: string; route: string } } | undefined;
      // Stop the run when the caller hangs up.
      //
      // Nothing connected the client's disconnect to the dispatch, so an
      // aborted stream left the harness running to completion — measured
      // still producing output twelve seconds after the client went away.
      // This is the ONE dispatch path with no job record, so there is also no
      // `jobId` to cancel it with: on a CLI route that means an agent with
      // file access still working in the user's directory for a caller that
      // no longer exists. OPERATIONS.md claimed "the run is lost with the
      // connection"; it was not lost, it was unsupervised.
      //
      // `close` fires on normal completion too, hence the `writableEnded`
      // guard — aborting a finished response would cancel nothing but would
      // make every clean stream look like a cancellation in the logs.
      const clientGone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) clientGone.abort();
      });
      for await (const { event, decision } of state.router.stream(
        parsed.prompt,
        parsed.files,
        parsed.workingDir,
        { hints: parsed.hints, maxFallbacks: 2, signal: clientGone.signal },
      )) {
        const text = answer.next(event);
        if (text !== undefined) {
          writeSse(
            res,
            sseContent(text, {
              harness_dispatch: decision ? { route: decision.service } : undefined,
            }),
          );
        }
        if (event.type === "completion" && event.result.success) succeeded = true;
        if (event.type === "completion" && !event.result.success) {
          const frame = {
            error: {
              message: event.result.error ?? "routing failed",
              route: event.result.service,
            },
          };
          // Once any answer text has gone out, this response is committed to
          // that route: a fallback's answer cannot be spliced onto a half-sent
          // one without garbling it, and the previous behaviour ran the
          // fallback anyway and discarded what it produced — billed, and
          // thrown away. Stop instead. Breaking here ends the router's
          // iteration, so no further route is attempted.
          if (answer.committed) {
            writeSse(res, frame);
            break;
          }
          // Not committed, so the router is about to try another route. The
          // frame was written HERE, before that happened — so a request that
          // then succeeded on the fallback still carried an `error` frame,
          // ahead of the answer. The OpenAI streaming contract has no
          // non-fatal error frame, so a client that treats one as terminal
          // reported a failure for a request that worked. Reproduced by an
          // acceptance pass. Held until the end, and sent only if nothing
          // ever succeeded.
          pendingFailure = frame;
        }
      }
      // Nothing recovered it, so the failure was the outcome after all.
      if (!succeeded && pendingFailure !== undefined) writeSse(res, pendingFailure);
    }
    writeSse(res, sseStop());
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
    // An empty candidate set is a REFUSAL, not an empty success.
    //
    // This answered 200 with `"[]"` as the content — vacuously true over zero
    // arms, on the surface PRODUCT.md points CI and cron at, which read 200 as
    // "it worked". MCP already refuses the identical input by name. The
    // no-`models` sub-case of this class was closed earlier; the
    // empty-ELIGIBLE-SET case beside it was not, which is the same defect one
    // branch over. Same wording as the MCP path, so the two surfaces answer
    // one question one way.
    if (selected.routes.length === 0) {
      const why = selected.skippedRoutes.map((s) => `${s.route} (${s.code}): ${s.message}`).join("; ");
      sendJson(res, 400, {
        error: {
          message:
            `No fanout route can run this request${why ? ` — ${why}` : ""}. ` +
            `Check /v1/usage for route readiness, or adjust models/safetyProfile/routePolicy.`,
          type: "invalid_request_error",
        },
        harness_dispatch: { mode: "fanout", skippedRoutes: selected.skippedRoutes },
      });
      return;
    }
    const rows = await runFanoutArms(holder, selected.routes, parsed);
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


/**
 * One SSE content frame.
 *
 * The `choices[0].delta` envelope is what an OpenAI-compatible client parses,
 * and it was written out as a literal at three call sites — which is both how
 * the deepest nesting in this file appeared (a data shape indented under a
 * loop inside a branch) and how the streaming and non-streaming fanout
 * replies drifted apart in the first place. Built in one place now.
 */
function sseContent(content: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...(extra ?? {}),
  };
}

/** The terminal frame every stream ends with, before `[DONE]`. */
function sseStop(): Record<string, unknown> {
  return { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
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
  // An explicitly supplied token is fixed for the life of the server (tests
  // pass one, and a caller who hands us a value did not ask us to go looking
  // for another). Otherwise the token is whatever is on disk NOW: it was read
  // once at startup and held forever, which made `auth rotate` a lie in both
  // directions — the old token kept working and the new one was refused.
  // Re-read only when the file's mtime moves, so the common path is a stat.
  const fixedToken = opts.token;
  let diskToken = fixedToken === undefined ? await ensureHttpToken() : fixedToken;
  let seenMtimeMs = fixedToken === undefined ? httpTokenMtimeMs() : 0;
  const activeToken = (): string | null => {
    if (fixedToken !== undefined) return fixedToken;
    const mtime = httpTokenMtimeMs();
    if (mtime !== seenMtimeMs) {
      seenMtimeMs = mtime;
      diskToken = readHttpTokenSync() ?? diskToken;
    }
    return diskToken;
  };
  const token = diskToken;

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionServers = new Set<McpServer>();
  /** Last time each live session was used, for the idle sweep below. */
  const sessionLastSeen = new Map<string, number>();

  /**
   * How long an MCP session may sit unused before it is closed.
   *
   * Sessions were never expired or capped. `transports` is pruned only by
   * `transport.onclose`, and the SDK fires that only on an explicit HTTP
   * DELETE — which `StreamableHTTPClientTransport.close()` does not send. So a
   * client that shuts down cleanly left its session, and its whole `McpServer`
   * instance, resident for the lifetime of the process. This surface exists
   * for CI, cron and scripts, i.e. exactly the callers that connect and go.
   *
   * Thirty minutes is far longer than any dispatch grace window, so it cannot
   * reap a session a caller is still polling on.
   */
  const SESSION_IDLE_MS = 30 * 60_000;

  /**
   * Close sessions idle past the ceiling. Runs on request rather than on a
   * timer, deliberately: an interval would keep the process alive and need
   * unref'ing plus teardown, for a sweep that only matters when requests are
   * arriving anyway.
   */
  const sweepIdleSessions = (): void => {
    const now = Date.now();
    for (const [sid, seen] of sessionLastSeen) {
      if (now - seen <= SESSION_IDLE_MS) continue;
      sessionLastSeen.delete(sid);
      const idle = transports.get(sid);
      // close() fires onclose, which removes it from `transports` and drops
      // the McpServer from `sessionServers`.
      void idle?.close().catch(() => undefined);
    }
  };

  const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isAuthorized(req.headers.authorization, activeToken())) return true;
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

      // Liveness, and the ONLY route served without a token.
      //
      // Every other endpoint is authenticated, which meant a deploy gate or a
      // container probe could not ask whether the process was up without being
      // handed a credential — and a health check that needs a secret is one
      // most orchestrators simply will not perform. `/v1/status` answers a
      // richer question (routes, quota, breaker state) and stays behind the
      // token precisely because that answer is not for strangers.
      //
      // What it discloses is bounded on purpose: that this is harness-dispatch,
      // that it is running, and which version. No route ids, no endpoints, no
      // quota, no config, no token. Version is here because verifying which
      // build is live is the second thing an operator asks after "is it up",
      // and it is already public in the npm registry, `--version`, and the MCP
      // handshake. If that is more than you want exposed, bind to loopback —
      // which is the default.
      if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        if (req.method === "HEAD") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end();
          return;
        }
        sendJson(res, 200, { status: "ok", service: "harness-dispatch", version: VERSION });
        return;
      }

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
        sweepIdleSessions();
        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
        let transport: StreamableHTTPServerTransport;
        // Held so the post-request check below can dispose of a server whose
        // session never came into existence.
        let freshServer: McpServer | undefined;
        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
          sessionLastSeen.set(sessionId, Date.now());
        } else {
          const sessionServer = buildMcpServerInstance(holder, reloader);
          freshServer = sessionServer;
          sessionServers.add(sessionServer);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
              sessionLastSeen.set(sid, Date.now());
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
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              sessionLastSeen.delete(transport.sessionId);
            }
            sessionServers.delete(sessionServer);
          };
          await sessionServer.connect(transport as unknown as Transport);
        }
        await transport.handleRequest(req, res);
        // A session that never came into existence still left a server behind.
        //
        // The McpServer and transport are built BEFORE it is known whether
        // this is an `initialize`. For anything else with an unknown session
        // id the SDK answers 400 without initialising, so
        // `onsessioninitialized` never fires (nothing enters `transports`) and
        // `onclose` never fires (nothing leaves `sessionServers`). Measured:
        // five POSTs with unknown session ids left five orphaned servers alive
        // until shutdown. Anyone can trigger it with a wrong header, and the
        // auth check above does not help — a valid token is enough.
        if (freshServer !== undefined && transport.sessionId === undefined) {
          sessionServers.delete(freshServer);
          await freshServer.close().catch(() => undefined);
        }
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

  // A listen failure arrives as an 'error' EVENT, not a rejected call, so with
  // no handler Node rethrew it from the event loop: `serve --port <busy>`
  // printed a raw `node:events:486 throw er; // Unhandled 'error' event`
  // stack trace. Every other bad-input path in this CLI answers with one
  // actionable line, and a port already in use is the most ordinary of them.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      const where = `${host}:${port}`;
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use on ${host} — another harness-dispatch, or ` +
              `something else. Pass a different --port, or omit --port to take any free one.`,
          ),
        );
      } else if (err.code === "EACCES") {
        // Do NOT assert privileges here. The first version said "ports below
        // 1024 need elevated privileges" for EVERY EACCES, and on Windows a
        // HIGH port is refused just as often — the OS reserves whole ranges
        // (Hyper-V, WinNAT, `netsh interface ipv4 show excludedportrange`),
        // where elevation changes nothing. Naming a cause that does not apply
        // sends people to fix the wrong thing, which is worse than the stack
        // trace this replaced.
        reject(
          new Error(
            `not permitted to bind ${where}. Below 1024 that means elevated privileges are ` +
              `needed; above it, the OS has usually reserved the port (on Windows check ` +
              `\`netsh interface ipv4 show excludedportrange protocol=tcp\`). Either way, ` +
              `another --port is the quick answer.`,
          ),
        );
      } else if (err.code === "EADDRNOTAVAIL") {
        reject(new Error(`cannot bind ${where} — no interface on this machine has that address.`));
      } else {
        reject(new Error(`could not bind ${where}: ${err.message}`));
      }
    };
    http.once("error", onError);
    http.listen(port, host, () => {
      http.removeListener("error", onError);
      resolve();
    });
  });
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  // Same reason as the stdio entry point: jobs left waiting for a concurrency
  // slot when a server died are drained by nothing until a new dispatch
  // happens to arrive, and unlike a running job they are exempt from orphan
  // detection, so they simply read `queued` forever. Not awaited and never
  // fatal — the server must still serve.
  void orphanStrandedSlotQueue().catch(() => undefined);

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
    /**
     * How many per-session MCP servers are alive.
     *
     * Exposed because a leak here is invisible from outside: a request that
     * never initialises a session used to leave its `McpServer` resident with
     * nothing to observe it by. There is no other seam — the count lives in a
     * closure — and a test that reimplemented the bookkeeping would pin its
     * own copy rather than this one.
     */
    openMcpSessions: () => sessionServers.size,
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
