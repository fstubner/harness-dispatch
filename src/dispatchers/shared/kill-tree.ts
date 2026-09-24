/**
 * Terminate a child process AND its descendants.
 *
 * On Windows, cross-spawn routes a .cmd/.bat target through cmd.exe, which
 * makes the real CLI a GRANDCHILD of this Node process. `child.kill()` only
 * signals the direct child, and killing cmd.exe does not terminate the process
 * it started, since Windows has no exec-replace. On timeout, output-cap
 * overflow, or early stream cancellation, that leaves the real CLI running
 * indefinitely — holding files/ports, consuming API quota, possibly still
 * writing to the workspace after the router has reported failure.
 * `taskkill /PID <pid> /T /F` kills the whole tree rooted at that PID.
 *
 * POSIX has no shell-indirection layer here, but the same problem one level
 * down: the direct child is an agent CLI that spawns its own shells and test
 * runners, which outlive a kill aimed at the CLI alone. Children are spawned
 * `detached` there (subprocess.ts / stream-subprocess.ts) so each is its own
 * process-group leader, and the group is signalled as a whole.
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
      // Not a group leader, or already gone — fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}
