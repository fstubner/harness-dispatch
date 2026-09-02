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
 *  - removal ships in the same change as writing, so the ENTRY is never left
 *    orphaned when someone changes their mind. Backups are bounded rather than
 *    removed with it — see pruneOwnBackups for why undoing a registration is
 *    the worst moment to delete the record of what it replaced.
 *
 * It writes MCP server registration and nothing else — no instructions, no
 * hooks, no behavioural configuration. That is the part that rotted last time.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { commandAvailable } from "./dispatchers/shared/which-available.js";
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
/**
 * `absent`: neither the config file nor the client's command exists — not
 * installed. `missing-file`: the command is on PATH but the file is not there
 * yet (Claude Code writes it on first interactive launch) — the file will be
 * created with just our entry, which the client accepts as a user-scope
 * registration (checked against Claude Code 2.1.258: `claude mcp list` shows
 * the server from a file holding only `mcpServers`).
 */
export type ClientState =
  | "absent"
  | "missing-file"
  | "unreadable"
  | "missing-entry"
  | "matches"
  | "differs";

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

/**
 * Launch the build you are running RIGHT NOW, by absolute path.
 *
 * This is the one form the rest of this module argues against, and it exists
 * because refusing to write it did not stop anyone needing it. On a
 * development checkout the installed-package form is actively wrong: with
 * nothing installed globally, `npx -y harness-dispatch` fetches the published
 * version, so registering it would silently swap a checkout that is commits
 * ahead for an older release — a downgrade that looks like a successful setup.
 * That is exactly what `connect` found on the maintainer's machine, where the
 * hand-written absolute entry was the correct one.
 *
 * The trade is real and unchanged: an absolute path stops working the moment
 * the directory is renamed or deleted, silently, which is the failure that
 * started all of this. It is opt-in per run, the path is printed before it is
 * written, and `doctor` fails on a client entry naming a path that has gone —
 * so the failure mode this reintroduces is the one thing already checked for.
 */
