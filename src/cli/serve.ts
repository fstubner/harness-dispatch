/** `serve` (the HTTP server) and `auth` (its bearer token). */

import { ensureHttpToken, maskToken, rotateHttpToken } from "../auth.js";
import { startHttpServer } from "../http/server.js";
import { UsageError, parsePositiveInt } from "./common.js";

export async function cmdServe(
  configPath: string | undefined,
  opts: { port?: number; host?: string },
): Promise<number> {
  const handle = await startHttpServer({
    ...(configPath !== undefined ? { configPath } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  });
  process.stderr.write(`harness-dispatch listening on http://${handle.host}:${handle.port}\n`);
  process.stderr.write(`MCP:  http://${handle.host}:${handle.port}/mcp\n`);
  process.stderr.write(`REST: http://${handle.host}:${handle.port}/v1/chat/completions\n`);
  if (handle.token) {
    process.stderr.write(`Auth: Bearer ${maskToken(handle.token)}\n`);
  }
  const shutdown = async (): Promise<void> => {
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // server lifetime
  });
  return 0;
}

export async function cmdAuth(action: string | undefined): Promise<number> {
  switch (action) {
    case "show": {
      const token = await ensureHttpToken();
      process.stdout.write(`${token}\n`);
      return 0;
    }
    case "rotate": {
      const token = await rotateHttpToken();
      process.stdout.write(`${token}\n`);
      return 0;
    }
    default:
      // Thrown, not written: the top-level handler is the one place that
      // knows whether --json was asked for, so writing here would bypass the
      // envelope and report failure as a bare sentence.
      throw new UsageError("auth: expected show or rotate");
  }
}

export function serveOpts(values: { port?: unknown; host?: unknown }): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  if (values.port !== undefined) {
    // A typo'd port must not fall back to 0, which binds a RANDOM free port
    // and prints it as though it were what was asked for. Silently serving
    // somewhere else is worse than refusing to start.
    const port = parsePositiveInt(values.port, 0);
    if (port === 0 || !Number.isInteger(port) || port > 65535) {
      throw new UsageError(
        `--port must be an integer between 1 and 65535 (got ${JSON.stringify(values.port)}). ` +
          `Omit --port to bind a random free one.`,
      );
    }
    out.port = port;
  }
  if (typeof values.host === "string") out.host = values.host;
  return out;
}
