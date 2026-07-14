/**
 * Terminate a child process AND its descendants.
 *
 * On Windows, CLI binaries invoked through the `cmd /c <path>` fallback
 * (see windows-cmd.ts) make the real target process a GRANDCHILD of this
 * Node process — cmd.exe is the direct child, and it spawns the actual CLI
 * itself. `child.kill()` only signals the direct child; killing cmd.exe
 * does not terminate the process it started, since Windows has no
 * exec-replace and cmd.exe just blocks waiting on its own child. On
 * timeout, output-cap overflow, or early stream cancellation, that left the
 * real CLI process running indefinitely — holding files/ports, still
 * consuming API quota, and possibly still writing to the workspace after
 * the router had already reported failure.
 *
 * `taskkill /PID <pid> /T /F` kills the whole process tree rooted at the
 * given PID. POSIX doesn't need this — there's no shell-indirection layer
 * in this codebase on that platform — so `child.kill()` there is unchanged.
 */
import { execFile, type ChildProcess } from "node:child_process";

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {
      // Best effort. A non-zero exit here just means the process (or its
      // whole tree) was already gone — nothing further to do either way.
    });
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}
