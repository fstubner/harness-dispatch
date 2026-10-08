#!/usr/bin/env node
/**
 * harness-dispatch CLI entrypoint.
 */

import { realpathSync } from "node:fs";
import { installOutputRedaction } from "./redaction.js";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VERSION } from "./version.js";

// Everything heavier than this is imported by the command that needs it, inside
// main(). A static import made every invocation load the MCP SDK, hono and the
// rest of the server (357 files) before parsing a flag, which was most of the
// wall time of `status`, `usage`, `doctor` and `--version`.

// Set once main() gets past --version/--help, which are answered without it.
let observability: typeof import("./observability/index.js") | undefined;

function printUsage(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(
    [
      "harness-dispatch",
      "",
      "Usage:",
      "  harness-dispatch                         Start stdio MCP.",
      "  harness-dispatch configure [--print]     Detect and prepare harness config.",
      "  harness-dispatch connect                 Register this server with the MCP clients you have.",
      "  harness-dispatch connect --remove        Take the entry back out again.",
      "  harness-dispatch doctor [--json]         Check install, config, auth, and routes.",
      "  harness-dispatch doctor --live           Run one routed probe when billing policy allows it.",
      "  harness-dispatch doctor --live --allow-paid  Run a live probe through paid/unknown routes.",
      "  harness-dispatch doctor --prune-state    Also delete saved breaker/usage state for routes this config does not name.",
      "  harness-dispatch status [--json]         Show route, quota, and breaker state.",
      "  harness-dispatch status --watch          Re-render status every --interval ms.",
      "  harness-dispatch usage [--json]          Show per-route call counts, quota, and billing kind.",
      "  harness-dispatch breaker reset <route>   Close a route's circuit breaker now (it persists across restarts).",
      "  harness-dispatch serve [--port <n>]      Serve MCP at /mcp and REST at /v1/* (random free port unless --port).",
      "  harness-dispatch mcp [--http <port>]     The same as no command (stdio MCP); with --http, as serve.",
      '  harness-dispatch dispatch "<prompt>"     Route one task and print the result (not counted against max_concurrent_runs).',
      "  harness-dispatch auth show               Print the HTTP bearer token.",
      "  harness-dispatch auth rotate             Rotate the HTTP bearer token.",
      "",
      "Options:",
      "  --config <path>       Path to config.yaml.",
      "  --port <number>       HTTP port for serve (default: a random free port, printed on start).",
      "  --host <host>         HTTP host for serve (default: 127.0.0.1).",
      "  --interval <ms>       Watch refresh interval (default: 1000).",
      "  --json                Print JSON where supported.",
      "  --print               configure: print generated config YAML without writing it.",
      "  --yes                 configure: write config.yaml instead of only previewing it.",
      "                        connect: do not prompt (never replaces an entry you edited).",
      "  --force               configure: overwrite an existing config file.",
      "                        connect: replace a hand-edited client entry.",
      "  --clients <ids>       connect: comma-separated client ids, instead of prompting.",
      "  --no-clients          configure: skip the offer to register with clients.",
      "  --remove              connect: remove the entry rather than write it.",
      "  --dev                 connect: point clients at THIS checkout's build, not the package.",
      "  --allow-paid          Allow doctor --live to probe paid or unknown-paid routes.",
      "  --service <id>        dispatch: run exactly this route, no fallback to others.",
      "  --safety <profile>    dispatch: read_only | workspace_edit | full_auto.",
      "  --task-type <type>    dispatch: execute | plan | review | local.",
      "  --no-fallback         dispatch: do not retry on another route if the first fails.",
      "  -h, --help            Show help; after a command, that command's help.",
      "  -v, --version         Print the version and exit.",
      "",
    ].join("\n"),
  );
}

/**
 * `harness-dispatch <command> --help`: that command's usage, its flags, and
 * one example. Every command used to print the same global block, so the
 * flags a command takes had to be picked out of a list covering all of them.
 */
