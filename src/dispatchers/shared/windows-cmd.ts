/**
 * Cross-platform CLI binary resolution.
 *
 * On Windows, CLI tools installed via npm/scoop/winget are typically `.cmd` or
 * `.bat` wrappers. Node's `spawn` cannot execute those directly without a
 * shell — attempting to do so throws ENOENT.
 *
 * This used to hand back `{ command: "cmd", prefixArgs: ["/c", path] }` and
 * let dispatchers spawn that directly via node:child_process. That's exactly
 * the shape of a real Windows command-injection bug: Node's spawn() only
 * safely escapes cmd.exe metacharacters in an argument when IT decides
 * cmd.exe indirection is needed (i.e. when the target path itself ends in
 * .bat/.cmd) — manually pre-constructing the "cmd /c <path>" invocation
 * ourselves bypasses that. Confirmed empirically on Node 24.14.1: an
 * argument containing a literal `"` character breaks out of the quoting and
 * lets a subsequent `&`-chained command execute for real. `%ENV_VAR%`
 * sequences also got expanded regardless (a separate info-leak/argument-
 * splitting bug, since the CLI's own model/prompt text is never meant to be
 * shell-interpreted at all).
 *
 * Fix: resolveCliCommand no longer constructs the cmd.exe wrapper itself.
 * For the one case worth the extra step — npm's own generated .cmd shim,
 * which just re-invokes `node <script>.js` — we skip cmd.exe entirely by
 * spawning node directly on the underlying script (faster, and immune to
 * shell metacharacters since there's no shell in the loop at all). For every
 * other .cmd/.bat shape (pnpm, yarn, scoop, hand-rolled), we hand the
 * resolved path straight to cross-spawn (see subprocess.ts/
 * stream-subprocess.ts), which is a widely-used, purpose-built library for
 * exactly this problem — it detects the .bat/.cmd target itself and applies
 * correct, tested escaping, verified against the same injection payload
 * above (no command execution, no %VAR% expansion).
 */

import path from "node:path";
import fs from "node:fs/promises";
import which from "which";

export interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

async function resolveWindowsCandidate(bin: string, first: string): Promise<string> {
  try {
    const all = (await which(bin, {
      all: true,
      nothrow: true,
    } as Parameters<typeof which>[1] & { all: true })) as unknown;
    if (Array.isArray(all)) {
      const native = all.find(
        (candidate) =>
          path.extname(candidate).toLowerCase() === ".exe" &&
          !candidate.toLowerCase().includes("\\windowsapps\\"),
      );
      if (native) return native;
    }
  } catch {
    // Fall back to the first candidate resolved by which.
  }
  return first;
}

async function resolveNpmCmdShim(cmdPath: string): Promise<ResolvedCommand | null> {
  try {
    const text = await fs.readFile(cmdPath, "utf8");
    const match = text.match(/"%dp0%\\([^"]+?\.js)"/i);
    if (!match?.[1]) return null;
    const scriptPath = path.join(
      path.dirname(cmdPath),
      match[1].replace(/\\/g, path.sep),
    );
    await fs.access(scriptPath);
    return { command: process.execPath, prefixArgs: [scriptPath] };
  } catch {
    return null;
  }
}

export async function resolveCliCommand(bin: string): Promise<ResolvedCommand> {
  const resolved = await which(bin, { nothrow: true });
  if (!resolved) {
    // Let spawn surface the ENOENT — caller may be running in a sandbox where
    // PATH resolution is deliberately stubbed.
    return { command: bin, prefixArgs: [] };
  }

  if (process.platform !== "win32") {
    return { command: resolved, prefixArgs: [] };
  }

  const windowsResolved = await resolveWindowsCandidate(bin, resolved);
  const ext = path.extname(windowsResolved).toLowerCase();
  if (ext === ".cmd") {
    const npmShim = await resolveNpmCmdShim(windowsResolved);
    if (npmShim) return npmShim;
  }
  // Any other .cmd/.bat shape (pnpm, yarn, scoop, hand-rolled) — or a native
  // .exe — is handed straight to cross-spawn as prefixArgs: []. It detects
  // .bat/.cmd targets itself and applies correct escaping; native binaries
  // pass through unchanged, same as before.
  return { command: windowsResolved, prefixArgs: [] };
}
