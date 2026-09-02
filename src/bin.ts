#!/usr/bin/env node
/**
 * harness-dispatch CLI entrypoint.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import yaml from "js-yaml";

import { ensureHttpToken, maskToken, readHttpToken, rotateHttpToken, tokenPath } from "./auth.js";
import { AUTO_DETECT_COMMANDS, loadConfig, resolveConfigPath } from "./config.js";
import { LeaderboardCache } from "./leaderboard.js";
import { VERSION } from "./version.js";
import { commandAvailable } from "./dispatchers/shared/which-available.js";
import { codexLoginState } from "./dispatchers/shared/harness-login.js";
import { clientConfigLocations, inspectClientEntries } from "./mcp-clients.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import { startMcpServer } from "./mcp/server.js";
import { initObservability } from "./observability/index.js";
import { QuotaCache } from "./quota.js";
import { Router } from "./router.js";
import { buildStatus, buildUsage, renderStatusText, renderUsageText } from "./status.js";
import { startHttpServer } from "./http/server.js";
import type { RouteHints, RouterConfig, SafetyProfile, TaskType } from "./types.js";
import { billingIsBlocked, buildRouteBilling } from "./billing.js";
import { effectiveSafetyProfile } from "./safety.js";
import { configToYaml, isUneditedGenerated, stampGenerated, type YamlOpts } from "./configure-yaml.js";
import {
  desiredEntry,
  devLaunchCommand,
  launchCommand,
  planClientWrites,
  removeClientEntry,
  writeClientEntry,
  type ClientPlan,
  type ClientState,
} from "./client-register.js";
import { stateRoot, userConfigPath } from "./state-dir.js";

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


async function cmdConfigure(
  configPath: string | undefined,
  explicitConfigPath: string | undefined,
  opts: {
    print: boolean;
    yes: boolean;
    force: boolean;
    noClients: boolean;
    clients?: string | undefined;
  },
): Promise<number> {
  // configure's --config names where it will WRITE, so a path that does not
  // exist yet is the normal first-run case, not a typo.
  const target = configPath ?? userConfigPath();
  // A file configure wrote and nobody edited is regenerated from a fresh
  // detection rather than loaded: loading it would make it authoritative and
  // hide the harness installed since — the reason the user is re-running.
  // Anything else on disk is the user's, loaded so its settings migrate, and
  // guarded below. See stampGenerated for the natural-order story.
  const existing = existsSync(target) ? await fs.readFile(target, "utf-8") : undefined;
  const regenerate = existing !== undefined && isUneditedGenerated(existing);
  const config = await loadConfig(regenerate ? undefined : configPath, { allowMissing: true });
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
        config.envRefs?.get(svc.apiKey) === undefined &&
        config.apiKeyRefs?.get(svc.name) === undefined,
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

  // "Detected" is only true when detection ran. Over an edited file that lists
  // its own routes it does not (the file is authoritative), and an acceptance
  // pass measured `configure --yes --force` printing "Detected 1 harness route"
  // with a second harness on PATH that never appeared in the output.
  const plural = routeCount === 1 ? "" : "s";
  process.stdout.write(
    config.detectionRan === false
      ? `${routeCount} route${plural} from ${path.resolve(configPath ?? target)} — detection did not run, ` +
          "because this file lists its own routes. To merge harnesses installed since, add " +
          "`detect: true` to it; to start over from a fresh detection, delete it first.\n"
      : `Detected ${routeCount} harness route${plural}.\n`,
  );
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

  if (regenerate) {
    process.stdout.write(
      `\n${path.resolve(target)} is unedited configure output — ` +
        `${opts.yes ? "regenerating it from this detection" : "--yes will regenerate it from this detection"}.\n`,
    );
  }
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
  if (existsSync(target) && !opts.force && !regenerate) {
    process.stderr.write(
      `configure: ${target} already exists and would be overwritten.\n` +
        "Use --print to inspect the generated YAML, --config <other-path> to write\n" +
        "elsewhere, or --force to overwrite it deliberately.\n",
    );
    return 1;
  }
  // 0600, because this file can contain a LITERAL api_key: `apiKeyForYaml`
  // deliberately preserves one rather than replacing it with a `${VAR}`
  // reference, so `configure` can write a real credential to disk. It was
  // written with default permissions — 0644 under a typical umask — in a
  // module family that is careful everywhere else (leaderboard 0600, state dir
  // 0700, client-register carries the original file's mode). Found by an
  // acceptance pass from reading, POSIX-only and not reproduced on Windows,
  // where the mode is ignored.
  //
  // Applied on create only: `writeFile`'s mode does not change an existing
  // file's permissions, so re-running `configure` will not silently tighten a
  // file the user deliberately made group-readable.
  // The default target lives in the state directory, which a first run has
  // not created yet. Same mode the rest of the state dir gets.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, stampGenerated(yamlText), { encoding: "utf-8", mode: 0o600 });
  const absoluteTarget = path.resolve(target);
  process.stdout.write(`Wrote ${absoluteTarget}.\n`);

  // The last step of setup used to be "here is some JSON, paste it somewhere".
  // Nobody owned the result, and the paths in it later moved — which is how one
  // machine ended up running a dead entry, a dead hook, and a third client
  // reading a different config, all silently. Offer to do it instead.
  if (!opts.noClients) {
    process.stdout.write("\n");
    return cmdConnect(configPath, {
      clients: opts.clients,
      remove: false,
      yes: false,
      force: false,
      // Setup registers the installed package. A checkout entry is a
      // deliberate choice made by someone who knows they have a checkout, not
      // something to infer during first-run setup.
      dev: false,
    });
  }

  process.stdout.write(
    "\nMCP snippet (uses an absolute --config path so it resolves correctly no matter what\n" +
      "directory the MCP client launches from — a relative path or none at all silently\n" +
      "falls back to the shipped defaults, ignoring every edit you make to this file):\n",
  );
  // The SAME entry `connect` writes, built by the same function.
  //
  // This printed a hardcoded `harness-dispatch --config <path>` while connect
  // writes whatever `launchCommand()` resolves to — `npx -y harness-dispatch
  // --config <path>` without a global install. So pasting the snippet this
  // command prints and then running `connect --remove` was answered "has an
  // entry we did not write — left alone unless --force", and exit 1. The tool
  // called its own documented output hand-edited, and blocked both update and
  // removal on the manual-install path it had just recommended.
  printMcpSnippet(desiredEntry(absoluteTarget, launchCommand()));
  process.stdout.write("Or let `harness-dispatch connect` write it for you.\n");
  return 0;
}

/** The entry, in the shape a client's config file wants it pasted. */
function printMcpSnippet(entry: { command: string; args: string[] } | undefined): void {
  if (entry === undefined) return;
  process.stdout.write(
    JSON.stringify({ mcpServers: { "harness-dispatch": entry } }, null, 2) + "\n",
  );
}

