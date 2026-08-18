#!/usr/bin/env node
/**
 * harness-dispatch CLI entrypoint.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import yaml from "js-yaml";

import { ensureHttpToken, maskToken, readHttpToken, rotateHttpToken, tokenPath } from "./auth.js";
import { AUTO_DETECT_COMMANDS, loadConfig } from "./config.js";
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
import { effectiveSafetyProfile } from "./safety.js";

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
  const leaderboard = new LeaderboardCache(undefined, {
    enabled: config.leaderboard?.enabled === true,
  });
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, leaderboard, router };
}

function printUsage(): void {
  process.stdout.write(
    [
      "harness-dispatch",
      "",
      "Usage:",
      "  harness-dispatch                         Start stdio MCP.",
      "  harness-dispatch configure [--print]     Detect and prepare harness config.",
      "  harness-dispatch doctor [--json]         Check install, config, auth, and routes.",
      "  harness-dispatch doctor --live           Run one routed probe when billing policy allows it.",
      "  harness-dispatch doctor --live --allow-paid  Run a live probe through paid/unknown routes.",
      "  harness-dispatch status [--json]         Show route, quota, and breaker state.",
      "  harness-dispatch status --watch          Re-render status every --interval ms.",
      "  harness-dispatch usage [--json]          Show per-route call counts, quota, and billing kind.",
      "  harness-dispatch serve [--port 3333]     Serve MCP at /mcp and REST at /v1/*.",
      "  harness-dispatch auth show               Print the HTTP bearer token.",
      "  harness-dispatch auth rotate             Rotate the HTTP bearer token.",
      "",
      "Options:",
      "  --config <path>       Path to config.yaml.",
      "  --port <number>       HTTP port for serve (default: random free port).",
      "  --host <host>         HTTP host for serve (default: 127.0.0.1).",
      "  --interval <ms>       Watch refresh interval (default: 1000).",
      "  --json                Print JSON where supported.",
      "  --print               configure: print generated config YAML without writing it.",
      "  --yes                 configure: write config.yaml instead of only previewing it.",
      "  --force               configure: overwrite an existing config file.",
      "  --allow-paid          Allow doctor --live to probe paid or unknown-paid routes.",
      "  -h, --help            Show help.",
      "",
    ].join("\n"),
  );
}

/**
 * Common fields between clis: and endpoints: entries. Billing fields
 * (provider/surface/auth_source/billing_kind/paid_usage_possible/
 * billing_confidence/billing_notes) are deliberately NOT emitted — they're
 * computed from the harness/endpoint defaults every time the config loads
 * (see buildRouteBilling), so writing them out would freeze a snapshot that
 * silently stops tracking future default changes and looks like a deliberate
 * user override when it never was one. `allow_paid_usage` is the one real
 * opt-in flag here, so it's the only billing-adjacent field written.
 *
 * `safety_profile`/`effective_safety` are only emitted when the service
 * actually carries an explicit value — never a fallback default. Baking in
 * `requestedSafetyProfile()`'s "workspace_edit" fallback for every route used
 * to write `safety_profile: workspace_edit` on cursor_cli even though its
 * real effective_safety (the capability floor that actually governs it) is
 * full_auto, making the written file self-contradictory next to `status`.
 */
function commonEntryFields(svc: ServiceConfig): Record<string, unknown> {
  return {
    enabled: svc.enabled ? undefined : false,
    model: svc.model,
    tier: svc.tier,
    weight: svc.weight,
    cli_capability: svc.cliCapability,
    leaderboard_model: svc.leaderboardModel,
    thinking_level: svc.thinkingLevel,
    escalate_model: svc.escalateModel,
    escalate_on: svc.escalateOn.length > 0 ? svc.escalateOn : undefined,
    capabilities:
      Object.keys(svc.capabilities).length > 0 ? svc.capabilities : undefined,
    max_output_tokens: svc.maxOutputTokens,
    max_input_tokens: svc.maxInputTokens,
    allow_paid_usage: svc.allowPaidUsage ? true : undefined,
    safety_profile: svc.safetyProfile,
    effective_safety: svc.effectiveSafety,
    endpoint_mode: svc.endpointMode,
    endpoint_provider: svc.endpointProvider,
    wire_protocol: svc.wireProtocol,
    workspace_policy: svc.workspacePolicy,
    models: svc.models && svc.models.length > 0 ? svc.models : undefined,
    model_hint: svc.modelHint,
  };
}

