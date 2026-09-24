/** `connect` / `disconnect`: register this server with other MCP clients. */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devLaunchCommand, planClientWrites, removeClientEntry, writeClientEntry, type ClientPlan, type ClientState } from "../client-register.js";
import { userConfigPath } from "../state-dir.js";
import { printMcpSnippet } from "./configure.js";

/**
 * Register this server with the MCP clients on this machine — the last step of
 * setup.
 *
 * Interactive when a human is at a terminal, flag-driven otherwise: with no
 * TTY and no `--clients` it reports what it WOULD do and writes nothing,
 * rather than hanging on a prompt or guessing.
 */
export async function cmdConnect(
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
  // which checkout --dev means.
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
    // Setup has to end with something you can act on: with no client detected
    // the snippet is the only way to finish wiring anything up.
    printMcpSnippet(plans[0]?.desired);
    return 0;
  }

  if (!opts.remove) {
    // Stated once, up front: what gets written should not be learnable only
    // from a client happening to be in a particular state.
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
  // Neither `--clients` nor `--yes` counts: `--clients` says which client, not
  // "overwrite whatever I put there"; `--yes` skips the question rather than
  // answering it.
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
 * happen: under "Removing from clients", the state that means "already
 * registered correctly" means "this is the one that will go".
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
 * case that most needs a human — the differing entry can well be the working
 * one.
 */
async function chooseInteractively(
  plans: ClientPlan[],
  opts: { yes: boolean; remove?: boolean },
): Promise<ClientPlan[] | undefined> {
  // What counts as actionable INVERTS under --remove. Registering: `matches`
  // means the entry is already what we would write, so there is nothing to do.
  // Removing: `matches` is exactly the entry being removed.
  //
  // Stated as what IS actionable rather than what is not: the states are
  // absent / unreadable / missing-entry / matches / differs, and under
  // --remove only the two that actually hold an entry qualify. Written as a
  // negation, `absent` (no config file at all) slips through.
  const actionable = plans.filter((p) =>
    opts.remove === true
      ? p.state === "matches" || p.state === "differs"
      : p.state !== "matches" && p.state !== "unreadable",
  );
  if (actionable.length === 0) return [];
  // `--yes` skips the question; it does NOT answer it. "Do not ask me" is not
  // the same answer as "yes, replace what I wrote" — the consent gate above is
  // what decides that.
  if (opts.yes) return actionable;
  if (!process.stdin.isTTY) {
    process.stdout.write(
      // Names the command, not just the flags: this is reached from
      // `configure --yes` too, where "or --yes" would tell the user to pass a
      // flag they already passed.
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
