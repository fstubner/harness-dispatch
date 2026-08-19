/**
 * Breaker-store filename round-tripping (finding 2 of the third review).
 *
 * This header previously claimed to cover findings 1 AND 2. It covered only
 * this one — the `.strict()` change shipped with no test at all, which a
 * reviewer noticed before any user did. Boundary-strictness cases now live in
 * surface-parity.test.ts; this file is about filenames.
 *
 * Both are the same family as everything else this codebase has produced: an
 * input that is accepted, does nothing, and is never reported. These two are
 * the worst instances because one disables a safety limit and the other takes
 * the entire tool offline.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BreakerStore } from "../src/breaker-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-strict-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("BreakerStore filenames round-trip", () => {
  const NAMES = ["codex_cli", "café_cli", "日本語", "../../escape", "a b", "x%y"];

  it.each(NAMES)("survives a route named %j", (name) => {
    const store = new BreakerStore(dir);
    store.update(name, () => ({ failures: 3, blockedUntilMs: null }));
    expect(store.loadAll()[name]?.failures).toBe(3);
  });

  it("keeps ASCII names readable on disk", async () => {
    // The escaping exists to be reversible, not to obfuscate — a human
    // debugging this should still see codex_cli.json.
    new BreakerStore(dir).update("codex_cli", () => ({ failures: 1, blockedUntilMs: null }));
    expect(await fs.readdir(dir)).toContain("codex_cli.json");
  });

  it("does not escape the state directory", async () => {
    // Asserted on the filename itself rather than by scanning the parent —
    // the parent here is os.tmpdir(), which is full of unrelated .json files,
    // so a directory scan would have been checking someone else's litter.
    new BreakerStore(dir).update("../../escape", () => ({ failures: 1, blockedUntilMs: null }));
    const written = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    // What matters is that no path SEPARATOR survives, so the name stays a
    // single flat file inside the state dir. Literal dots are harmless:
    // "..%2F..%2Fescape.json" is a filename, not a traversal.
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("/");
    expect(written[0]).not.toContain("\\");
    expect(written[0]).toContain("%2F");
  });

  it("skips an unreadable filename instead of taking the tool down", async () => {
    // The real defect: encode used %<charCode> and decode used
    // decodeURIComponent, which disagree for anything non-ASCII. `café_cli`
    // wrote caf%e9_cli.json, loadAll() threw URIError, and the Router
    // constructor calls loadAll() unguarded — so `status`, `doctor` AND the
    // MCP server all failed to start. One route name, total outage.
    await fs.writeFile(path.join(dir, "%zz-not-ours.json"), "{}", "utf8");
    const store = new BreakerStore(dir);
    store.update("codex_cli", () => ({ failures: 2, blockedUntilMs: null }));
    expect(() => store.loadAll()).not.toThrow();
    expect(store.loadAll()["codex_cli"]?.failures).toBe(2);
  });
});

describe("filenames survive a case-insensitive filesystem", () => {
  it("keeps routes that differ only by case as separate records", () => {
    // NTFS is case-insensitive: `A.json` and `a.json` are one file, so the
    // second save clobbered the first and loadAll() returned one route. Linux
    // kept both, so the same config behaved differently per platform.
    const store = new BreakerStore(dir);
    store.update("A", () => ({ failures: 1, blockedUntilMs: null }));
    store.update("a", () => ({ failures: 2, blockedUntilMs: null }));
    const all = store.loadAll();
    expect(all["A"]?.failures).toBe(1);
    expect(all["a"]?.failures).toBe(2);
  });

  it("round-trips a name containing the escape character itself", () => {
    const store = new BreakerStore(dir);
    store.update("x~y", () => ({ failures: 7, blockedUntilMs: null }));
    expect(store.loadAll()["x~y"]?.failures).toBe(7);
  });

  it("round-trips mixed case with non-ASCII", () => {
    const store = new BreakerStore(dir);
    store.update("Café_CLI", () => ({ failures: 4, blockedUntilMs: null }));
    expect(store.loadAll()["Café_CLI"]?.failures).toBe(4);
  });
});