const COMMAND_HELP: Record<string, string[]> = {
  configure: [
    "Usage: harness-dispatch configure [--yes] [--print] [--force] [--no-clients] [--clients <ids>] [--config <path>]",
    "",
    "Detect the harness CLIs on PATH and prepare config.yaml. Without --yes it only",
    "previews; nothing is written.",
    "",
    "  --yes             Write config.yaml (default location: ~/.harness-dispatch/config.yaml).",
    "  --print           Print the generated YAML and write nothing.",
    "  --force           Overwrite an existing config file.",
    "  --no-clients      Skip the offer to register with MCP clients afterwards.",
    "  --clients <ids>   Register with these clients afterwards, without prompting.",
    "  --config <path>   Write here instead of the default location.",
    "",
    "Example: harness-dispatch configure --yes",
  ],
  connect: [
    "Usage: harness-dispatch connect [--yes] [--clients <ids>] [--force] [--remove] [--dev] [--config <path>]",
    "",
    "Register this server with the MCP clients on this machine (Claude Code, Cursor).",
    "Claude Code is skipped while the harness-dispatch Claude Code plugin is enabled.",
    "",
    "  --yes             Do not prompt. Never replaces an entry you edited by hand.",
    "  --clients <ids>   Comma-separated client ids: claude-code, cursor.",
    "  --force           Replace a hand-edited entry; write Claude Code even with the plugin.",
    "  --remove          Take the entry out instead of writing it.",
    "  --dev             Point clients at this checkout's build, not the package.",
    "  --config <path>   The config the entry points at.",
    "",
    "Example: harness-dispatch connect --clients cursor --yes",
  ],
  doctor: [
    "Usage: harness-dispatch doctor [--json] [--live [--allow-paid]] [--prune-state] [--config <path>]",
    "",
    "Check the install, config, client registration, auth and every route. Exits",
    "non-zero when a check fails.",
    "",
    "  --json            Print the checks as JSON.",
    "  --live            Run one real routed probe, if billing policy allows (uses quota).",
    "  --allow-paid      With --live: allow paid or unknown-billing routes.",
    "  --prune-state     Also delete saved breaker/usage state for routes this config does not name.",
    "  --config <path>   Check this config instead of the default one.",
    "",
    "Example: harness-dispatch doctor --json",
  ],
  status: [
    "Usage: harness-dispatch status [--json] [--watch [--interval <ms>]] [--config <path>]",
    "",
    "Show each route as ready or skipped (with the reason), plus quota and breaker state.",
    "",
    "  --json            Print structured status.",
    "  --watch           Re-render until interrupted.",
    "  --interval <ms>   Refresh interval for --watch (default: 1000).",
    "  --config <path>   Use this config.",
    "",
    "Example: harness-dispatch status --watch --interval 5000",
  ],
  usage: [
    "Usage: harness-dispatch usage [--json] [--config <path>]",
    "",
    "Per-route call counts, quota and billing kind.",
    "",
    "  --json            Print structured usage.",
    "  --config <path>   Use this config.",
    "",
    "Example: harness-dispatch usage --json",
  ],
  breaker: [
    "Usage: harness-dispatch breaker reset <route> [--config <path>]",
    "",
    "Close a route's circuit breaker now. Breaker state persists across restarts, so",
    "a tripped route otherwise waits out its cooldown.",
    "",
    "Example: harness-dispatch breaker reset codex_cli",
  ],
  serve: [
    "Usage: harness-dispatch serve [--port <n>] [--host <host>] [--config <path>]",
    "",
    "Serve MCP at /mcp and REST at /v1/* over HTTP, with a bearer token",
    "(see `harness-dispatch auth show`). The address is printed on start.",
    "",
    "  --port <n>        Port to bind. Without it, a random free port is chosen.",
    "  --host <host>     Host to bind (default: 127.0.0.1).",
    "  --config <path>   Use this config.",
    "",
    "Example: harness-dispatch serve --port 3333",
  ],
  mcp: [
    "Usage: harness-dispatch mcp [--http <port>] [--config <path>]",
    "",
    "Start the MCP server on stdio, the same as running harness-dispatch with no",
    "command. This is what MCP clients and the plugin launcher run.",
    "",
    "  --http <port>     Serve over HTTP on this port instead, as `serve --port`.",
    "  --config <path>   Use this config.",
    "",
    "Example: harness-dispatch mcp --config ~/.harness-dispatch/config.yaml",
  ],
  dispatch: [
    'Usage: harness-dispatch dispatch "<prompt>" [--service <id>] [--task-type <type>] [--safety <profile>] [--no-fallback] [--json] [--config <path>]',
    "",
    "Route one task, run it in the current directory, and print the result. Runs in",
    "this process, so it is not counted against max_concurrent_runs.",
    "",
    "  --service <id>        Run exactly this route, with no fallback to others.",
    "  --task-type <type>    execute | plan | review | local.",
    "  --safety <profile>    read_only | workspace_edit | full_auto.",
    "  --no-fallback         Do not retry on another route if the first fails.",
    "  --json                Print the result as JSON.",
    "  --config <path>       Use this config.",
    "",
    'Example: harness-dispatch dispatch "review src/ for bugs" --task-type review --safety read_only',
  ],
  auth: [
    "Usage: harness-dispatch auth show | rotate",
    "",
    "show prints the HTTP bearer token for `serve`, creating it on first use.",
    "rotate replaces it; clients holding the old token stop working.",
    "",
    "Example: harness-dispatch auth show",
  ],
};

