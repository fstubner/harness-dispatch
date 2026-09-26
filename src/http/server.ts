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
  newStreamIdentity,
  parseChatRequest,
  PayloadTooLargeError,
  readJson,
  type StreamIdentity,
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
 * Each arm settles on its own (`Promise.allSettled`): with `Promise.all`, one
 * arm throwing — workspace lock timeout, worktree setup failure — discards
 * every other arm's completed, possibly billed, work behind a single 500. A
 * thrown arm becomes a failed row naming its route. One row shape for the
 * streaming and non-streaming branches, so the two cannot drift.
 *
 * JOB-BACKED, like the MCP fanout. Calling `router.routeTo` directly would
 * leave an arm's work existing ONLY inside the HTTP request: no job directory,
 * no manifest, no partial log, and nothing on disk to salvage if the client or
 * the server dies mid-fanout. `jobId` per row, inside the `harness_dispatch`
 * extension namespace, is what makes that salvage possible.
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
 * POST /v1/chat/completions. Kept out of the request callback so the branching
 * here does not sit eleven brace-levels deep.
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
        // Rejected by name, matching the MCP tool. Skipping it would answer
        // 200 with fewer arms and an empty skippedRoutes — one input, two
        // surfaces, two answers.
        throw new BadRequestError(
          `Unknown fanout target: ${route}. Valid route ids: ` +
            `${Object.keys(state.config.services).join(", ")}.`,
        );
      }
      const dispatcher = state.dispatchers[route];
      const breaker = state.router.getBreaker(route);
      // routePolicy is the half that decides ELIGIBILITY — local_only,
      // approval_required and blocked are enforced here, not in routeTo, so
      // omitting it lets a fanout arm run whatever the policy forbids.
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
        // carry an `execute` task.
        ...(parsed.hints.taskType !== undefined ? { taskType: parsed.hints.taskType } : {}),
      });
      if (policy.skipped) skippedRoutes.push(policy.skipped);
      if (!policy.blocked) routes.push(route);
    }
    return { routes, skippedRoutes };
  };
  if (parsed.stream) {
    // Resolve fanout targets BEFORE writing SSE headers: eligibleRoutes throws
    // BadRequestError for an unknown route, and after writeHead the error
    // handler can only res.end(), leaving the caller an HTTP 200 with a
    // zero-byte body instead of the 400 the non-streaming path returns.
    //
    // Defaults to every dispatchable route when `models` is omitted, exactly
    // as the non-streaming branch does; passing parsed.models straight through
    // would fan out to ZERO routes and report success.
    const preSelected =
      parsed.mode === "fanout"
        ? eligibleRoutes(
            parsed.models.length > 0
              ? parsed.models
              : Object.keys(state.config.services).filter((route) =>
                  // `Object.hasOwn`, not `in` — same prototype-chain hazard as
                  // the non-streaming branch below.
                  Object.hasOwn(state.dispatchers, route),
                ),
          )
        : undefined;
    // Refuse BEFORE writeHead, while a real status code is still available:
    // once the 200 and the SSE headers are out, the only way to report a
    // refusal is an error frame inside a successful stream. The non-streaming
    // branch makes the same check at its own point.
    if (preSelected !== undefined && preSelected.routes.length === 0) {
      const why = preSelected.skippedRoutes.map((s) => `${s.route} (${s.code}): ${s.message}`).join("; ");
      sendJson(res, 400, {
        error: {
          message:
            `No fanout route can run this request${why ? ` — ${why}` : ""}. ` +
            `Check /v1/usage for route readiness, or adjust models/safetyProfile/routePolicy.`,
          type: "invalid_request_error",
        },
        // Structured as well as prose, so a caller reading `skippedRoutes`
        // still has a machine-readable reason.
        harness_dispatch: { mode: "fanout", skippedRoutes: preSelected.skippedRoutes },
      });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Send the headers NOW, not when the first chunk happens to arrive.
    //
    // For a CLI harness no delta exists until the run completes, so otherwise
    // nothing reaches the client — not even the status line — for as long as
    // the run takes. Any client or proxy with a response-header timeout gives
    // up on a live stream, and a streaming request creates no job record, so
    // there is no jobId to recover with.
    res.flushHeaders();
    sse.started = true;
    // One identity for the whole stream, minted before the first frame: every
    // chunk must repeat the same `id` and `created`, or a client that groups
    // or dedupes by id sees one response per frame. The model starts as what
    // the caller asked for and is filled in below once the router has picked a
    // route.
    const identity = newStreamIdentity(parsed.hints.model ?? "harness-dispatch");
    if (parsed.mode === "fanout") {
      const selected = preSelected!;
      const rows = await runFanoutArms(holder, selected.routes, parsed);
      writeSse(
        res,
        sseContent(identity, JSON.stringify(rows), {
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
      // What reaches `delta.content` must be the ANSWER. Forwarding every
      // stdout chunk would hand a client concatenating deltas from a CLI
      // harness protocol JSONL and internal thread ids, while the
      // non-streaming call on this same endpoint returns the answer text.
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
      // Without this an aborted stream leaves the harness running to
      // completion. This is the ONE dispatch path with no job record, so there
      // is also no `jobId` to cancel it with: on a CLI route that means an
      // agent with file access still working in the user's directory for a
      // caller that no longer exists.
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
        // Filled in before the first frame goes out, so the whole stream names
        // the model the picked route actually runs.
        if (decision?.model !== undefined) identity.model = decision.model;
        const text = answer.next(event);
        if (text !== undefined) {
          writeSse(
            res,
            sseContent(identity, text, {
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
          // one without garbling it, and running the fallback only to discard
          // its output means paying for work nobody sees. Breaking here ends
          // the router's iteration, so no further route is attempted.
          if (answer.committed) {
            writeSse(res, frame);
            break;
          }
          // Not committed, so the router is about to try another route. The
          // OpenAI streaming contract has no non-fatal error frame, so
          // writing one here would make a client that treats it as terminal
          // report a failure for a request the fallback went on to answer.
          // Held until the end, and sent only if nothing ever succeeded.
          pendingFailure = frame;
        }
      }
      // Nothing recovered it, so the failure was the outcome after all.
      if (!succeeded && pendingFailure !== undefined) writeSse(res, pendingFailure);
    }
    writeSse(res, sseStop(identity));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (parsed.mode === "fanout") {
    const routes =
      parsed.models.length > 0
        ? parsed.models
        : Object.keys(state.config.services).filter((route) =>
            // `Object.hasOwn`, not `in` — the same prototype-chain hazard the
            // service guards carry. Here the names come from config, so it
            // takes a route literally named `constructor` in config.yaml,
            // which would then be treated as having a dispatcher it never got.
            Object.hasOwn(state.dispatchers, route),
          );
    const selected = eligibleRoutes(routes);
    // An empty candidate set is a REFUSAL, not an empty success: 200 with
    // `"[]"` as the content is vacuously true over zero arms, and CI and cron
    // read 200 as "it worked". Same wording as the MCP path, which refuses the
    // identical input, so the two surfaces answer one question one way.
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

  // Backed by a persisted job, not a bare in-process await. This surface's
  // users are curl/CI/cron — exactly the clients that enforce their own
  // request timeouts — and with a direct await a client that gives up mid-run
  // loses the finished result. The job survives (it runs detached and lands on
  // disk); the jobId is exposed in the response AND in a header so even a
  // caller that only captured headers before timing out can recover the result
  // via `job_status`.
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
  // A dispatch that FAILED is not a 200 — same rule as the fanout branch
  // above. Serving the error text as the assistant's answer with
  // `finish_reason: "stop"` leaves the failure visible only in the vendor
  // extension.
  //
  // 502: the router worked, the harness it delegated to did not.
  const status = result.success ? 200 : 502;
  sendJson(
    res,
    status,
    completionEnvelope(result.output, decision?.model ?? parsed.hints.model ?? "harness-dispatch", {
      // The status above is 502 on a failure, and the body must not contradict
      // it: a plain completion — empty content, `finish_reason: "stop"` — with
      // the reason buried in the vendor extension reads as an empty successful
      // answer to a client that takes the body before the status. `error` is
      // where an OpenAI-compatible client looks, and it is absent on success.
      ...(result.success
        ? {}
        : {
            error: {
              message: result.error ?? "the route this was delegated to failed",
              type: "upstream_error",
              route: result.service,
            },
          }),
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
 * The `choices[0].delta` envelope is what an OpenAI-compatible client parses.
 * Built in one place rather than as a literal at each call site, which is how
 * the streaming and non-streaming replies drift apart.
 *
 * `id`, `object` and `created` are REQUIRED on a streamed chunk: a client that
 * reads `chunk.id`, or asserts `object === "chat.completion.chunk"` before
 * parsing, gets `undefined` without them, while the non-streaming envelope
 * sends them. `object` is the chunk type, NOT "chat.completion": they are
 * different shapes (`delta` versus `message`) and a client switches on exactly
 * this field to know which it is holding.
 */
function sseContent(
  identity: StreamIdentity,
  content: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...(extra ?? {}),
  };
}

/**
 * The terminal frame every stream ends with, before `[DONE]`.
 *
 * Carries the same identity as the content frames: this is the frame a client
 * attributes `finish_reason` to, so an id that did not match the chunks it
 * terminates would leave that verdict belonging to nothing.
 */
function sseStop(identity: StreamIdentity): Record<string, unknown> {
  return {
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

// Sink. An SSE frame IS an HTTP response, so it redacts like `sendJson` above;
// without it the same request would leak with `stream: true` and be clean with
// `stream: false`. Fed by answer chunks, the fanout row dump, and the error
// frames.
function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${redact(JSON.stringify(payload))}\n\n`);
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
  // An explicitly supplied token is fixed for the life of the server (a caller
  // who hands us a value did not ask us to go looking for another). Otherwise
  // the token is whatever is on disk NOW, so `auth rotate` takes effect
  // instead of leaving the old token working and the new one refused. Re-read
  // only when the file's mtime moves, so the common path is a stat.
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
   * `transports` is pruned only by `transport.onclose`, and the SDK fires that
   * only on an explicit HTTP DELETE — which
   * `StreamableHTTPClientTransport.close()` does not send. So without a sweep,
   * a client that shuts down cleanly leaves its session, and its whole
   * `McpServer` instance, resident for the lifetime of the process. This
   * surface exists for CI, cron and scripts, i.e. exactly the callers that
   * connect and go.
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
  // new URL("/mcp", "http://::1") throws "Invalid URL", which turns EVERY
  // request to a server bound on ::1 into a 500 — the bind succeeds and the
  // loopback check blesses the address, so nothing else catches it.
  const urlBase = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}`;

  const http: NodeHttpServer = createServer(async (req, res) => {
    // Shared with handleChatCompletions, read by the catch below.
    const sse: SseState = { started: false };
    try {
      const url = new URL(req.url ?? "/", urlBase);

      // Liveness, and the ONLY route served without a token: a health check
      // that needs a secret is one most orchestrators will not perform.
      // `/v1/status` answers a richer question (routes, quota, breaker state)
      // and stays behind the token precisely because that answer is not for
      // strangers.
      //
      // What it discloses is bounded on purpose: that this is
      // harness-dispatch, that it is running, and which version. No route ids,
      // no endpoints, no quota, no config, no token. The version is already
      // public in the npm registry, `--version` and the MCP handshake; if that
      // is more than you want exposed, bind to loopback, which is the default.
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
          // Bookkeeping only — do NOT call sessionServer.close() here:
          // McpServer.close() -> Protocol.close() -> transport.close(), which
          // calls this same handler, recursing infinitely. connect() already
          // wraps whatever onclose was set before it with the SDK's own
          // Protocol cleanup, so closing the transport tears down
          // sessionServer's Protocol-side state too.
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              sessionLastSeen.delete(transport.sessionId);
            }
            sessionServers.delete(sessionServer);
          };
          await sessionServer.connect(transport as unknown as Transport);
        }
        // The body is read HERE, under the same size limit as the REST routes,
        // and handed over parsed. Left to the SDK, it read any size at all:
        // measured, a 40 MiB POST was accepted on /mcp while REST answered 413.
        const body = req.method === "POST" ? await readJson(req) : undefined;
        await transport.handleRequest(req, res, body);
        // Dispose of a server whose session never came into existence.
        //
        // The McpServer and transport are built BEFORE it is known whether
        // this is an `initialize`. For anything else with an unknown session
        // id the SDK answers 400 without initialising, so
        // `onsessioninitialized` never fires (nothing enters `transports`) and
        // `onclose` never fires (nothing leaves `sessionServers`) — one
        // orphaned server per POST with a wrong session header, which a valid
        // token is enough to send.
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
        // partial frames, and a bare end() would make a truncated stream
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
  // no handler Node rethrows it from the event loop as a raw stack trace.
  // Every other bad-input path in this CLI answers with one actionable line,
  // and a port already in use is the most ordinary of them.
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
        // Do NOT assert privileges here. On Windows a HIGH port is refused
        // just as often — the OS reserves whole ranges (Hyper-V, WinNAT,
        // `netsh interface ipv4 show excludedportrange`), where elevation
        // changes nothing, and naming a cause that does not apply sends people
        // to fix the wrong thing.
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
  // slot when a server died are exempt from orphan detection, so nothing
  // drains them and they read `queued` forever. Not awaited and never fatal —
  // the server must still serve.
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
     * Exposed because a leak here is otherwise invisible from outside: the
     * count lives in a closure, and a test that reimplemented the bookkeeping
     * would pin its own copy rather than this one.
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
