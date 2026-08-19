/**
 * The cross-process file lock must always terminate.
 *
 * The first version of this loop retried unconditionally when `statSync` on
 * the lock directory failed — correct for "the lock vanished between two
 * calls", catastrophic for "mkdir failed because the PARENT directory does not
 * exist", where statSync fails identically and forever. Locking inside a
 * not-yet-created state directory spun until killed and hung the whole test
 * suite.
 *
 * An unbounded retry is never acceptable in a path that runs on every
 * dispatch, so the deadline is checked on that branch too, and the lock
 * creates its own parent.
 */

import { promises as fs, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/file-lock.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-flock-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("withFileLock", () => {
  it("returns promptly when the parent directory does not exist yet", () => {
    // The hang. Must complete, and must actually run the body.
    const target = path.join(dir, "not", "created", "yet", "state.json");
    const started = Date.now();
    const ran = withFileLock(target, () => "done");
    expect(ran).toBe("done");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("runs the body and releases", () => {
    const target = path.join(dir, "state.json");
    expect(withFileLock(target, () => 1)).toBe(1);
    expect(withFileLock(target, () => 2)).toBe(2);
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  it("serialises nested-in-time access without deadlocking on itself", () => {
    // Same process, sequential acquisitions of the same key — the common case
    // for a CLI that records several results before exiting.
    const target = path.join(dir, "s.json");
    const order: number[] = [];
    for (let i = 0; i < 5; i += 1) withFileLock(target, () => order.push(i));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("steals a stale lock rather than waiting forever", () => {
    const target = path.join(dir, "stale.json");
    mkdirSync(`${target}.lock`);
    // Backdate past the staleness window so it is reclaimable.
    const old = new Date(Date.now() - 60_000);
    require("node:fs").utimesSync(`${target}.lock`, old, old);
    const started = Date.now();
    expect(withFileLock(target, () => "stolen")).toBe("stolen");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still runs the body if the lock cannot be acquired at all", () => {
    // Deliberate: an unserialised write is what we had before the lock, so
    // running anyway is no worse. Dropping the update would be strictly worse.
    const target = path.join(dir, "held.json");
    mkdirSync(`${target}.lock`); // fresh, so not stealable
    const started = Date.now();
    expect(withFileLock(target, () => "ran anyway")).toBe("ran anyway");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(`${target}.lock`)).toBe(true); // not ours, not removed
  });
});