/**
 * Render a route's api_key WITHOUT materialising the secret.
 *
 * `svc.apiKey` is the RESOLVED value — config.ts interpolates `${VAR}` at
 * load time, so by here the reference is gone. Emitting it verbatim wrote
 * live credentials into config.yaml and echoed them to stdout on
 * `configure --print`, which is documented as the safe preview and is exactly
 * what someone pastes into a bug report. It also broke the project's own
 * stated invariant (plugin/commands/setup.md: "API keys MUST be written as
 * ${ENV_VAR} references — never literal").
 *
 * `config.envRefs` maps the resolved value back to the reference that
 * produced it, so a key that came from `${GROQ_API_KEY}` round-trips exactly.
 *
 * A key written as a LITERAL in the source file has no reference to restore.
 * That case splits by destination: `--yes` writes to disk, where the literal
 * already lives and dropping it would break a working config, so it is
 * preserved; `--print` goes to a terminal and a bug report, so it is redacted
 * to the placeholder below.
 */
function apiKeyForYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: { redactLiterals: boolean },
): string | undefined {
  if (svc.apiKey === undefined || svc.apiKey === "") return undefined;
  const ref = config.envRefs?.get(svc.apiKey);
  if (ref !== undefined) return ref;
  if (!opts.redactLiterals) return svc.apiKey;
  // protocol.apiKeyEnvVar is the var the CHILD CLI reads, which is only a
  // suggestion for what to name the config reference — they need not match,
  // and endpoint routes have no protocol at all. Hence the generic fallback.
  const envVar = svc.protocol?.apiKeyEnvVar ?? "YOUR_API_KEY_ENV_VAR";
  return `\${${envVar}}`;
}

interface YamlOpts {
  redactLiterals: boolean;
}

function cliEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  // `harness: generic` has NO shipped preset behind it, so anything omitted
  // here is not recoverable on reload — it is gone. Dropping `protocol:` was
  // fatal: config.ts refuses a generic entry without one ("requires a
  // protocol block — entry ignored"), so a round-trip deleted every
  // user-added harness, and `configure --yes --force` wrote that over their
  // file. This is the documented README#adding-a-harness path.
  //
  // Built-in harnesses keep the lean output: their preset supplies protocol
  // and billing, and emitting a copy would freeze a snapshot that stops
  // tracking future default changes — the same reasoning commonEntryFields
  // gives for omitting billing fields generally.
  const isGeneric = svc.harness === "generic";
  return {
    name: svc.name,
    harness: svc.harness,
    command: svc.command,
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc),
    ...(isGeneric
      ? {
          provider: svc.provider,
          surface: svc.surface,
          auth_source: svc.authSource,
          billing_kind: svc.billingKind,
          paid_usage_possible: svc.paidUsagePossible,
          billing_notes: svc.billingNotes,
          protocol: svc.protocol,
        }
      : {}),
  };
}

function endpointEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  return {
    name: svc.name,
    base_url: svc.baseUrl,
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc),
  };
}

/**
 * Top-level settings a user set and that have no defaults to track.
 *
 * These were silently dropped on every round-trip. Unlike the billing fields
 * (see commonEntryFields — omitted deliberately so they keep following harness
 * defaults), nothing recomputes these: a dropped `max_concurrent_runs` is
 * simply gone, and `configure --yes --force` wrote the result over the user's
 * file.
 */
