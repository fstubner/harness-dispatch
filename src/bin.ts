#!/usr/bin/env node
/**
 * harness-dispatch CLI entrypoint.
 */

import { realpathSync } from "node:fs";
import { installOutputRedaction } from "./redaction.js";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveConfigPath } from "./config.js";
import { VERSION } from "./version.js";
import { startMcpServer } from "./mcp/server.js";
import { initObservability } from "./observability/index.js";
import { SAFETY_PROFILES, TASK_TYPES, UsageError, enumFlag, parsePositiveInt, wantsJsonOutput } from "./cli/common.js";
import { cmdConfigure } from "./cli/configure.js";
import { cmdConnect } from "./cli/connect.js";
import { cmdDispatch } from "./cli/dispatch.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdStatus, cmdUsage } from "./cli/report.js";
import { cmdAuth, cmdServe, serveOpts } from "./cli/serve.js";

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
      "  harness-dispatch status [--json]         Show route, quota, and breaker state.",
      "  harness-dispatch status --watch          Re-render status every --interval ms.",
      "  harness-dispatch usage [--json]          Show per-route call counts, quota, and billing kind.",
      "  harness-dispatch serve [--port 3333]     Serve MCP at /mcp and REST at /v1/*.",
      '  harness-dispatch dispatch "<prompt>"     Route one task and print the result.',
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
      "  --clients <ids>       connect: comma-separated client ids, instead of prompting.",
      "  --no-clients          configure: skip the offer to register with clients.",
      "  --remove              connect: remove the entry rather than write it.",
      "  --dev                 connect: point clients at THIS checkout's build, not the package.",
      "  --allow-paid          Allow doctor --live to probe paid or unknown-paid routes.",
      "  --service <id>        dispatch: run exactly this route, no fallback to others.",
      "  --safety <profile>    dispatch: read_only | workspace_edit | full_auto.",
      "  --task-type <type>    dispatch: execute | plan | review | local.",
      "  --no-fallback         dispatch: do not retry on another route if the first fails.",
      "  -h, --help            Show help.",
      "  -v, --version         Print the version and exit.",
      "",
    ].join("\n"),
  );
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
    "help", "version", "config", "json", "live", "allow-paid", "watch", "interval",
    "port", "host", "print", "yes", "force", "http",
    "service", "safety", "task-type", "no-fallback",
    "clients", "no-clients", "remove", "dev",
  ]);
  const unknownFlags = Object.keys(values).filter((k) => !knownFlags.has(k));
  if (unknownFlags.length > 0) {
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
    printUsage();
    return 0;
  }

  await initObservability();

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
  const configPath = resolveConfigPath(explicitConfigPath);

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
      return cmdConfigure(configPath, {
        print: Boolean(values.print),
        yes: Boolean(values.yes),
        force: Boolean(values.force),
        noClients: Boolean(values["no-clients"]),
        clients: typeof values.clients === "string" ? values.clients : undefined,
      });
    case "connect":
      return cmdConnect(configPath, {
        clients: typeof values.clients === "string" ? values.clients : undefined,
        remove: Boolean(values.remove),
        yes: Boolean(values.yes),
        force: Boolean(values.force),
        dev: Boolean(values.dev),
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
    // `route` kept as an alias for `dispatch`, which matches the MCP tool that
    // does the same thing. Same pattern as status/dashboard/list-services.
    case "dispatch":
    case "route": {
      const safety = enumFlag(values.safety, SAFETY_PROFILES, "--safety");
      const taskType = enumFlag(values["task-type"], TASK_TYPES, "--task-type");
      return cmdDispatch(rest.join(" ").trim(), configPath, {
        ...(typeof values.service === "string" ? { service: values.service } : {}),
        ...(safety !== undefined ? { safetyProfile: safety } : {}),
        ...(taskType !== undefined ? { taskType } : {}),
        noFallback: Boolean(values["no-fallback"]),
        json: Boolean(values.json),
      });
    }
    case "mcp":
      if (values.http !== undefined) {
        return cmdServe(configPath, serveOpts({ port: values.http, host: values.host }));
      }
      return main(configPath !== undefined ? ["--config", configPath] : []);
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
    .then((code) => {
      finish(code);
    })
    .catch((err: unknown) => {
      // A CLI user gets one actionable line, not a stack trace. Every Error is
      // flattened to its message — UsageError and config-loading failures
      // (missing file, bad YAML) are things the user typed and can fix, and
      // the codebase throws user-facing Errors by convention, so there is no
      // reliable way to tell "bug" from "bad input" by class here. Only a
      // non-Error throw (a genuine programming error) keeps its stack.
      if (err instanceof UsageError || err instanceof Error) {
        // `--json` is a promise about the SHAPE of this command's output, on
        // the failure path too: otherwise anything parsing the output gets a
        // parse error instead of the reason. The message is the same; only
        // the envelope follows what was asked for. Errors still go to stderr,
        // so a caller reading stdout for results is unaffected either way.
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
