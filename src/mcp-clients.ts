/**
 * Is the MCP client on this machine still pointing at something that exists?
 *
 * WHY THIS EXISTS. A client that cannot spawn its server does not report an
 * error — it just has no tools, which looks exactly like not having installed
 * anything. On the maintainer's machine that state lasted from a repo rename
 * until someone happened to read the config: Claude Code was launching
 * `harness-router/dist/bin.js`, a path deleted months earlier, and a
 * SessionStart hook pointed at the same dead directory. Both failed silently
 * every session. Nothing in this tool could have told them, because nothing
 * looked.
 *
 * READ ONLY. This inspects other applications' config files and never writes
 * to them. A previous version of this project DID write to a user's global
 * config, was removed a version later, and left orphans behind that were still
 * there seven minor versions on — which is the reason a reporting check comes
 * first and a writing one may never come at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ClientConfigLocation {
  /** Human name, for the doctor line. */
  client: string;
  file: string;
}

export interface ClientEntryReport {
  client: string;
  file: string;
  /** The server key as it appears in that client's config. */
  entry: string;
  /**
   * Paths this entry names that do not exist. Empty means nothing to report:
   * either every path resolves, or the entry names none to check.
   */
  missingPaths: string[];
}

/**
 * Only shapes actually read on a real machine.
 *
 * Claude Desktop and VS Code are deliberately absent: their formats are known
 * to me from documentation rather than from a file I have opened, and VS Code
 * uses a different key (`servers`, not `mcpServers`) — guessing at a config
 * format is how you misreport someone's healthy setup as broken.
 */
export function clientConfigLocations(home: string = homedir()): ClientConfigLocation[] {
  return [
    { client: "Claude Code", file: path.join(home, ".claude.json") },
    { client: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
  ];
}

/** An arg that looks like a filesystem path rather than a flag or a bare command. */
function looksLikePath(value: string): boolean {
  if (value.startsWith("-")) return false;
  return value.includes("/") || value.includes("\\");
}

/**
 * A bare command — `npx`, `harness-dispatch`, `node` — is NOT checked.
 *
 * Resolving it means replicating PATH lookup and shims, and getting that wrong
 * would report a working install as broken. The failure this check exists for
 * is an absolute path to a directory that has been renamed or deleted, which
 * needs none of that.
 */
function missingPathsIn(entry: unknown): string[] {
  if (!entry || typeof entry !== "object") return [];
  const e = entry as { command?: unknown; args?: unknown; cwd?: unknown };
  const candidates: string[] = [];
  for (const v of [e.command, e.cwd]) {
    if (typeof v === "string" && looksLikePath(v)) candidates.push(v);
  }
  if (Array.isArray(e.args)) {
    for (const a of e.args) {
      if (typeof a === "string" && looksLikePath(a)) candidates.push(a);
    }
  }
  return candidates.filter((p) => !existsSync(p));
}

/** Does this entry appear to be OUR server, by key or by what it launches? */
function isHarnessDispatch(key: string, entry: unknown): boolean {
  if (/harness[-_]?(dispatch|router)/i.test(key)) return true;
  const e = entry as { command?: unknown; args?: unknown } | null;
  const args = Array.isArray(e?.args) ? e.args : [];
  return [e?.command, ...args].some(
    (v) => typeof v === "string" && /harness[-_]?(dispatch|router)/i.test(v),
  );
}

/**
 * Every harness-dispatch entry found across the clients on this machine, with
 * any paths it names that are not there.
 *
 * A client with no config file, or no entry for this server, contributes
 * nothing — not having installed it is not a fault. A config that will not
 * parse is skipped rather than reported: it is that application's problem, and
 * this tool has no business grading someone else's JSON.
 */
export function inspectClientEntries(home?: string): ClientEntryReport[] {
  const out: ClientEntryReport[] = [];
  for (const { client, file } of clientConfigLocations(home)) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [key, entry] of Object.entries(servers as Record<string, unknown>)) {
      if (!isHarnessDispatch(key, entry)) continue;
      out.push({ client, file, entry: key, missingPaths: missingPathsIn(entry) });
    }
  }
  return out;
}
