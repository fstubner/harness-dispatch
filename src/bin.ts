#!/usr/bin/env node
/**
 * harness-router CLI entrypoint.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";

import yaml from "js-yaml";

import { ensureHttpToken, maskToken, readHttpToken, rotateHttpToken, tokenPath } from "./auth.js";
import { loadConfig } from "./config.js";
import { LeaderboardCache } from "./leaderboard.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import { startMcpServer } from "./mcp/server.js";
import { initObservability } from "./observability/index.js";
import { QuotaCache } from "./quota.js";
import { Router } from "./router.js";
import { buildStatus, buildUsage, renderStatusText, renderUsageText } from "./status.js";
import { startHttpServer } from "./http/server.js";
import type { RouterConfig, ServiceConfig } from "./types.js";
import { billingIsBlocked, buildRouteBilling } from "./billing.js";
import { effectiveSafetyProfile, requestedSafetyProfile } from "./safety.js";

interface Runtime {
  config: RouterConfig;
  dispatchers: Awaited<ReturnType<typeof buildDispatchers>>;
  quota: QuotaCache;
  leaderboard: LeaderboardCache;
  router: Router;
}

async function buildRuntime(configPath: string | undefined): Promise<Runtime> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, leaderboard, router };
}

function printUsage(): void {
  process.stdout.write(
    [
      "harness-router",
      "",
      "Usage:",
      "  harness-router                         Start stdio MCP.",
      "  harness-router configure [--print]     Detect and prepare harness config.",
      "  harness-router doctor [--json]         Check install, config, auth, and routes.",
      "  harness-router doctor --live           Run one routed probe when billing policy allows it.",
      "  harness-router doctor --live --allow-paid  Run a live probe through paid/unknown routes.",
      "  harness-router status [--json]         Show route, quota, and breaker state.",
      "  harness-router status --watch          Re-render status every --interval ms.",
      "  harness-router usage [--json]          Show per-route call counts, quota, and billing kind.",
      "  harness-router serve [--port 3333]     Serve MCP at /mcp and REST at /v1/*.",
      "  harness-router auth show               Print the HTTP bearer token.",
      "  harness-router auth rotate             Rotate the HTTP bearer token.",
      "",
      "Options:",
      "  --config <path>       Path to config.yaml.",
      "  --port <number>       HTTP port for serve (default: random free port).",
      "  --host <host>         HTTP host for serve (default: 127.0.0.1).",
      "  --interval <ms>       Watch refresh interval (default: 1000).",
      "  --json                Print JSON where supported.",
      "  --allow-paid          Allow doctor --live to probe paid or unknown-paid routes.",
      "  -h, --help            Show help.",
      "",
    ].join("\n"),
  );
}

function serviceToYaml(svc: ServiceConfig): Record<string, unknown> {
  const billing = buildRouteBilling(svc);
  return {
    enabled: svc.enabled,
    type: svc.type,
    harness: svc.harness,
    command: svc.command,
    api_key: svc.apiKey,
    base_url: svc.baseUrl,
    model: svc.model,
    tier: svc.tier,
    weight: svc.weight,
    cli_capability: svc.cliCapability,
    leaderboard_model: svc.leaderboardModel,
    thinking_level: svc.thinkingLevel,
    escalate_model: svc.escalateModel,
    escalate_on: svc.escalateOn,
    capabilities: svc.capabilities,
    max_output_tokens: svc.maxOutputTokens,
    max_input_tokens: svc.maxInputTokens,
    provider: svc.provider ?? billing.provider,
    surface: svc.surface ?? billing.surface,
    auth_source: svc.authSource ?? billing.authSource,
    billing_kind: svc.billingKind ?? billing.kind,
    paid_usage_possible: svc.paidUsagePossible ?? billing.paidUsagePossible,
    allow_paid_usage: svc.allowPaidUsage ?? false,
    billing_confidence: svc.billingConfidence ?? billing.confidence,
    billing_notes: svc.billingNotes ?? billing.notes,
    safety_profile: svc.safetyProfile ?? requestedSafetyProfile(svc),
    endpoint_mode: svc.endpointMode,
    endpoint_provider: svc.endpointProvider,
    wire_protocol: svc.wireProtocol,
    workspace_policy: svc.workspacePolicy,
  };
}

function configToYaml(config: RouterConfig): string {
  const services: Record<string, unknown> = {};
  for (const [name, svc] of Object.entries(config.services)) {
    services[name] = serviceToYaml(svc);
  }
  return yaml.dump(
    {
      version: 4,
      services,
    },
    { noRefs: true, lineWidth: 100 },
  );
}

async function cmdConfigure(
  configPath: string | undefined,
  explicitConfigPath: string | undefined,
  opts: { print: boolean; yes: boolean },
): Promise<number> {
  const config = await loadConfig(configPath);
  const yamlText = configToYaml(config);
  const routeCount = Object.keys(config.services).length;

  if (opts.print) {
    process.stdout.write(yamlText);
    return 0;
  }

  process.stdout.write(`Detected ${routeCount} harness route${routeCount === 1 ? "" : "s"}.\n`);
  for (const [name, svc] of Object.entries(config.services)) {
    process.stdout.write(
      `- ${name}: harness=${svc.harness ?? name} billing=${buildRouteBilling(svc).kind} safety=${effectiveSafetyProfile(svc)} model=${
        svc.model ?? svc.leaderboardModel ?? "unknown"
      }\n`,
    );
  }

  const blocked = Object.entries(config.services)
    .filter(([, svc]) => svc.enabled && billingIsBlocked(buildRouteBilling(svc)))
    .map(([name]) => name);
  if (blocked.length > 0) {
    process.stdout.write(
      `\nBlocked until you opt in: ${blocked.join(", ")}. These routes can incur paid\n` +
        "usage (metered API, unknown billing, or subscription overage), so they are\n" +
        "skipped until you set allow_paid_usage: true on each route you trust.\n" +
        "Verify with: harness-router doctor --live\n",
    );
  }

  if (config.configWarnings && config.configWarnings.length > 0) {
    process.stdout.write(
      `\nIgnored config entries (${config.configWarnings.length}) — these had no effect:\n`,
    );
    for (const warning of config.configWarnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }

  const target = configPath ?? "config.yaml";
  if (!opts.yes) {
    process.stdout.write(
      `\nNo files written. Re-run with --yes to write ${target}, or use --print to inspect YAML.\n`,
    );
    process.stdout.write(
      "After writing config, connect agents by adding the harness-router MCP snippet to the agent you use.\n",
    );
    return 0;
  }

  if (existsSync(target) && explicitConfigPath === undefined) {
    process.stderr.write(
      "configure: config.yaml already exists. Pass --config <path> or --print to avoid overwriting it.\n",
    );
    return 1;
  }
  await fs.writeFile(target, yamlText, "utf-8");
  process.stdout.write(`Wrote ${target}.\n`);
  process.stdout.write("MCP snippet:\n");
  process.stdout.write(
    JSON.stringify(
      {
        mcpServers: {
          "harness-router": {
            command: "harness-router",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

async function cmdStatus(
  configPath: string | undefined,
  opts: { json: boolean; watch: boolean; intervalMs: number },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  const render = async (): Promise<string> => {
    const status = await buildStatus(
      runtime.config,
      runtime.dispatchers,
      runtime.quota,
      runtime.router,
      runtime.leaderboard,
    );
    return opts.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderStatusText(status)}\n`;
  };

  if (!opts.watch) {
    process.stdout.write(await render());
    return 0;
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (running) {
      process.stdout.write(await render());
      await new Promise<void>((resolve) => setTimeout(resolve, opts.intervalMs));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

async function cmdUsage(
  configPath: string | undefined,
  opts: { json: boolean },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  const status = await buildStatus(
    runtime.config,
    runtime.dispatchers,
    runtime.quota,
    runtime.router,
    runtime.leaderboard,
  );
  const usage = buildUsage(status);
  process.stdout.write(
    opts.json ? `${JSON.stringify(usage, null, 2)}\n` : `${renderUsageText(usage)}\n`,
  );
  return 0;
}

async function cmdDoctor(
  configPath: string | undefined,
  opts: { json: boolean; live: boolean; allowPaid: boolean },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  if (opts.allowPaid) {
    for (const svc of Object.values(runtime.config.services)) {
      svc.allowPaidUsage = true;
    }
  }
  const status = await buildStatus(
    runtime.config,
    runtime.dispatchers,
    runtime.quota,
    runtime.router,
    runtime.leaderboard,
  );
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "node",
      ok: nodeMajor >= 24,
      detail: `Node ${process.versions.node}`,
    },
    {
      name: "config",
      ok: Object.keys(runtime.config.services).length > 0,
      detail: `${Object.keys(runtime.config.services).length} configured route(s)`,
    },
    {
      name: "config-warnings",
      ok: (runtime.config.configWarnings?.length ?? 0) === 0,
      detail:
        runtime.config.configWarnings && runtime.config.configWarnings.length > 0
          ? runtime.config.configWarnings.join(" | ")
          : "no unrecognized config entries",
    },
    {
      name: "routes",
      ok: status.ready.length > 0,
      detail: `${status.ready.length} ready route(s)`,
    },
    {
      name: "http-auth",
      ok: true,
      detail: (await readHttpToken())
        ? `token configured at ${tokenPath()} or HARNESS_ROUTER_HTTP_TOKEN`
        : "no token yet; run harness-router auth show or serve to create one before using HTTP",
    },
  ];
  const blocked = status.skippedRoutes.filter(
    (skip) => skip.code === "paid_blocked" || skip.code === "unknown_billing",
  );
  checks.push({
    name: "billing-policy",
    ok: true,
    detail:
      blocked.length === 0
        ? "all ready routes satisfy billing policy"
        : `${blocked.length} route(s) intentionally blocked by paid/unknown billing policy`,
  });

  const unsafe = status.routes.filter(
    (route) => route.effectiveSafetyProfile === "full_auto" && route.safetyProfile !== "full_auto",
  );
  checks.push({
    name: "safety-policy",
    ok: true,
    detail:
      unsafe.length === 0
        ? "all ready routes satisfy requested safety profile"
        : `${unsafe.length} route(s) require full_auto safety and are skipped unless requested`,
  });

  let liveProbe:
    | {
        route: string;
        success: boolean;
        output: string;
        error?: string;
      }
    | undefined;
  if (opts.live) {
    const { result } = await runtime.router.route(
      "Reply with exactly: harness-router live probe ok. Do not inspect or modify files.",
      [],
      process.cwd(),
      { hints: { taskType: "local" }, maxFallbacks: 0 },
    );
    liveProbe = {
      route: result.service,
      success: result.success,
      output: result.output,
    };
    if (result.error !== undefined) liveProbe.error = result.error;
    checks.push({
      name: "live-probe",
      ok: result.success,
      detail: result.success
        ? `routed through ${result.service}`
        : `${result.service}: ${result.error ?? "probe failed"}`,
    });
  } else {
    checks.push({
      name: "live-probe",
      ok: true,
      detail: "skipped; pass --live to consume quota and validate dispatch",
    });
  }

  const payload = { ok: checks.every((check) => check.ok), checks, status, liveProbe };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write("harness-router doctor\n\n");
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}\n`);
    }
  }
  return payload.ok ? 0 : 1;
}

async function cmdServe(
  configPath: string | undefined,
  opts: { port?: number; host?: string },
): Promise<number> {
  const handle = await startHttpServer({
    ...(configPath !== undefined ? { configPath } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  });
  process.stderr.write(`harness-router listening on http://${handle.host}:${handle.port}\n`);
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

async function cmdAuth(action: string | undefined): Promise<number> {
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
      process.stderr.write("auth: expected show or rotate\n");
      return 1;
  }
}

async function cmdRouteAlias(prompt: string, configPath: string | undefined): Promise<number> {
  if (!prompt) {
    process.stderr.write('route: missing prompt. Usage: route "<prompt>"\n');
    return 1;
  }
  const runtime = await buildRuntime(configPath);
  const { result, decision } = await runtime.router.route(prompt, [], process.cwd(), {
    hints: { taskType: "execute" },
    maxFallbacks: 2,
  });
  if (decision) {
    process.stderr.write(`route: ${decision.service} (${decision.reason})\n`);
  }
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  if (!result.success) {
    process.stderr.write(`${result.error ?? "routing failed"}\n`);
    return 1;
  }
  return 0;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serveOpts(values: { port?: unknown; host?: unknown }): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  if (values.port !== undefined) out.port = parsePositiveInt(values.port, 0);
  if (typeof values.host === "string") out.host = values.host;
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      live: { type: "boolean" },
      "allow-paid": { type: "boolean" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      print: { type: "boolean" },
      yes: { type: "boolean" },
      http: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printUsage();
    return 0;
  }

  await initObservability();

  const [command, ...rest] = positionals;
  const explicitConfigPath = values.config as string | undefined;
  // If the caller didn't pass --config, fall back to ./config.yaml when it
  // exists, rather than silently ignoring it and running pure auto-detect.
  const configPath = explicitConfigPath ?? (existsSync("config.yaml") ? "config.yaml" : undefined);

  if (command === undefined) {
    const handle = await startMcpServer(configPath === undefined ? {} : { configPath });
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
      // stdio MCP lifetime
    });
    return 0;
  }

  switch (command) {
    case "configure":
      return cmdConfigure(configPath, explicitConfigPath, {
        print: Boolean(values.print),
        yes: Boolean(values.yes),
      });
    case "doctor":
      return cmdDoctor(configPath, {
        json: Boolean(values.json),
        live: Boolean(values.live),
        allowPaid: Boolean(values["allow-paid"]),
      });
    case "status":
    case "dashboard":
    case "list-services":
      return cmdStatus(configPath, {
        json: Boolean(values.json) || command === "list-services",
        watch: Boolean(values.watch),
        intervalMs: parsePositiveInt(values.interval, 1000),
      });
    case "usage":
      return cmdUsage(configPath, { json: Boolean(values.json) });
    case "serve":
      return cmdServe(configPath, serveOpts(values));
    case "auth":
      return cmdAuth(rest[0]);
    case "route":
      return cmdRouteAlias(rest.join(" ").trim(), configPath);
    case "mcp":
      if (values.http !== undefined) {
        return cmdServe(configPath, serveOpts({ port: values.http, host: values.host }));
      }
      return main(configPath !== undefined ? ["--config", configPath] : []);
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : "";
if (entrypoint && (entrypoint.endsWith("bin.ts") || entrypoint.endsWith("bin.js"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
