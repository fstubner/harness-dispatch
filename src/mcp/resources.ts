import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redact } from "../redaction.js";

import { buildStatus, renderStatusText } from "../status.js";
import type { ConfigHotReloader, RuntimeHolder } from "./config-hot-reload.js";

export interface ResourceDeps {
  holder: RuntimeHolder;
  reloader?: ConfigHotReloader;
}

async function ensureFreshConfig(reloader: ConfigHotReloader | undefined): Promise<void> {
  if (reloader) await reloader.maybeReload();
}

async function currentStatus(deps: ResourceDeps) {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  return buildStatus(
    state.config,
    state.dispatchers,
    state.quota,
    state.router,
    state.leaderboard,
  );
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  server.registerResource(
    "status",
    "harness-dispatch://status",
    {
      title: "Harness Router Status",
      description: "Human-readable route availability, quota, and breaker state.",
      mimeType: "text/plain",
    },
    async () => {
      const status = await currentStatus(deps);
      return {
        contents: [
          {
            uri: "harness-dispatch://status",
            mimeType: "text/plain",
            text: redact(renderStatusText(status)),
          },
        ],
      };
    },
  );

  server.registerResource(
    "status-json",
    "harness-dispatch://status.json",
    {
      title: "Harness Router Status JSON",
      description: "Structured route availability, quota, and breaker state.",
      mimeType: "application/json",
    },
    async () => {
      const status = await currentStatus(deps);
      return {
        contents: [
          {
            uri: "harness-dispatch://status.json",
            mimeType: "application/json",
            text: redact(JSON.stringify(status, null, 2)),
          },
        ],
      };
    },
  );
}