/** Hidden aliases share their command's help. */
const HELP_ALIASES: Record<string, string> = { dashboard: "status", "list-services": "status", route: "dispatch" };

export function commandHelp(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  // Own keys only: `constructor` is not a command.
  const name = Object.hasOwn(HELP_ALIASES, command) ? HELP_ALIASES[command]! : command;
  if (!Object.hasOwn(COMMAND_HELP, name)) return undefined;
  const lines = COMMAND_HELP[name]!;
  return [...lines, "", "Run harness-dispatch --help for every command.", ""].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  // Terminal output is a sink; see src/redaction.ts. Installed before any
  // config is loaded, which is fine — the registry is consulted per write.
  installOutputRedaction();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      live: { type: "boolean" },
      "allow-paid": { type: "boolean" },
      "prune-state": { type: "boolean" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      print: { type: "boolean" },
      yes: { type: "boolean" },
      force: { type: "boolean" },
      http: { type: "string" },
      service: { type: "string" },
      safety: { type: "string" },
      "task-type": { type: "string" },
      "no-fallback": { type: "boolean" },
      clients: { type: "string" },
      "no-clients": { type: "boolean" },
      remove: { type: "boolean" },
      dev: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  // parseArgs runs with strict:false so positionals and subcommand shapes stay
  // flexible — the cost is that an unknown flag is silently accepted, so
  // `status --jsonn` would print human text and exit 0. PRODUCT.md names
  // automation as a user, and a wrong exit code is the one thing automation
  // cannot recover from.
  const knownFlags = new Set([
    "help", "version", "config", "json", "live", "allow-paid", "prune-state", "watch", "interval",
    "port", "host", "print", "yes", "force", "http",
    "service", "safety", "task-type", "no-fallback",
    "clients", "no-clients", "remove", "dev",
  ]);
  const unknownFlags = Object.keys(values).filter((k) => !knownFlags.has(k));
  if (unknownFlags.length > 0) {
    const { UsageError } = await import("./cli/common.js");
    throw new UsageError(
      `unknown option${unknownFlags.length > 1 ? "s" : ""}: ` +
        `${unknownFlags.map((f) => `--${f}`).join(", ")}. Run --help for the list.`,
    );
  }

  // Before --help, and before anything that can fail: a version is what you
  // ask for when something is already wrong, so it must not depend on config
  // loading, a readable jobs root, or any route being reachable.
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (values.help) {
    const specific = commandHelp(positionals[0]);
    if (specific !== undefined) process.stdout.write(specific);
    else printUsage();
    return 0;
  }

  const { SAFETY_PROFILES, TASK_TYPES, UsageError, enumFlag, parsePositiveInt, wantsJsonOutput } =
    await import("./cli/common.js");

  // The same hole for an option that takes a value: parseArgs with strict:false
  // reads `--service` given with no value as boolean `true`, which the
  // `typeof === "string"` checks below drop — so `dispatch "x" --service` ran
  // as ordinary routing, and `--clients` / `--host` / `--interval` were ignored
  // with exit 0. `--config` has its own message further down.
  for (const flag of ["interval", "port", "host", "http", "service", "safety", "task-type", "clients"]) {
    const v = values[flag];
    // `--service --config x` hands `--config` to --service as its value, so a
    // value that is itself a flag is a missing value too.
    if (v !== undefined && (typeof v !== "string" || v === "" || v.startsWith("--"))) {
      throw new UsageError(`--${flag} needs a value, e.g. --${flag} <value>`);
    }
  }

  observability = await import("./observability/index.js");
  await observability.initObservability();

  const [command, ...rest] = positionals;
  // `--config` with no value: parseArgs yields boolean true, which reaches
  // path.join and throws ERR_INVALID_ARG_TYPE as a raw Node stack trace.
  // `--config=` (empty) is the same mistake with a string type: it resolves
  // to "", which loadConfig reads as no path at all.
  if (values.config !== undefined && (typeof values.config !== "string" || values.config === "")) {
    throw new UsageError("--config needs a path, e.g. --config ./config.yaml");
  }
  const explicitConfigPath = values.config as string | undefined;
  // Shared with job-runner.ts so the server and the runners it spawns cannot
  // resolve different files — see resolveConfigPath.
  const { resolveConfigPath } = await import("./config.js");
  const configPath = resolveConfigPath(explicitConfigPath);

  if (command === undefined) {
    const { startMcpServer } = await import("./mcp/server.js");
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
    case "configure": {
      const { cmdConfigure } = await import("./cli/configure.js");
      return cmdConfigure(configPath, {
        print: Boolean(values.print),
        yes: Boolean(values.yes),
        force: Boolean(values.force),
        noClients: Boolean(values["no-clients"]),
        clients: typeof values.clients === "string" ? values.clients : undefined,
      });
    }
    case "connect": {
      const { cmdConnect } = await import("./cli/connect.js");
      return cmdConnect(configPath, {
        clients: typeof values.clients === "string" ? values.clients : undefined,
        remove: Boolean(values.remove),
        yes: Boolean(values.yes),
        force: Boolean(values.force),
        dev: Boolean(values.dev),
      });
    }
    case "doctor": {
      const { cmdDoctor } = await import("./cli/doctor.js");
      return cmdDoctor(configPath, {
        json: Boolean(values.json),
        live: Boolean(values.live),
        allowPaid: Boolean(values["allow-paid"]),
        pruneState: Boolean(values["prune-state"]),
      });
    }
    case "status":
    case "dashboard":
    case "list-services": {
      const { cmdStatus } = await import("./cli/report.js");
      return cmdStatus(configPath, {
        json: Boolean(values.json) || command === "list-services",
        watch: Boolean(values.watch),
        intervalMs: parsePositiveInt(values.interval, 1000),
      });
    }
    case "usage": {
      const { cmdUsage } = await import("./cli/report.js");
      return cmdUsage(configPath, { json: Boolean(values.json) });
    }
    case "serve": {
      const { cmdServe, serveOpts } = await import("./cli/serve.js");
      return cmdServe(configPath, serveOpts(values));
    }
    case "auth": {
      const { cmdAuth } = await import("./cli/serve.js");
      return cmdAuth(rest[0]);
    }
    case "breaker": {
      const { cmdBreaker } = await import("./cli/breaker.js");
      return cmdBreaker(configPath, rest[0], rest[1]);
    }
    // `route` kept as an alias for `dispatch`, which matches the MCP tool that
    // does the same thing. Same pattern as status/dashboard/list-services.
    case "dispatch":
    case "route": {
      const safety = enumFlag(values.safety, SAFETY_PROFILES, "--safety");
      const taskType = enumFlag(values["task-type"], TASK_TYPES, "--task-type");
      const { cmdDispatch } = await import("./cli/dispatch.js");
      return cmdDispatch(rest.join(" ").trim(), configPath, {
        ...(typeof values.service === "string" ? { service: values.service } : {}),
        ...(safety !== undefined ? { safetyProfile: safety } : {}),
        ...(taskType !== undefined ? { taskType } : {}),
        noFallback: Boolean(values["no-fallback"]),
        json: Boolean(values.json),
      });
    }
    // Supported, not a hidden alias: the plugin launcher and existing client
    // entries run `mcp`, and `connect` entries may too. See docs/interfaces.md.
    case "mcp": {
      if (values.http !== undefined) {
        const { cmdServe, serveOpts } = await import("./cli/serve.js");
        return cmdServe(configPath, serveOpts({ port: values.http, host: values.host }));
      }
      return main(configPath !== undefined ? ["--config", configPath] : []);
    }
    default:
      // Usage goes to STDERR here, not stdout: an unknown command is an
      // error, and a help block on stdout would become the input of any pipe
      // the --json envelope exists to keep parseable. Suppressed under --json
      // for the same reason, one stream over.
      if (!wantsJsonOutput()) printUsage(process.stderr);
      throw new UsageError(`unknown command: ${command}`);
  }
}

/**
 * End the process with `code`, letting the event loop drain first.
 *
 * `process.exit(code)` tears the loop down mid-flight, and on Windows that
 * aborts: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win * async.c` and an exit status of 127, which every shell reads as "command not
 * found" — after a correct answer has already been printed. It takes two
 * in-flight HTTP connections to hit (a fallback from one endpoint route to
 * another), so it looks intermittent.
 *
 * The force-exit is the safety net `process.exit` provided: if something still
 * holds the loop open after a grace window, leave anyway rather than hanging a
 * CLI. It is `unref`d, so it does not itself keep the process alive.
 */
const EXIT_DRAIN_GRACE_MS = 3000;

function finish(code: number): void {
  process.exitCode = code;
  const bail = setTimeout(() => {
    process.exit(code);
  }, EXIT_DRAIN_GRACE_MS);
  bail.unref();
}

// Run main() only when this file is the process entrypoint, not when a test
// imports it. `argv[1]` is the path the user invoked, which is NOT this file
// when npm installed the command as a symlink (`/usr/local/bin/harness-dispatch`
// on Linux and macOS): node does not resolve it, so a name check alone runs
// nothing there and exits 0. Hence the realpath comparison below. Windows is
// unaffected — npm's .cmd shim passes the real dist/bin.js path.
const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? (process.argv[1] ?? "") : "";

function isThisFile(invoked: string): boolean {
  if (!invoked) return false;
  if (invoked.endsWith("bin.ts") || invoked.endsWith("bin.js")) return true;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isThisFile(entrypoint)) {
  void main(process.argv.slice(2))
    .then(async (code) => {
      // Spans are exported in batches; ending without a shutdown dropped
      // whatever the batch still held, which for a one-shot command is all
      // of them.
      await observability?.shutdownObservability();
      finish(code);
    })
    .catch(async (err: unknown) => {
      // A CLI user gets one actionable line, not a stack trace. Every Error is
      // flattened to its message — UsageError and config-loading failures
      // (missing file, bad YAML) are things the user typed and can fix, and
      // the codebase throws user-facing Errors by convention, so there is no
      // reliable way to tell "bug" from "bad input" by class here. Only a
      // non-Error throw (a genuine programming error) keeps its stack.
      // UsageError extends Error, so one check covers both.
      if (err instanceof Error) {
        // `--json` is a promise about the SHAPE of this command's output, on
        // the failure path too: otherwise anything parsing the output gets a
        // parse error instead of the reason. The message is the same; only
        // the envelope follows what was asked for. Errors still go to stderr,
        // so a caller reading stdout for results is unaffected either way.
        const { wantsJsonOutput } = await import("./cli/common.js");
        const wantsJson = wantsJsonOutput();
        process.stderr.write(
          wantsJson
            ? `${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`
            : `harness-dispatch: ${err.message}\n`,
        );
        process.exit(1);
      }
      throw err;
    });
}
