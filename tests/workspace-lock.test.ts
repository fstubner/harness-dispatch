/**
 * The workspace lock must exclude across PROCESSES.
 *
 * Its predecessor was a module-scope Map, so it only ever excluded within one
 * process — and every job used to get its own process, which made the
 * `shared_locked` guarantee decorative. These tests spawn real processes,
 * because an in-process test cannot tell a working lock from a fictional one:
 * the old implementation passes every same-process assertion.
 */

import { execFileSync } from "node:child_process";
import { promises as fs, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireWorkspaceLock, LOCK_STALE_MS } from "../src/workspace-lock.js";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "workspace-lock.js");

let dir: string;
let stateDir: string;
let workDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-wslock-"));
  stateDir = path.join(dir, "state");
  workDir = path.join(dir, "work");
  await fs.mkdir(workDir, { recursive: true });
  process.env.HARNESS_DISPATCH_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.HARNESS_DISPATCH_STATE_DIR;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

function lockDir(): string {
  return path.join(stateDir, "workspace-locks");
}

describe("acquireWorkspaceLock — same process", () => {
  it("serializes overlapping acquisitions in arrival order", async () => {
    const order: string[] = [];
    const first = await acquireWorkspaceLock(workDir);
    order.push("first-held");

    let secondHeld = false;
    const second = acquireWorkspaceLock(workDir).then((rel) => {
      secondHeld = true;
      order.push("second-held");
      return rel;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(secondHeld).toBe(false); // still blocked by the first

    first();
    (await second)();
    expect(order).toEqual(["first-held", "second-held"]);
  });

  it("does not block a different working directory", async () => {
    const other = path.join(dir, "other");
    mkdirSync(other, { recursive: true });
    const a = await acquireWorkspaceLock(workDir);
    const b = await acquireWorkspaceLock(other); // would hang if over-broad
    a();
    b();
    expect(true).toBe(true);
  });

  it("removes its lock file on release, leaving nothing behind", async () => {
    const release = await acquireWorkspaceLock(workDir);
    expect(readdirSync(lockDir()).length).toBe(1);
    release();
    expect(readdirSync(lockDir())).toEqual([]);
  });

  it("keeps lock files out of the workspace itself", async () => {
    const release = await acquireWorkspaceLock(workDir);
    // Nothing dropped into the user's directory, which would otherwise show up
    // in git status and in the workspace diff handed back to the caller.
    expect(readdirSync(workDir)).toEqual([]);
    release();
  });
});

describe("acquireWorkspaceLock — across processes", () => {
  it.skipIf(!existsSync(DIST))(
    "blocks a second PROCESS while the first holds it",
    async () => {
      // The case the old in-process Map could never handle.
      const release = await acquireWorkspaceLock(workDir);
      const script = `
        const { acquireWorkspaceLock } = await import(${JSON.stringify(new URL(`file://${DIST.replace(/\\/g, "/")}`).href)});
        try {
          await acquireWorkspaceLock(${JSON.stringify(workDir)}, 600);
          console.log("ACQUIRED");
        } catch (e) {
          console.log("BLOCKED");
        }
      `;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, HARNESS_DISPATCH_STATE_DIR: stateDir },
      });
      expect(out.trim()).toBe("BLOCKED");
      release();
    },
    30_000,
  );

  it.skipIf(!existsSync(DIST))(
    "lets a second PROCESS in once the first releases",
    async () => {
      const release = await acquireWorkspaceLock(workDir);
      release();
      const script = `
        const { acquireWorkspaceLock } = await import(${JSON.stringify(new URL(`file://${DIST.replace(/\\/g, "/")}`).href)});
        const rel = await acquireWorkspaceLock(${JSON.stringify(workDir)}, 2000);
        console.log("ACQUIRED");
        rel();
      `;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, HARNESS_DISPATCH_STATE_DIR: stateDir },
      });
      expect(out.trim()).toBe("ACQUIRED");
    },
    30_000,
  );
});

describe("acquireWorkspaceLock — recovery", () => {
  it("steals a lock whose holder died without releasing", async () => {
    // A crashed holder must not wedge the directory forever. Written with a
    // pid that cannot be running and a heartbeat inside the stale window, so
    // this proves the liveness check rather than the timeout.
    mkdirSync(lockDir(), { recursive: true });
    const file = path.join(lockDir(), readdirSyncSafeName(workDir));
    writeFileSync(
      file,
      JSON.stringify({ pid: 0x7ffffffe, key: workDir, beatMs: Date.now() }),
      "utf8",
    );
    const release = await acquireWorkspaceLock(workDir, 3000);
    release();
    expect(true).toBe(true);
  });

  it("steals a lock whose heartbeat has gone stale", async () => {
    mkdirSync(lockDir(), { recursive: true });
    const file = path.join(lockDir(), readdirSyncSafeName(workDir));
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, key: workDir, beatMs: Date.now() - LOCK_STALE_MS - 1000 }),
      "utf8",
    );
    // Note the pid is THIS process, i.e. definitely alive: only staleness can
    // release it here.
    const release = await acquireWorkspaceLock(workDir, 3000);
    release();
    expect(true).toBe(true);
  });

  it("treats a corrupt lock file as absent rather than wedging", async () => {
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(path.join(lockDir(), readdirSyncSafeName(workDir)), "{ not json", "utf8");
    const release = await acquireWorkspaceLock(workDir, 3000);
    release();
    expect(true).toBe(true);
  });
});

/** Reproduce the module's own file naming, so tests can plant a lock. */
function readdirSyncSafeName(workingDir: string): string {
  const key =
    process.platform === "win32"
      ? path.resolve(workingDir).toLowerCase()
      : path.resolve(workingDir);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}
