import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { ensureHttpToken, isAuthorized } from "../auth.js";
import { buildMcpServer, type BuildMcpOptions, type McpHandle } from "../mcp/server.js";
import { buildStatus, buildUsage } from "../status.js";
import type { RouteHints, RouteSkip, WorkspacePolicy } from "../types.js";
import { evaluateRoutePolicy } from "../route-policy.js";
import { isIsolatedWorkspacePolicy } from "../workspaces.js";
import { resolveWorkingDir, workingDirWarning } from "../working-dir.js";

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

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  prompt?: unknown;
  stream?: unknown;
  workingDir?: unknown;
  files?: unknown;
  mode?: unknown;
  models?: unknown;
  hints?: unknown;
  safetyProfile?: unknown;
  workspacePolicy?: unknown;
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim() ? JSON.parse(text) : {};
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesToPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return (messages as ChatMessage[])
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "user";
      const text = contentToText(message.content);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function parseHints(body: ChatRequest): RouteHints {
  const hints: RouteHints = {};
  if (typeof body.model === "string" && body.model !== "") hints.model = body.model;
  if (
    body.safetyProfile === "read_only" ||
    body.safetyProfile === "workspace_edit" ||
    body.safetyProfile === "full_auto"
  ) {
    hints.safetyProfile = body.safetyProfile;
  }
  if (body.hints && typeof body.hints === "object") {
    const raw = body.hints as Record<string, unknown>;
    if (typeof raw.model === "string") hints.model = raw.model;
    if (
      raw.taskType === "execute" ||
      raw.taskType === "plan" ||
      raw.taskType === "review" ||
      raw.taskType === "local"
    ) {
      hints.taskType = raw.taskType;
    }
    if (typeof raw.preferLargeContext === "boolean") {
      hints.preferLargeContext = raw.preferLargeContext;
    }
    if (
      raw.safetyProfile === "read_only" ||
      raw.safetyProfile === "workspace_edit" ||
      raw.safetyProfile === "full_auto"
    ) {
      hints.safetyProfile = raw.safetyProfile;
    }
    if (
      raw.workspacePolicy === "shared" ||
      raw.workspacePolicy === "shared_locked" ||
      raw.workspacePolicy === "copy" ||
      raw.workspacePolicy === "git_worktree"
    ) {
      hints.workspacePolicy = raw.workspacePolicy;
    }
  }
  if (
    body.workspacePolicy === "shared" ||
    body.workspacePolicy === "shared_locked" ||
    body.workspacePolicy === "copy" ||
    body.workspacePolicy === "git_worktree"
  ) {
    hints.workspacePolicy = body.workspacePolicy;
  }
  return hints;
}

function parseChatRequest(raw: unknown): {
  prompt: string;
  files: string[];
  workingDir: string;
  workingDirWarning?: string;
  stream: boolean;
  mode: "single" | "fanout";
  models: string[];
  hints: RouteHints;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("request body must be a JSON object");
  }
  const body = raw as ChatRequest;
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt
      : messagesToPrompt(body.messages);
  if (!prompt.trim()) throw new Error("messages or prompt is required");
  const files = Array.isArray(body.files)
    ? body.files.filter((v): v is string => typeof v === "string")
    : [];
  const models = Array.isArray(body.models)
    ? body.models.filter((v): v is string => typeof v === "string")
    : [];
  const resolvedWorkingDir = resolveWorkingDir(
    typeof body.workingDir === "string" ? body.workingDir : undefined,
  );
  const warning = workingDirWarning(resolvedWorkingDir);
  return {
    prompt,
    files,
    workingDir: resolvedWorkingDir.workingDir,
    ...(warning !== undefined ? { workingDirWarning: warning } : {}),
    stream: body.stream === true,
    mode: body.mode === "fanout" ? "fanout" : "single",
    models,
    hints: parseHints(body),
  };
}

function completionEnvelope(
  content: string,
  model: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...extra,
  };
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startHttpServer(opts: StartHttpOptions = {}): Promise<HttpServerHandle> {
  const { server, holder, reloader } = await buildMcpServer(opts);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const mcpRoute = opts.mcpRoute ?? "/mcp";
  const token = opts.token === undefined ? await ensureHttpToken() : opts.token;

  const transports = new Map<string, StreamableHTTPServerTransport>();
  let connected = false;

  const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isAuthorized(req.headers.authorization, token)) return true;
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  };

  const http: NodeHttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
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
            owned_by: "harness-router",
            harness_router: {
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
            if (!svc) continue;
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
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          if (parsed.mode === "fanout") {
            const selected = eligibleRoutes(parsed.models);
            const results = await Promise.all(
              selected.routes.map((route) =>
                state.router.routeTo(route, parsed.prompt, parsed.files, parsed.workingDir, {
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
            writeSse(res, {
              choices: [
                {
                  index: 0,
                  delta: {
                    content: JSON.stringify(
                      results.map((r) => ({
                        route: r.result.service,
                        output: r.result.output,
                        workspace: r.result.workspace,
                      })),
                    ),
                  },
                  finish_reason: null,
                },
              ],
              harness_router: {
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
                  harness_router: decision ? { route: decision.service } : undefined,
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
          const results = await Promise.all(
            selected.routes.map((route) =>
              state.router.routeTo(route, parsed.prompt, parsed.files, parsed.workingDir, {
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
          sendJson(
            res,
            200,
            completionEnvelope(
              JSON.stringify(
                results.map((r) => ({
                  route: r.result.service,
                  success: r.result.success,
                  output: r.result.output,
                  error: r.result.error,
                  workspace: r.result.workspace,
                })),
                null,
                2,
              ),
              typeof parsed.hints.model === "string" ? parsed.hints.model : "harness-router",
              {
                harness_router: {
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

        const { result, decision } = await state.router.route(
          parsed.prompt,
          parsed.files,
          parsed.workingDir,
          { hints: parsed.hints, maxFallbacks: 2 },
        );
        sendJson(
          res,
          200,
          completionEnvelope(result.output, decision?.model ?? parsed.hints.model ?? "harness-router", {
            harness_router: {
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

      if (url.pathname === mcpRoute) {
        if (!requireAuth(req, res)) return;
        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
        } else {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          if (!connected) {
            await server.connect(transport as unknown as Transport);
            connected = true;
          }
        }
        await transport.handleRequest(req, res);
        return;
      }

      sendText(res, 404, "not found");
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await server.close();
    },
  };
}

export const startMcpHttpServer = startHttpServer;