export function devLaunchCommand(entryPath: string): string[] {
  return ["node", path.resolve(entryPath)];
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
  opts: {
    home?: string;
    command?: string[];
    /** Is any of these commands on PATH? Injectable so tests never depend on what is installed. */
    installed?: (commands: string[]) => boolean;
  } = {},
): ClientPlan[] {
  const desired = desiredEntry(configPath, opts.command ?? launchCommand());
  const installed = opts.installed ?? ((commands) => commands.some((c) => commandAvailable(c)));
  const locations: ClientConfigLocation[] = clientConfigLocations(opts.home);
  return locations.map(({ id, client, file, serversKey, commands }) => {
    const base = { id, client, file, serversKey, desired };
    if (!existsSync(file)) {
      return { ...base, state: installed(commands) ? ("missing-file" as const) : ("absent" as const) };
    }
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
  await pruneOwnBackups(file);
  return dest;
}

/** How many of our own backups of one file to keep. */
const KEEP_BACKUPS = 3;

const NOT_AN_OBJECT =
  "its config file is not a JSON object, so there is nothing to merge our entry into";

/**
 * The parsed file as something safe to spread into, or undefined if it is not.
 *
 * "Does it parse" and "is it the shape I am about to merge into" are different
 * questions, and only the first was being asked. An ARRAY parses fine and then
 * gets spread into an object: an array-rooted file came back as
 * `{"0":…,"1":…,"mcpServers":{…}}` and `connect` reported success. A backup is
 * always taken so it was recoverable — but this module edits OTHER
 * applications' config files, which is the highest-consequence thing this
 * product does, and it must not rewrite a shape it does not understand.
 *
 * `null`/absent stays mergeable: that is an empty file, which is the ordinary
 * first-run case.
 *
 * Applied at EVERY level this spreads, not just the root. The first version
 * guarded the root only, so `{"mcpServers": "oops"}` still had its string
 * rekeyed into `{"0":"o","1":"o",…}` and reported success — the same defect
 * one level down, found by the very next acceptance pass. Anywhere a spread
 * happens, this question has to be asked first.
 */
function mergeableRoot(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Keep the last few backups of a file, not all of them ever taken.
 *
 * Every write AND every removal takes one, so a few rounds of connect/--remove
 * left a pile of copies of `~/.claude.json` — a file this module's own comment
 * describes as holding live API keys — with nothing to prune them, no flag to
 * decline them, and no command to list them. An acceptance pass found one
 * already sitting on the maintainer's machine, and the module header's claim
 * that "nothing this creates is left orphaned" was true of the entry and false
 * of these.
 *
 * Bounded rather than removed entirely, and NOT cleared by `--remove`: the
 * moment someone undoes a registration is the worst possible moment to destroy
 * the copy of what it looked like before. Only files matching the name this
 * function itself writes are touched, so a backup anyone else made is not ours
 * to delete.
 */
async function pruneOwnBackups(file: string): Promise<void> {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.harness-dispatch-backup-`;
  try {
    const mine = (await readdir(dir))
      .filter((name) => name.startsWith(prefix))
      // The stamp is an ISO timestamp with `:` and `.` replaced, so it sorts
      // lexicographically in chronological order.
      .sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      await rm(path.join(dir, name), { force: true });
    }
  } catch {
    // Best effort: failing to tidy up must never fail the registration itself.
  }
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
async function writeJsonAtomic(
  file: string,
  value: unknown,
  opts: { createMode?: number } = {},
): Promise<void> {
  const tmp = `${file}.harness-dispatch-tmp-${process.pid}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });

  // Carry the original's permissions onto the replacement.
  //
  // `rename` swaps the INODE, so the file that survives has the temp file's
  // mode — 0644 under a typical umask — not its own. A `~/.claude.json` that
  // Claude Code created 0600 therefore came back group- and world-readable,
  // and that file holds live API keys: registering a server would have
  // silently widened access to somebody's credentials.
  //
  // The same module's backup() uses copyFile, which preserves mode, so the two
  // halves of one write path disagreed about whether the mode mattered. Found
  // by reading during an acceptance pass; POSIX-only, and unreproducible on
  // the Windows machine it was found on, which is exactly why it survived.
  const mode = await stat(file)
    .then((s) => s.mode & 0o777)
    .catch(() => opts.createMode);
  await writeFile(tmp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
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
  opts: { stamp: string; consented?: boolean },
): Promise<WriteOutcome> {
  const base = { id: plan.id, client: plan.client, file: plan.file };
  if (plan.state === "absent") {
    return { ...base, action: "skipped", reason: "no config file for this client" };
  }
  if (plan.state === "unreadable") {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  if (plan.state === "matches") return { ...base, action: "unchanged" };
  if (plan.state === "missing-file") {
    // Nothing to merge and nothing to back up. 0600 because this file is
    // where the client will later keep its own credentials.
    await writeJsonAtomic(
      plan.file,
      { [plan.serversKey]: { [ENTRY_KEY]: plan.desired } },
      { createMode: 0o600 },
    );
    return { ...base, action: "written" };
  }
  // An entry someone edited by hand is not ours to replace unasked.
  //
  // `removeClientEntry` has always refused this and this function did not, so
  // the protection existed on the half where the cost is lower. An acceptance
  // pass found OPERATIONS.md promising it for both and measured `connect
  // --clients claude-code` printing the hand-written entry it was about to
  // destroy and then destroying it, exit 0.
  //
  // `consented` is what the interactive path passes after showing the diff and
  // getting a yes — that prompt IS the consent, so nothing changes for someone
  // watching it happen. Naming a client on the command line is not the same
  // thing: it says which client, not "and overwrite whatever I put there".
  if (plan.state === "differs" && opts.consented !== true) {
    return {
      ...base,
      action: "skipped",
      reason:
        "its entry has been edited by hand — re-run interactively (no --clients, " +
        "no --yes) to see the difference and confirm, or pass --force to overwrite it",
    };
  }

  const parsed = readJsonFile(plan.file);
  if (!parsed.ok) {
    return { ...base, action: "skipped", reason: "its config file does not parse as JSON" };
  }
  const root = mergeableRoot(parsed.value);
  if (root === undefined) return { ...base, action: "skipped", reason: NOT_AN_OBJECT };
  const serversValue = mergeableRoot(root[plan.serversKey]);
  if (serversValue === undefined) {
    return { ...base, action: "skipped", reason: `its \`${plan.serversKey}\` is not a JSON object` };
  }
  const servers = { ...serversValue };
  const existing = mergeableRoot(servers[ENTRY_KEY]);
  if (existing === undefined) {
    return { ...base, action: "skipped", reason: `its existing \`${ENTRY_KEY}\` entry is not a JSON object` };
  }
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
  if (plan.state === "absent" || plan.state === "missing-file" || plan.state === "missing-entry") {
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
  const root = mergeableRoot(parsed.value);
  // Removal was already safe without this: our entry cannot be present in a
  // file this shape, so the `ENTRY_KEY in servers` check below returns
  // "unchanged" before anything is written. Kept anyway so both writers ask
  // the same question of the same file, rather than one of them being correct
  // by accident of a later check. A test for it was written and then deleted —
  // it passed with the guard removed, so it was evidence of nothing.
  if (root === undefined) return { ...base, action: "unchanged" };
  const serversValue = mergeableRoot(root[plan.serversKey]);
  if (serversValue === undefined) return { ...base, action: "unchanged" };
  const servers = { ...serversValue };
  if (!(ENTRY_KEY in servers)) return { ...base, action: "unchanged" };
  delete servers[ENTRY_KEY];

  const backupPath = await backup(plan.file, opts.stamp);
  await writeJsonAtomic(plan.file, { ...root, [plan.serversKey]: servers });
  return { ...base, action: "written", backupPath };
}