function topLevelToYaml(config: RouterConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.disabled && config.disabled.length > 0) out.disabled = [...config.disabled];
  if (config.maxConcurrentRuns !== undefined) out.max_concurrent_runs = config.maxConcurrentRuns;
  if (config.retention?.jobsDays !== undefined) {
    out.retention = { jobs_days: config.retention.jobsDays };
  }
  if (config.telemetry?.enabled !== undefined) {
    out.telemetry = { enabled: config.telemetry.enabled };
  }
  if (config.leaderboard?.enabled !== undefined) {
    out.leaderboard = { enabled: config.leaderboard.enabled };
  }
  return out;
}

function configToYaml(config: RouterConfig, opts: YamlOpts): string {
  const clis: Record<string, unknown>[] = [];
  const endpoints: Record<string, unknown>[] = [];
  for (const svc of Object.values(config.services)) {
    if (svc.type === "cli") clis.push(cliEntryToYaml(svc, config, opts));
    else endpoints.push(endpointEntryToYaml(svc, config, opts));
  }
  const doc: Record<string, unknown> = { ...topLevelToYaml(config) };
  if (clis.length > 0) doc.clis = clis;
  if (endpoints.length > 0) doc.endpoints = endpoints;
  return yaml.dump(doc, { noRefs: true, lineWidth: 100 });
}

