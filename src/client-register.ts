/**
 * Register this server with the MCP clients installed on this machine.
 *
 * WHY THIS EXISTS. Setup was a copy-paste job: `configure` printed a JSON
 * snippet and the user pasted it somewhere. Nobody owned the result, and on
 * the maintainer's machine that produced, at the same time — a Claude Code
 * entry launching a directory renamed away months earlier, a session hook
 * pointing at the same dead path, and a working Cursor entry with no
 * `--config`, so the two clients disagreed about which routes existed while
 * both appeared to work.
 *
 * WHY IT IS PARANOID. This project has failed at exactly this before. v0.1.0
 * shipped a setup command that wrote `~/.claude/CLAUDE.md` and a hooks entry;
 * v0.2.0 removed the command and neither artifact was ever cleaned up. Both
 * were still on the machine seven minor versions later, the hook failing
 * silently every session. So:
 *
 *  - only the two config shapes actually opened on a real machine are written;
 *  - every write is backed up, merged, and swapped in atomically;
 *  - an entry that already exists and differs is REPORTED, never overwritten
 *    without consent — that Cursor entry was good, and a blind writer would
 *    have destroyed a working setup in the name of fixing it;
 *  - removal ships in the same change as writing, so nothing this creates is
 *    left orphaned when someone changes their mind.
 *
 * It writes MCP server registration and nothing else — no instructions, no
 * hooks, no behavioural configuration. That is the part that rotted last time.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { clientConfigLocations, type ClientConfigLocation } from "./mcp-clients.js";

/** The key this server is registered under, and the only one we ever touch. */
export const ENTRY_KEY = "harness-dispatch";

export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * What a client's config says about us right now.
 *
 * `absent` is the client not being installed — not a fault, and not something
 * to offer. `unreadable` covers a config that will not parse: that is the
 * other application's problem, and the one thing we must not do is rewrite a
 * file we could not understand.
 */
export type ClientState = "absent" | "unreadable" | "missing-entry" | "matches" | "differs";

export interface ClientPlan {
  id: string;
  client: string;
  file: string;
  /** Carried from the client table so writers never re-derive it. */
  serversKey: string;
  state: ClientState;
  /** The entry currently registered, when there is one. */
  current?: unknown;
  /** What we would write. */
  desired: ServerEntry;
}

/**
 * The entry to write.
 *
 * The `--config` path is absolute on purpose. A relative path — or none, which
 * is what the machine's Cursor entry had — silently falls back to the shipped
 * defaults, so the client quietly ignores every edit made to the config file
 * and disagrees with the client next to it about which routes exist. Both look
 * like they work, which is what made it survive.
 */
export function desiredEntry(configPath: string, command: string[]): ServerEntry {
  const [cmd, ...prefix] = command;
  return { command: cmd ?? "harness-dispatch", args: [...prefix, "--config", path.resolve(configPath)] };
}

/**
 * How to launch us, in the way most likely to still work next month.
 *
 * A global install is preferred because it needs no network and starts faster.
 * `npx -y harness-dispatch` is the fallback, not an absolute path into a
 * checkout: an absolute path is precisely what broke here, and the failure was
 * invisible for months.
 *
 * This resolves PATH, which the read-only inspector deliberately refuses to do
 * — but the trade is opposite. There, a wrong guess reports a healthy install
 * as broken. Here, guessing "harness-dispatch" when nothing by that name is
 * installed writes an entry that can never spawn, which is the exact silent
 * breakage this whole feature exists to end.
 */
export function launchCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolvesOnPath("harness-dispatch", env)
    ? ["harness-dispatch"]
    : ["npx", "-y", "harness-dispatch"];
}

function resolvesOnPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  // On Windows the executable is `harness-dispatch.cmd`/`.exe`, never the bare
  // name — checking only the bare name would answer "not installed" on every
  // Windows machine and send everyone to the slower npx form.
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(path.join(dir, cmd + ext.toLowerCase()))) return true;
      if (existsSync(path.join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

function sameEntry(a: unknown, b: ServerEntry): boolean {
  const e = a as { command?: unknown; args?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.command !== b.command) return false;
  if (!Array.isArray(e.args) || e.args.length !== b.args.length) return false;
  return e.args.every((v, i) => v === b.args[i]);
}

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ok: false };
  }
}

/**
 * What would change, per client, if we registered right now.
 *
 * Reports only. Nothing here writes, so a caller can show this and ask — which
 * is the whole point, given one of the entries this was written for was
 * already correct.
 */
