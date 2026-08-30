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

  // Only JSON.parse throwing used to reach the report; the field reads coerced
  // anything else to the healthy default, so a record encoding an ACTIVE
  // cooldown came back as `failures: 0, blockedUntilMs: null` with nothing
  // said — the same silent un-trip, one shape over.
  //
  // ONE wrong field per case, deliberately. The first version of this test set
  // two at once and passed with the `failures` guard deleted: the other guard
  // was carrying it, and the test could not have told anyone.
  for (const [label, record] of [
    ["failures", { failures: "5", blockedUntilMs: 1_900_000_000_000 }],
    ["blockedUntilMs", { failures: 5, blockedUntilMs: "2099-01-01" }],
    ["lastFailureAtMs", { failures: 5, blockedUntilMs: null, lastFailureAtMs: "yesterday" }],
  ] as const) {
    it(`a record whose ${label} PARSES but is the wrong type is unreadable, not healthy`, () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "codex_cli.json"), JSON.stringify(record));
      const store = new BreakerStore(stateDir);
      expect(store.loadAll()).toEqual({});
      expect(store.unreadableRoutes()).toEqual(["codex_cli"]);
    });
  }

  // The type guards enumerate ways a record can be broken, and an acceptance
  // pass kept finding shapes missing from that list. These all read back as a
  // perfectly healthy route — which save() would never have written, because
  // it deletes a healthy record instead. The file existing at all is the
  // contradiction, and it catches every shape without naming any of them.
  for (const [label, body] of [
    ["an empty object", "{}"],
    ["a foreign nested schema", '{"state":{"failures":5,"blockedUntilMs":1900000000000}}'],
    ["an object of unrelated keys", '{"route":"codex","note":"do not delete"}'],
  ] as const) {
    it(`${label} is unreadable, because save() never writes a healthy record`, () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "codex_cli.json"), body);
      const store = new BreakerStore(stateDir);
      expect(store.loadAll()).toEqual({});
      expect(store.unreadableRoutes()).toEqual(["codex_cli"]);
    });
  }

  it("a JSON array is unreadable — an array is not a record, whatever its contents", () => {
    // Kept separate from the healthy-contradiction cases above on purpose:
    // this one is refused by the shape check, and a sabotage run showed it
    // still passing with the contradiction rule deleted. Grouped with them it
    // would have been a green row crediting the wrong guard.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "codex_cli.json"), "[]");
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({});
    expect(store.unreadableRoutes()).toEqual(["codex_cli"]);
  });

  it("a record omitting fields an older build never wrote still reads fine", () => {
    // The guard above must not turn "written by v0.6" into "corrupt" — absent
    // is tolerated, wrong type is not, and conflating them would strand every
    // record from an older install.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "codex_cli.json"), JSON.stringify({ failures: 4 }));
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({ codex_cli: { failures: 4, blockedUntilMs: null } });
    expect(store.unreadableRoutes()).toEqual([]);
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

  it("a legacy entry it cannot read is reported, and the blob is NOT deleted", () => {
    // The migration validated nothing: it coerced a bad entry to healthy,
    // skipped it as "nothing to migrate", and deleted the blob anyway. So an
    // upgrade destroyed a live cooldown written in a shape it could not read —
    // and the upgrade is the single most likely moment for one to be sitting
    // there. Keeping the blob leaves the evidence in place.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(
      legacy,
      JSON.stringify({
        codex_cli: { failures: "5", blockedUntilMs: "2099-01-01" },
        cursor_cli: { failures: 3, blockedUntilMs: 1_900_000_000_000 },
      }),
    );
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({
      cursor_cli: { failures: 3, blockedUntilMs: 1_900_000_000_000 },
    });
    expect(store.unreadableRoutes()).toEqual(["codex_cli"]);
    expect(readdirSync(dir)).toContain("breaker_state.json");
  });

  // The legacy path deliberately does NOT apply the healthy-is-a-contradiction
  // rule, because the old format wrote healthy entries legitimately. That left
  // it with no floor at all: a record naming none of the known fields coerced
  // to healthy, counted as migrated, and the blob was deleted. Two of the three
  // shapes the per-route reader catches were still being swallowed here.
  for (const [label, entry] of [
    ["an empty object", {}],
    ["a foreign nested schema", { state: { failures: 5, blockedUntilMs: 1_900_000_000_000 } }],
    [
      "the snake_case shape of the Python implementation this was ported from",
      { consecutive_failures: 5, blocked_until: "2099-01-01T00:00:00Z" },
    ],
  ] as const) {
    it(`a legacy entry that is ${label} is reported, and the blob survives`, () => {
      const legacy = path.join(dir, "breaker_state.json");
      writeFileSync(legacy, JSON.stringify({ codex_cli: entry }));
      const store = new BreakerStore(stateDir);
      expect(store.loadAll()).toEqual({});
      expect(store.unreadableRoutes()).toEqual(["codex_cli"]);
      expect(readdirSync(dir)).toContain("breaker_state.json");
    });
  }

  it("a legacy blob that will not parse at all is reported, not deleted", () => {
    // The old comment here said "nothing lost by deleting it" — an assumption
    // about a file whose contents could not be read. It may have held every
    // live cooldown on the machine.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(legacy, "{ truncated mid-writ");
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({});
    expect(store.unreadableRoutes()).toEqual(["(legacy breaker_state.json)"]);
    expect(readdirSync(dir)).toContain("breaker_state.json");
  });

  it("a kept blob does not resurrect a route that has since recovered", () => {
    // Keeping the whole blob because ONE entry was bad meant the good ones
    // were re-read on every loadAll() — forever. So after a route recovered
    // and save() deleted its per-route file, the next read recreated it from
    // the stale blob. An acceptance pass measured a recovered route reading
    // failures=4 again, one failure from tripping and unable to heal, with
    // nothing on any surface naming the blob.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(
      legacy,
      JSON.stringify({
        codex_cli: { failures: 4, blockedUntilMs: null },
        broken: "not a record",
      }),
    );

    const store = new BreakerStore(stateDir);
    expect(store.loadAll().codex_cli).toEqual({ failures: 4, blockedUntilMs: null });
    // The bad entry is held back as evidence; the good one has been consumed.
    expect(store.unreadableRoutes()).toEqual(["broken"]);
    expect(readdirSync(dir)).toContain("breaker_state.json");

    // The route recovers: save() removes its per-route record.
    store.save("codex_cli", { failures: 0, blockedUntilMs: null });

    const after = new BreakerStore(stateDir);
    expect(after.loadAll().codex_cli).toBeUndefined();
    expect(after.unreadableRoutes()).toEqual(["broken"]);
    expect(readdirSync(stateDir)).not.toContain("codex_cli.json");
  });

  it("a legacy blob of entirely HEALTHY entries still migrates and is removed", () => {
    // The per-route reader treats a healthy record as a contradiction, because
    // save() deletes those. The legacy format wrote them legitimately, so that
    // rule must NOT reach here — applying it would report every healthy route
    // in the blob as corrupt and strand the file forever.
    const legacy = path.join(dir, "breaker_state.json");
    writeFileSync(legacy, JSON.stringify({ codex_cli: { failures: 0, blockedUntilMs: null } }));
    const store = new BreakerStore(stateDir);
    expect(store.loadAll()).toEqual({ codex_cli: { failures: 0, blockedUntilMs: null } });
    expect(store.unreadableRoutes()).toEqual([]);
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
