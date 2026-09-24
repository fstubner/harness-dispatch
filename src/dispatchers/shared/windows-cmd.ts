/**
 * Cross-platform CLI binary resolution.
 *
 * On Windows, CLI tools installed via npm/scoop/winget are typically `.cmd` or
 * `.bat` wrappers. Node's `spawn` cannot execute those directly without a
 * shell — attempting to do so throws ENOENT.
 *
 * This must NOT hand back `{ command: "cmd", prefixArgs: ["/c", path] }` for
 * dispatchers to spawn via node:child_process: that is a Windows
 * command-injection hole. Node's spawn() escapes cmd.exe metacharacters in an
 * argument only when IT decides cmd.exe indirection is needed (when the target
 * path itself ends in .bat/.cmd), so pre-constructing the "cmd /c <path>"
 * invocation bypasses that — an argument containing a literal `"` breaks out
 * of the quoting and lets a subsequent `&`-chained command execute, and
 * `%ENV_VAR%` sequences get expanded, in text (the CLI's own model/prompt)
 * that is never meant to be shell-interpreted at all.
 *
 * So resolveCliCommand never constructs the cmd.exe wrapper itself. For npm's
 * own generated .cmd shim, which just re-invokes `node <script>.js`, it skips
 * cmd.exe entirely by spawning node directly on the underlying script — faster,
 * and immune to shell metacharacters since there is no shell in the loop. Every
 * other .cmd/.bat shape (pnpm, yarn, scoop, hand-rolled) goes straight to
 * cross-spawn (see subprocess.ts/stream-subprocess.ts), which detects the
 * .bat/.cmd target itself and applies correct, tested escaping.
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
  // pass through unchanged.
  return { command: windowsResolved, prefixArgs: [] };
}