/**
 * Register this server with the MCP clients on this machine — the last step of
 * setup, which used to be "paste this snippet somewhere".
 *
 * Interactive when a human is at a terminal, flag-driven otherwise. A prompt
 * that blocks is right in front of a person and wrong in CI, so with no TTY
 * and no `--clients` this reports what it WOULD do and writes nothing, rather
 * than hanging or guessing.
 */
async function cmdConnect(
  configPath: string | undefined,
  opts: {
    clients?: string | undefined;
    remove: boolean;
    yes: boolean;
    force: boolean;
    dev: boolean;
  },
): Promise<number> {
  const target = path.resolve(configPath ?? userConfigPath());
  if (!existsSync(target) && !opts.remove) {
    process.stderr.write(
      `connect: no config at ${target}. Run \`harness-dispatch configure --yes\` first —\n` +
        "a client entry pointing at a config that does not exist is the failure this\n" +
        "command exists to prevent.\n",
    );
    return 1;
  }

  // `import.meta.url` is this running file — dist/bin.js for an installed or
  // built copy. "The build you are running now" is the only honest answer to
  // which checkout --dev means, and it needs no flag value to get wrong.
  const selfPath = fileURLToPath(import.meta.url);
  const plans = planClientWrites(
    target,
    opts.dev ? { command: devLaunchCommand(selfPath) } : {},
  );
  if (opts.dev && !opts.remove) {
    process.stdout.write(
      `Development entry: clients will launch ${selfPath} directly.\n` +
        "That is an absolute path — it stops working, silently, if this directory is\n" +
        "renamed or deleted. `harness-dispatch doctor` fails when that happens.\n\n",
    );
  }
  const known = new Set(plans.map((p) => p.id));
  const requested = opts.clients
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested?.filter((id) => !known.has(id)) ?? [];
  if (unknown.length > 0) {
    process.stderr.write(
      `connect: unknown client${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Known: ${[...known].join(", ")}.\n`,
    );
    return 1;
  }

  const installed = plans.filter((p) => p.state !== "absent");
  if (installed.length === 0) {
    process.stdout.write(
      "No MCP clients found on this machine (looked for Claude Code and Cursor).\n" +
        "Nothing to register. Add this to whichever client you use, then re-run\n" +
        "`harness-dispatch connect` if you install one of the two above:\n",
    );
    // Setup has to end with something you can act on. Without this, a machine
    // with no client detected got a cheerful "nothing to do" and no way to
    // finish wiring anything up — the snippet was the ONLY output this replaced.
    printMcpSnippet(plans[0]?.desired);
    return 0;
  }

  if (!opts.remove) {
    // Stated once, up front, rather than only inside the diff for entries that
    // happen to differ. What gets written should not be something you can only
    // learn from a client being in a particular state.
    process.stdout.write(`Entry to write: ${JSON.stringify(plans[0]!.desired)}\n\n`);
  }
  process.stdout.write(`${opts.remove ? "Removing from" : "Registering with"} clients:\n`);
  for (const p of installed) {
    process.stdout.write(
      `  ${p.client.padEnd(12)} ${p.file}  (${describeState(p.state, opts.remove)})\n`,
    );
    if (p.state === "differs") {
      process.stdout.write(`    currently: ${JSON.stringify(summariseEntry(p.current))}\n`);
    }
  }

  const chosen = requested
    ? installed.filter((p) => requested.includes(p.id))
    : await chooseInteractively(installed, opts);
  // Consent to replace a HAND-EDITED entry comes from ANSWERING the
  // interactive prompt, which shows the difference first, or from --force.
  //
  // Neither `--clients` nor `--yes` counts. `--clients` says which client, not
  // "overwrite whatever I put there"; `--yes` skips the question rather than
  // answering it. The first version of this gate accepted "no client named" as
  // consent, which let `--yes` through — the same class it was written to
  // close, one flag over.
  const prompted = requested === undefined && !opts.yes && process.stdin.isTTY === true;
  const consented = opts.force || prompted;
  if (chosen === undefined) {
    process.stdout.write("Nothing written.\n");
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let failed = false;
  let wrote = false;
  for (const plan of chosen) {
    const outcome = opts.remove
      ? await removeClientEntry(plan, { stamp, force: opts.force })
      : await writeClientEntry(plan, { stamp, consented });
    if (outcome.action === "written") {
      wrote = true;
      process.stdout.write(
        `${opts.remove ? "Removed from" : "Wrote"} ${outcome.client} ` +
          `(${outcome.backupPath !== undefined ? `backup: ${outcome.backupPath}` : `created ${outcome.file}`})\n`,
      );
    } else if (outcome.action === "unchanged") {
      process.stdout.write(
        `${outcome.client}: ${opts.remove ? "no entry of ours to remove" : "already correct"}, nothing changed.\n`,
      );
    } else {
      failed = true;
      process.stderr.write(`Skipped ${outcome.client}: ${outcome.reason}\n`);
    }
  }
  // Only when something actually changed. Telling someone to restart an
  // application after a run that wrote nothing is advice with no cause.
  if (wrote && !failed) {
    process.stdout.write(
      `\nRestart the client(s) so they pick up the ${opts.remove ? "removal" : "new server"}.\n`,
    );
  }
  return failed ? 1 : 0;
}

/**
 * The listing describes state from the point of view of what is about to
 * happen. Under `--remove`, "already registered correctly" describes the entry
 * accurately and reads as nonsense under the heading "Removing from clients",
 * where the same state means "this is the one that will go".
 */
function describeState(state: ClientState, removing: boolean): string {
  if (removing) {
    return {
      absent: "not installed",
      "missing-file": "installed, no config file yet — nothing to remove",
      unreadable: "config does not parse — will be left alone",
      "missing-entry": "no entry of ours to remove",
      matches: "our entry is here — will be removed",
      differs: "has an entry we did not write — left alone unless --force",
    }[state];
  }
  return {
    absent: "not installed",
    "missing-file": "installed, no config file yet — one will be created",
    unreadable: "config does not parse — will be left alone",
    "missing-entry": "no harness-dispatch entry yet",
    matches: "already registered correctly",
    differs: "has a DIFFERENT entry",
  }[state];
}

/** An entry's shape without its `env`, which holds live API keys on real machines. */
function summariseEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const { env: _hidden, ...rest } = entry as Record<string, unknown>;
  return rest;
}