export function planClientWrites(
  configPath: string,
  opts: { home?: string; command?: string[] } = {},
): ClientPlan[] {
  const desired = desiredEntry(configPath, opts.command ?? launchCommand());
  const locations: ClientConfigLocation[] = clientConfigLocations(opts.home);
  return locations.map(({ id, client, file, serversKey }) => {
    const base = { id, client, file, serversKey, desired };
    if (!existsSync(file)) return { ...base, state: "absent" as const };
    const parsed = readJsonFile(file);
    if (!parsed.ok) return { ...base, state: "unreadable" as const };
    const servers = (parsed.value as Record<string, unknown> | null)?.[serversKey];
    const current =
      servers && typeof servers === "object"
        ? (servers as Record<string, unknown>)[ENTRY_KEY]
        : undefined;
    if (current === undefined) return { ...base, state: "missing-entry" as const };
    return {
      ...base,
      state: sameEntry(current, desired) ? ("matches" as const) : ("differs" as const),
      current,
    };
  });
}

/**
 * Copy the file next to itself before touching it.
 *
 * Same directory, so it inherits that directory's permissions rather than
 * landing somewhere world-readable: `~/.claude.json` holds live API keys on
 * this machine, and a backup is a copy of those keys.
 */
async function backup(file: string, stamp: string): Promise<string> {
  const dest = `${file}.harness-dispatch-backup-${stamp}`;
  await copyFile(file, dest);
  return dest;
}

/**
 * Replace a JSON file without ever leaving it half-written.
 *
 * Write a sibling temp file, parse it BACK, and only then rename over the
 * original — rename within a directory is atomic, so a reader sees the old
 * file or the new one and never a truncated one. A half-written
 * `~/.claude.json` costs someone their entire Claude Code configuration, which
 * is a far worse outcome than failing to register.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.harness-dispatch-tmp-${process.pid}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, text, "utf8");
  try {
    JSON.parse(await readFile(tmp, "utf8"));
  } catch (err) {
    await rm(tmp, { force: true });
    throw new Error(
      `Refusing to write ${file}: the replacement did not parse back as JSON (${String(err)}). ` +
        "The original file is untouched.",
    );
  }
  await rename(tmp, file);
}

export interface WriteOutcome {
  id: string;
  client: string;
  file: string;
  action: "written" | "unchanged" | "skipped";
  backupPath?: string;
  reason?: string;
}

/**
 * Register (or re-register) this server in one client's config.
 *
 * Merges: every other server, and every field of an existing entry we do not
 * set, is preserved. `env` in particular holds live API keys on real machines
 * — dropping it while "fixing" an entry would break unrelated servers and leak
 * nothing but the user's afternoon.
 */
export async function writeClientEntry(
  plan: ClientPlan,
  opts: { stamp: string },
): Promise<WriteOutcome> {
  const base = { id: plan.id, client: plan.client, file: plan.file };
  if (plan.state === "absent") {
    return { ...base, action: "skipped", reason: "no config file for this client" };
  }
  if (plan.state === "unreadable") {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  if (plan.state === "matches") return { ...base, action: "unchanged" };

  const parsed = readJsonFile(plan.file);
  if (!parsed.ok) {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  const root = (parsed.value ?? {}) as Record<string, unknown>;
  const servers = { ...((root[plan.serversKey] as Record<string, unknown> | undefined) ?? {}) };
  const existing = (servers[ENTRY_KEY] as Record<string, unknown> | undefined) ?? {};
  servers[ENTRY_KEY] = { ...existing, ...plan.desired };

  const backupPath = await backup(plan.file, opts.stamp);
  await writeJsonAtomic(plan.file, { ...root, [plan.serversKey]: servers });
  return { ...base, action: "written", backupPath };
}

/**
 * Take our entry back out.
 *
 * Ships with the writer, not later: entries this tool created outliving the
 * feature that created them is the documented way this project has already
 * gone wrong once. An entry that no longer looks like ours is reported and
 * LEFT ALONE — someone edited it deliberately, and deleting a hand-tuned entry
 * because it no longer matches our template would be its own version of the
 * same mistake.
 */
export async function removeClientEntry(
  plan: ClientPlan,
  opts: { stamp: string; force?: boolean },
): Promise<WriteOutcome> {
  const base = { id: plan.id, client: plan.client, file: plan.file };
  if (plan.state === "absent" || plan.state === "missing-entry") {
    return { ...base, action: "unchanged" };
  }
  if (plan.state === "unreadable") {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  if (plan.state === "differs" && opts.force !== true) {
    return {
      ...base,
      action: "skipped",
      reason: "its entry has been edited by hand — remove it yourself, or pass --force",
    };
  }

  const parsed = readJsonFile(plan.file);
  if (!parsed.ok) {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  const root = (parsed.value ?? {}) as Record<string, unknown>;
  const servers = { ...((root[plan.serversKey] as Record<string, unknown> | undefined) ?? {}) };
  if (!(ENTRY_KEY in servers)) return { ...base, action: "unchanged" };
  delete servers[ENTRY_KEY];

  const backupPath = await backup(plan.file, opts.stamp);
  await writeJsonAtomic(plan.file, { ...root, [plan.serversKey]: servers });
  return { ...base, action: "written", backupPath };
}
