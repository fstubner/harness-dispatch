import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BreakerStore } from "../src/breaker-store.js";

describe("BreakerStore", () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hr-breaker-store-"));
    stateDir = path.join(dir, "breaker_state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadAll() returns {} when nothing has been persisted yet", () => {
    expect(new BreakerStore(stateDir).loadAll()).toEqual({});
  });

  it("save() then loadAll() round-trips a tripped snapshot", () => {
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
    });
  });

  it("save() with a fully-healthy snapshot removes the record instead of writing a no-op", () => {
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("codex_cli", { failures: 0, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({});
  });

  it("tracks multiple services independently", () => {
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("claude_code_cli", { failures: 2, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
      claude_code_cli: { failures: 2, blockedUntilMs: null },
    });
  });

  it("a later save() for one service doesn't clobber another service's entry", () => {
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("claude_code_cli", { failures: 1, blockedUntilMs: null });
    store.save("codex_cli", { failures: 0, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({
      claude_code_cli: { failures: 1, blockedUntilMs: null },
    });
  });

  it("gives each route its own file, so concurrent writers cannot clobber each other", () => {
    // This is the whole point of the per-route split. The previous
    // single-blob format did read-modify-write over one file and lost 600 of
    // 800 writes under four concurrent processes; separate files make that
    // impossible by construction rather than by locking.
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("claude_code_cli", { failures: 3, blockedUntilMs: null });
    const files = readdirSync(stateDir).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["claude_code_cli.json", "codex_cli.json"]);
  });

  it("keeps a route name with path separators inside the state directory", () => {
    const store = new BreakerStore(stateDir);
    store.save("../../escape", { failures: 1, blockedUntilMs: 1_900_000_000_000 });
    // Nothing written above the state dir, and the name still round-trips.
    expect(readdirSync(dir).sort()).toEqual(["breaker_state"]);
    expect(store.loadAll()["../../escape"]).toEqual({
      failures: 1,
      blockedUntilMs: 1_900_000_000_000,
    });
  });

  it("loadAll() skips an unreadable record but keeps the well-formed ones", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "codex_cli.json"), JSON.stringify({ failures: 3, blockedUntilMs: 1_900_000_000_000 }));
    writeFileSync(path.join(stateDir, "garbage.json"), "{ not valid json");
    writeFileSync(path.join(stateDir, "nulled.json"), "null");
    expect(new BreakerStore(stateDir).loadAll()).toEqual({
      codex_cli: { failures: 3, blockedUntilMs: 1_900_000_000_000 },
    });
  });

  it("loadAll() REPORTS an unreadable record instead of letting it read as healthy", () => {
    // Skipping it (the test above) is right — the state is gone and guessing
    // at it would be worse. Staying silent about it is not: a skipped record
    // is indistinguishable from a route that was never tripped, so a corrupt
    // file un-trips a live cooldown and every surface says `failures=0`.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "codex_cli.json"), "{ not valid json");
    writeFileSync(path.join(stateDir, "nulled.json"), "null");
    writeFileSync(
      path.join(stateDir, "cursor_cli.json"),
      JSON.stringify({ failures: 3, blockedUntilMs: 1_900_000_000_000 }),
    );

    const store = new BreakerStore(stateDir);
    store.loadAll();
    expect(store.unreadableRoutes().sort()).toEqual(["codex_cli", "nulled"]);
  });

  it("unreadableRoutes() clears once the bad record is replaced", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "codex_cli.json"), "{ not valid json");
    const store = new BreakerStore(stateDir);
    store.loadAll();
    expect(store.unreadableRoutes()).toEqual(["codex_cli"]);

    store.save("codex_cli", { failures: 2, blockedUntilMs: 1_900_000_000_000 });
    store.loadAll();
    expect(store.unreadableRoutes()).toEqual([]);
  });

  it("migrates state written by the pre-split single-blob format, then removes it", () => {
    // Without this an upgrade silently drops every live cooldown — the exact
    // failure persistence exists to prevent, reintroduced by the fix for it.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(
      legacy,
      JSON.stringify({ codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 } }),
    );
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
    });
    expect(readdirSync(dir)).not.toContain("breaker_state.json");
  });

  it("migration survives the migrating process: a SECOND reader still sees the cooldown", () => {
    // The first version of this migration merged into memory and deleted the
    // blob — nothing ever persisted the result, so the first process to call
    // loadAll() after an upgrade (even a plain `status`) consumed every live
    // cooldown. Detached runners and later processes started clean.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(
      legacy,
      JSON.stringify({ codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 } }),
    );
    new BreakerStore(stateDir).loadAll(); // the migrating process
    // A different process (fresh store), after the blob is gone:
    expect(new BreakerStore(stateDir).loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
    });
  });

  it("migration does not clobber a newer per-route file with blob state", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "codex_cli.json"),
      JSON.stringify({ failures: 1, blockedUntilMs: null }),
    );
    writeFileSync(
      path.join(dir, "breaker_state.json"),
      JSON.stringify({ codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 } }),
    );
    // Per-route files are newer by construction; the blob must lose both in
    // the returned map and on disk.
    expect(new BreakerStore(stateDir).loadAll()).toEqual({
      codex_cli: { failures: 1, blockedUntilMs: null },
    });
    expect(new BreakerStore(stateDir).loadAll()).toEqual({
      codex_cli: { failures: 1, blockedUntilMs: null },
    });
  });

  it("leaves no .tmp files behind after a save()", () => {
    // The previous version of this test was named for this guarantee and
    // asserted neither half of it — it only re-read the state file. Now it
    // actually lists the directory.
    const store = new BreakerStore(stateDir);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    const entries = readdirSync(stateDir);
    expect(entries.filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(stateDir, "codex_cli.json"), "utf-8"))).toEqual({
      failures: 5,
      blockedUntilMs: 1_900_000_000_000,
    });
  });
});