async function cmdConfigure(
  configPath: string | undefined,
  explicitConfigPath: string | undefined,
  opts: { print: boolean; yes: boolean; force: boolean },
): Promise<number> {
  // configure's --config names where it will WRITE, so a path that does not
  // exist yet is the normal first-run case, not a typo.
  const config = await loadConfig(configPath, { allowMissing: true });
  const routeCount = Object.keys(config.services).length;

  if (opts.print) {
    // Preview goes to a terminal and, routinely, into a bug report — a
    // literal key with no ${VAR} to restore is redacted rather than echoed.
    const preview = configToYaml(config, { redactLiterals: true });
    process.stdout.write(preview);
    const redacted = Object.values(config.services).some(
      (svc) =>
        svc.apiKey !== undefined &&
        svc.apiKey !== "" &&
        config.envRefs?.get(svc.apiKey) === undefined,
    );
    if (redacted) {
      process.stderr.write(
        "note: one or more api_key values are literals in the source config and were " +
          "replaced with ${ENV_VAR} placeholders in this preview. Move them to " +
          "environment variables — this output is not a drop-in replacement for that file " +
          "until you do.\n",
      );
    }
    return 0;
  }

  const yamlText = configToYaml(config, { redactLiterals: false });

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
        "Verify with: harness-dispatch doctor --live\n",
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
      "After writing config, connect agents by adding the harness-dispatch MCP snippet to the agent you use.\n",
    );
    return 0;
  }

  // Guard ANY existing file, however the path was supplied.
  //
  // This previously read `existsSync(target) && explicitConfigPath === undefined`,
  // so passing --config skipped the protection entirely — and the message told
  // you to pass --config, which is exactly what disabled it. Overwriting a
  // hand-written config is not recoverable, so it now takes an explicit
  // --force rather than an accident of which flag you happened to use.
  if (existsSync(target) && !opts.force) {
    process.stderr.write(
      `configure: ${target} already exists and would be overwritten.\n` +
        "Use --print to inspect the generated YAML, --config <other-path> to write\n" +
        "elsewhere, or --force to overwrite it deliberately.\n",
    );
    return 1;
  }
  await fs.writeFile(target, yamlText, "utf-8");
  const absoluteTarget = path.resolve(target);
  process.stdout.write(`Wrote ${target}.\n`);
  process.stdout.write(
    "MCP snippet (uses an absolute --config path so it resolves correctly no matter what\n" +
      "directory the MCP client launches from — a relative path or none at all silently\n" +
      "falls back to the shipped defaults, ignoring every edit you make to this file):\n",
  );
  process.stdout.write(
    JSON.stringify(
      {
        mcpServers: {
          "harness-dispatch": {
            command: "harness-dispatch",
            args: ["--config", absoluteTarget],
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
  // Must agree with package.json engines (>=22.22.2) and the README. It said
  // >= 24 while both of those said 22, so a user following the README's own
  // install block hit `fail node` on the second command — on a runtime where
  // dispatch works correctly. Three sources, two answers, and the one the
  // user sees first was the wrong one.
  const [nodeMajor, nodeMinor, nodePatch] = process.versions.node
    .split(".")
    .map((n) => Number(n) || 0);
  const nodeOk =
    (nodeMajor ?? 0) > 22 ||
    ((nodeMajor ?? 0) === 22 &&
      ((nodeMinor ?? 0) > 22 || ((nodeMinor ?? 0) === 22 && (nodePatch ?? 0) >= 2)));
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "node",
      ok: nodeOk,
      detail: nodeOk
        ? `Node ${process.versions.node}`
        : `Node ${process.versions.node} — harness-dispatch needs >=22.22.2`,
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
      // When nothing is ready, say what was looked for. "0 ready route(s)" on
      // its own leaves a new user with no idea whether the tool is broken or
      // simply has nothing to route to, and no hint what to install.
      detail:
        status.ready.length > 0
          ? `${status.ready.length} ready route(s)`
          : `0 ready route(s). Looked for these harness CLIs on PATH: ` +
            `${Object.values(AUTO_DETECT_COMMANDS).join(", ")}. ` +
            `Install one, or add a route to config.yaml (endpoints: need no CLI).`,
    },
    {
      name: "http-auth",
      ok: true,
      detail: (await readHttpToken())
        ? `token configured at ${tokenPath()} or HARNESS_DISPATCH_HTTP_TOKEN`
        : "no token yet; run harness-dispatch auth show or serve to create one before using HTTP",
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
      "Reply with exactly: harness-dispatch live probe ok. Do not inspect or modify files.",
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
    process.stdout.write("harness-dispatch doctor\n\n");
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

/**
 * Thrown for a flag value the user typed wrong. main() turns it into a plain
 * one-line message and exit 1 — never a stack trace, which tells a CLI user
 * nothing they can act on.
 */
class UsageError extends Error {}

function serveOpts(values: { port?: unknown; host?: unknown }): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  if (values.port !== undefined) {
    // `--port abc` used to fall back to 0, which binds a RANDOM free port and
    // prints it as though it were what was asked for. A typo'd port silently
    // serving somewhere else is worse than refusing to start.
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
      force: { type: "boolean" },
      http: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  // parseArgs runs with strict:false so positionals and subcommand shapes stay
  // flexible — the cost is that an unknown flag is silently accepted. `status
  // --jsonn` printed human text and exited 0, so a cron job piping it to jq
  // got garbage AND a success code. PRODUCT.md names automation as a user, and
  // a wrong exit code is the one thing automation cannot recover from.
  const knownFlags = new Set([
    "help", "config", "json", "live", "allow-paid", "watch", "interval",
    "port", "host", "print", "yes", "force", "http",
  ]);
  const unknownFlags = Object.keys(values).filter((k) => !knownFlags.has(k));
  if (unknownFlags.length > 0) {
    throw new UsageError(
      `unknown option${unknownFlags.length > 1 ? "s" : ""}: ` +
        `${unknownFlags.map((f) => `--${f}`).join(", ")}. Run --help for the list.`,
    );
  }

  if (values.help) {
    printUsage();
    return 0;
  }

  await initObservability();

  const [command, ...rest] = positionals;
  // `--config` with no value: parseArgs yields boolean true, which reached
  // path.join and threw ERR_INVALID_ARG_TYPE as a raw Node stack trace.
  if (values.config !== undefined && typeof values.config !== "string") {
    throw new UsageError("--config needs a path, e.g. --config ./config.yaml");
  }
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
        force: Boolean(values.force),
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
  void main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      // A CLI user gets one actionable line, not a stack trace. UsageError and
      // config-loading failures (missing file, bad YAML) are all things they
      // typed or wrote and can fix; anything else keeps its stack because it
      // is a bug worth reporting.
      if (err instanceof UsageError || err instanceof Error) {
        process.stderr.write(`harness-dispatch: ${err.message}
`);
        process.exit(1);
      }
      throw err;
    });
}
