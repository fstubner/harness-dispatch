/**
 * Cross-platform CLI binary resolution.
 *
 * On Windows, CLI tools installed via npm/scoop/winget are typically `.cmd` or
 * `.bat` wrappers. Node's `spawn` cannot execute those directly without a
 * shell — attempting to do so throws ENOENT or silently fails on some systems.
 * The fix is to invoke them through `cmd /c <resolved path>`.
 *
 * On non-Windows (or when the binary resolves to a native executable), we just
 * return the resolved absolute path with no prefix args.
 *
 * NOTE: spaces in the resolved path are fine because `spawn` passes `args` as
 * a list. On current Windows Node/cmd.exe, `cmd /c <resolved path>` with the
 * resolved path as one argv element handles npm wrappers under Program Files.
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
  if (ext === ".cmd" || ext === ".bat") {
    if (ext === ".cmd") {
      const npmShim = await resolveNpmCmdShim(windowsResolved);
      if (npmShim) return npmShim;
    }
    return { command: "cmd", prefixArgs: ["/c", windowsResolved] };
  }
  return { command: windowsResolved, prefixArgs: [] };
}
