/**
 * A dead holder's lock that cannot be moved aside.
 *
 * Both lock loops took a dead or stale lock by renaming it, and `continue`d
 * straight back to the top whether or not the rename worked — skipping the
 * deadline check and the only wait. A rename that stays refused (on Windows, a
 * handle opened without share-delete) then spun the loop synchronously:
 * measured, a 2 s timeout blocked the process for 14 s, and every heartbeat in
 * it stopped. Found in an audit. The rename is forced to fail here — for
 * 4 s, then allowed, so the broken loop ends by taking the lock instead of
 * hanging the test run: a lock that gives up at its deadline never sees that.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refuse = vi.hoisted(() => ({ until: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      const lockish = String(from).endsWith(".lock") || String(from).endsWith(".json");
      if (lockish && Date.now() < refuse.until) {
        const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return real.renameSync(from, to);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hd-steal-refused-"));
  vi.stubEnv("HARNESS_DISPATCH_STATE_DIR", dir);
  refuse.until = Date.now() + 4_000;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("a lock that cannot be stolen", () => {
  it("the workspace lock still gives up at its deadline", async () => {
    const { acquireWorkspaceLock, workspaceLockPath } = await import("../src/workspace-lock.js");
    const work = path.join(dir, "work");
    mkdirSync(work);
    const lockFile = workspaceLockPath(work);
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: 0x7ffffffe, key: work, beatMs: Date.now() }));
    const started = Date.now();
    await expect(acquireWorkspaceLock(work, 500)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("the state-file lock still gives up at its deadline", async () => {
    const { withFileLock, LockNotAcquiredError } = await import("../src/file-lock.js");
    const file = path.join(dir, "state.json");
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const started = Date.now();
    expect(() => withFileLock(file, () => "ran", { requireLock: true })).toThrow(LockNotAcquiredError);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