/**
 * Ask, when there is someone to ask.
 *
 * Returns undefined for "write nothing". An entry that already differs is the
 * case that most needs a human: on the machine this was written for, the
 * differing entry was the WORKING one.
 */
async function chooseInteractively(
  plans: ClientPlan[],
  opts: { yes: boolean; remove?: boolean },
): Promise<ClientPlan[] | undefined> {
  // What counts as actionable INVERTS under --remove.
  //
  // Registering: `matches` means the entry is already what we would write, so
  // there is nothing to do. Removing: `matches` is exactly the entry being
  // removed, so filtering it out left nothing actionable — and the command
  // printed "our entry is here — will be removed", exited 0, and changed
  // nothing. Reproduced byte-for-byte: same md5 before and after.
  //
  // Only the bare form was affected, because `--clients` bypasses this
  // function entirely. That is the form README documents twice and
  // OPERATIONS.md once, and no test covered this command at all.
  // Stated as what IS actionable rather than what is not: the states are
  // absent / unreadable / missing-entry / matches / differs, and under
  // --remove only the two that actually hold an entry qualify. Written as a
  // negation, `absent` (no config file at all) slipped through.
  const actionable = plans.filter((p) =>
    opts.remove === true
      ? p.state === "matches" || p.state === "differs"
      : p.state !== "matches" && p.state !== "unreadable",
  );
  if (actionable.length === 0) return [];
  // `--yes` skips the question; it does NOT answer it.
  //
  // The consent gate added for `--clients` treated "no client named" as
  // "consented", and `--yes` takes that path — so an acceptance pass measured
  // `connect --yes` overwriting a hand-edited entry with no prompt and no
  // --force, exit 0, while the same flags on `--remove` correctly refused.
  // "Do not ask me" is not the same answer as "yes, replace what I wrote".
  if (opts.yes) return actionable;
  if (!process.stdin.isTTY) {
    process.stdout.write(
      // Names the command, not just the flags: this is reached from
      // `configure --yes` too, where "or --yes" told the user to pass the flag
      // they had already passed.
      "\nNot a terminal, so nothing was written. Run `harness-dispatch connect --clients " +
        `${actionable.map((p) => p.id).join(",")}\` (or \`connect --yes\`) to register.\n`,
    );
    return undefined;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\nApply to ${actionable.length} client(s)? [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes" ? actionable : undefined;
  } finally {
    rl.close();
  }
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

/**
 * Can we actually persist state? Breaker cooldowns, quota counters and job
 * records all live here, and every write path deliberately swallows its own
 * failures so a dispatch is never lost to a bookkeeping problem. The cost of
 * that choice is silence, which is what this check buys back.
 */
function stateDirWritable(): { ok: boolean; detail: string } {
  const dir = stateRoot();
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "", { mode: 0o600 });
    rmSync(probe, { force: true });
    return { ok: true, detail: `writable: ${dir}` };
  } catch (err) {
    return {
      ok: false,
      detail:
        `NOT writable: ${dir} (${err instanceof Error ? err.message : String(err)}). ` +
        `Breaker cooldowns and usage counters will not persist, and jobs may be ` +
        `reported as orphaned after they have actually succeeded.`,
    };
  }
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
      // Names the file, because "which config is this looking at" was the
      // question: `configure` run from one directory and `doctor` from
      // another used to load different things and neither said so.
      detail:
        `${Object.keys(runtime.config.services).length} configured route(s)` +
        (configPath !== undefined
          ? ` from ${path.resolve(configPath)}`
          : " (no config file found; shipped defaults with auto-detected harnesses)"),
    },
    // This one DOES fail, unlike the advisory git check below.
    //
    // A client entry naming a path that is not there is not a preference or a
    // missing optional tool — there is no setup in which it is intended. And
    // it is invisible from the client side: one that cannot spawn its server
    // simply has no tools, which looks identical to never having installed
    // anything. On this maintainer's machine that state survived a repo rename
    // by months, silently, along with a hook pointing at the same dead
    // directory.
    //
    // Not-configured is NOT a failure: a machine with no client entry gets
    // "not registered with any client", ok. Only a broken one fails.
    (() => {
      const entries = inspectClientEntries();
      const broken = entries.filter((e) => e.missingPaths.length > 0);
      if (entries.length === 0) {
        // Name the client that IS here, so "not registered" reads as the
        // next step rather than as "nothing to register with".
        const present = clientConfigLocations()
          .filter((c) => c.commands.some((cmd) => commandAvailable(cmd)))
          .map((c) => c.client);
        return {
          name: "mcp-clients",
          ok: true,
          detail:
            present.length > 0
              ? `${present.join(", ")} installed but harness-dispatch is not registered with it — ` +
                "run `harness-dispatch connect`"
              : "not registered with any MCP client this tool knows how to read " +
                "(Claude Code, Cursor), and none is installed — run `harness-dispatch connect` " +
                "after installing one",
        };
      }
      return {
        name: "mcp-clients",
        ok: broken.length === 0,
        detail:
          broken.length === 0
            ? entries.map((e) => `${e.client}: ${e.entry} resolves`).join("; ")
            : broken
                .map(
                  (e) =>
                    // "references", not "launches ... from": missingPaths
                    // holds any path the entry names that is not there, and
                    // that is routinely the `--config` argument rather than
                    // the launch binary. An acceptance pass found the message
                    // reaching the right conclusion by the wrong description —
                    // a missing explicit --config does make the CLI exit 1,
                    // but it is not where the client launches from.
                    `${e.client} (${e.file}) references a path that does not exist: ` +
                    `${e.missingPaths.join(", ")} (entry: ${e.entry}) — that client has been ` +
                    "getting NO tools from this server, silently. `harness-dispatch connect` " +
                    "rewrites the entry.",
                )
                .join(" | "),
      };
    })(),
    // Not required to dispatch — reported, never a hard fail.
    //
    // The `workspace` tool shells out to git for diff/apply, so without it a
    // delegate's work COMPLETES in an isolated workspace and then the tool
    // that retrieves it dies with `spawn git ENOENT` wrapped as "could not
    // diff <file> for this workspace" — a message about a program the user was
    // never told they needed. README lists the requirements as Node plus a
    // harness. The changes are recoverable by hand via workspaceRoot in the
    // response, which is why this warns here instead of failing the install.
    //
    // `ok: true` UNCONDITIONALLY, matching http-auth / billing-policy /
    // safety-policy below: doctor's exit code is the sum of every check, so a
    // false here made `doctor` exit 1 on a machine with no git — a
    // configuration the README calls supported. Any install script or CI step
    // gating on that exit code would fail a working install, and the code
    // would stop distinguishing "your install is broken" from "an optional
    // tool is missing". The advice belongs in `detail`, which is where the
    // other advisory checks put theirs.
    {
      name: "git",
      ok: true,
      detail: commandAvailable("git")
        ? "available — workspace diff/apply and git_worktree isolation can run"
        : "NOT FOUND — optional. Dispatch still works, but the `workspace` tool " +
          "cannot diff or apply an isolated run's changes, and the git_worktree " +
          "policy is unavailable. Retrieve changes by hand from the " +
          "workspaceRoot in the dispatch response.",
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
      // Saved state that could not be read, which is NOT a config problem and
      // so never reached this list: `doctor` read `configWarnings` directly
      // and stayed silent about an unreadable breaker record or usage counters
      // that are not reaching disk. Two acceptance passes recorded that
      // silence as an open item; `status` grew a "State problems" heading and
      // `doctor` did not follow.
      name: "saved-state",
      ok: (status.stateWarnings?.length ?? 0) === 0,
      detail:
        status.stateWarnings && status.stateWarnings.length > 0
          ? status.stateWarnings.join(" | ")
          : "readable",
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
      // Nothing checked this, so an unwritable state directory surfaced only
      // as jobs mysteriously reported "the dispatch server exited before the
      // run finished" — a false cause, 90s after the work had actually
      // succeeded.
      name: "state-dir",
      ok: stateDirWritable().ok,
      detail: stateDirWritable().detail,
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
  // A ready route is one whose CLI is on PATH. That said nothing about whether
  // the CLI could actually make a request: an installed, never-logged-in Codex
  // passed routes, billing and safety, and the first dispatch then failed with
  // a raw OpenAI 401 that never mentioned `codex login`. The cold-install walk
  // in acceptance/0.8.0.md is where that was seen. The CLI is asked directly
  // (see harness-login.ts for why not the credential file), and only a
  // definite "not logged in" fails the check.
  const codexRoutes = status.routes.filter(
    (route) => status.ready.includes(route.id) && route.harness === "codex" && route.command,
  );
  const loginStates = await Promise.all(
    codexRoutes.map(async (route) => ({ route, state: await codexLoginState(route.command!) })),
  );
  const loggedOut = loginStates.filter((entry) => entry.state === "logged_out");
  checks.push({
    name: "harness-login",
    ok: loggedOut.length === 0,
    detail:
      loginStates.length === 0
        ? "no ready route has a login state this tool knows how to ask for (Codex only, today)"
        : loggedOut.length > 0
          ? `${loggedOut.map((entry) => entry.route.id).join(", ")}: codex reports "Not logged in" — ` +
            "run `codex login` (or `codex login --with-api-key`), or every dispatch to it fails " +
            "with 401 Unauthorized from OpenAI"
          : loginStates
              .map(
                (entry) =>
                  `${entry.route.id}: ${entry.state === "logged_in" ? "logged in" : "could not determine (codex login status gave no answer)"}`,
              )
              .join("; "),
  });
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

/**
 * One dispatch from the command line — the CLI half of the `dispatch` MCP
 * tool, named to match it (`route` stays as an alias).
 *
 * It took flags because it had none and that made it unusable for the one job
 * it is most needed for. An acceptance pass has to exercise the build IN THE
 * WORKING TREE; the MCP tool runs in whatever server process is already
 * connected, which is a different artifact from a different moment. So the CLI
 * is the honest path there — and it hardcoded taskType "execute" with two
 * fallbacks, meaning a pass asking for one read-only call on one route could
 * silently get an execute-profile run on up to three. The first acceptance
 * pass to attempt a live dispatch wrote its own Node script against dist/
 * rather than use this, which is the tell.
 */
async function cmdDispatch(
  prompt: string,
  configPath: string | undefined,
  opts: {
    service?: string | undefined;
    safetyProfile?: SafetyProfile | undefined;
    taskType?: TaskType | undefined;
    noFallback: boolean;
    json: boolean;
  },
): Promise<number> {
  if (!prompt) {
    process.stderr.write(
      'dispatch: missing prompt. Usage: dispatch [--service <id>] [--safety <profile>]\n' +
        '          [--task-type <type>] [--no-fallback] [--json] "<prompt>"\n',
    );
    return 1;
  }
  const runtime = await buildRuntime(configPath);
  const hints: RouteHints = { taskType: opts.taskType ?? "execute" };
  if (opts.safetyProfile !== undefined) hints.safetyProfile = opts.safetyProfile;

  // A named service goes through routeTo, which is what "run exactly this
  // route" means — not route() with a hint, which can still fall elsewhere.
  const { result, decision } = opts.service
    ? await runtime.router.routeTo(opts.service, prompt, [], process.cwd(), {
        ...(opts.safetyProfile !== undefined ? { safetyProfile: opts.safetyProfile } : {}),
        ...(opts.taskType !== undefined ? { taskType: opts.taskType } : {}),
      })
    : await runtime.router.route(prompt, [], process.cwd(), {
        hints,
        maxFallbacks: opts.noFallback ? 0 : 2,
      });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ result, routing: decision ?? null }, null, 2)}\n`,
    );
    return result.success ? 0 : 1;
  }
  if (decision) {
    const beat = decision.candidates?.length
      ? ` [${decision.candidates.map((c) => `${c.route} ${c.score}`).join(", ")}]`
      : "";
    process.stderr.write(`dispatch: ${decision.service} (${decision.reason})${beat}\n`);
  }
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  if (!result.success) {
    process.stderr.write(`${result.error ?? "routing failed"}\n`);
    return 1;
  }
  return 0;
}

const SAFETY_PROFILES = ["read_only", "workspace_edit", "full_auto"] as const;
const TASK_TYPES = ["execute", "plan", "review", "local"] as const;

/**
 * An enum-valued flag: rejected by name when it is not one of the listed
 * values, never silently dropped to a default.
 *
 * `--safety read_onlyy` dropping to workspace_edit would hand a delegate MORE
 * access than the caller asked for — the same failure the MCP and HTTP
 * surfaces were both hardened against, and the reason `hints` is strict there.
 */
function enumFlag<T extends string>(
  value: unknown,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(
    `${flag}: invalid value ${JSON.stringify(value)}. Valid: ${allowed.join(", ")}.`,
  );
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
  // flexible — the cost is that an unknown flag is silently accepted. `status
  // --jsonn` printed human text and exited 0, so a cron job piping it to jq
  // got garbage AND a success code. PRODUCT.md names automation as a user, and
  // a wrong exit code is the one thing automation cannot recover from.
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
  //
  // The MCP handshake has always reported this in serverInfo, so an agent
  // consumer could see it. A human diagnosing an install had no way to ask —
  // `--version` exited 1 with "unknown option", which reads like the binary is
  // broken rather than like the flag is missing.
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
  // `--config` with no value: parseArgs yields boolean true, which reached
  // path.join and threw ERR_INVALID_ARG_TYPE as a raw Node stack trace.
  if (values.config !== undefined && typeof values.config !== "string") {
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
      return cmdConfigure(configPath, explicitConfigPath, {
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
    // `route` kept as an alias: it was the name for two years of history, and
    // `dispatch` matches the MCP tool that does the same thing. Same pattern
    // as status/dashboard/list-services above.
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
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

/**
 * End the process with `code`, letting the event loop drain first.
 *
 * `process.exit(code)` tears the loop down mid-flight, and on Windows that
 * aborts: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win * async.c` and an exit status of 127, which every shell reads as "command not
 * found". It fired AFTER a correct answer had been printed, so the work was
 * done and the report of it was a crash.
 *
 * Reproduced 3/3 across three acceptance passes, and confirmed here: two
 * endpoint routes, the first answering 200 with an unusable body and the
 * second succeeding. The fallback is what makes it two in-flight HTTP
 * connections; `--no-fallback` and a refused connection both exited 1 cleanly,
 * which is why it looked intermittent. Setting `exitCode` instead removes it,
 * measured on the same probe.
 *
 * The force-exit is the safety net `process.exit` was providing: if something
 * still holds the loop open after a grace window, leave anyway rather than
 * hanging a CLI. It is `unref`d, so it does not itself keep the process alive
 * — every command measured here exits in under a second without it firing.
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
// on Linux and macOS): node does not resolve it, so a name check alone
// silently ran nothing there and exited 0 — every documented command was a
// no-op for every non-Windows `npm install -g` user through 0.8.0. Windows
// never hit it because npm's .cmd shim passes the real dist/bin.js path.
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
        process.stderr.write(`harness-dispatch: ${err.message}
`);
        process.exit(1);
      }
      throw err;
    });
}
