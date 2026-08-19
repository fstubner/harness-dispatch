/**
 * Terminate a child process AND its descendants.
 *
 * On Windows, a CLI binary reached through a cmd.exe shim makes the real
 * target process a GRANDCHILD of this
 * Node process — cmd.exe is the direct child, and it spawns the actual CLI
 * itself. `child.kill()` only signals the direct child; killing cmd.exe
 * does not terminate the process it started, since Windows has no
 * exec-replace and cmd.exe just blocks waiting on its own child. On
 * timeout, output-cap overflow, or early stream cancellation, that left the
 * real CLI process running indefinitely — holding files/ports, still
 * consuming API quota, and possibly still writing to the workspace after
 * the router had already reported failure.
 *
 * NOTE: resolveCliCommand no longer constructs `cmd /c <path>` itself — that
 * was removed after it proved injectable (windows-cmd.ts). cross-spawn still
 * routes .cmd/.bat targets through cmd.exe, so the grandchild shape persists
 * and this is still load-bearing; only the code that creates it moved.
 *
 * `taskkill /PID <pid> /T /F` kills the whole process tree rooted at the
 * given PID.
 *
 * POSIX has no shell-indirection layer in this codebase, but it has the SAME
 * grandchild problem one level down: the direct child is an agent CLI that
 * spawns its own shells and test runners. `child.kill()` reached only the
 * CLI, so on timeout or output-cap kill its subprocesses kept running — and
 * kept writing to the workspace after failure was reported, the exact harm
 * described above for Windows. The children are spawned `detached` on POSIX
 * (subprocess.ts / stream-subprocess.ts) so each is its own process-group
 * leader, and the group is signalled as a whole.
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
  if (child.pid !== undefined) {
    try {
      // Negative pid = the whole process group rooted at the child.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader (spawned by an older build, or already gone) —
      // fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}
