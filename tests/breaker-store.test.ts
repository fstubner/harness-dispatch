import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BreakerStore } from "../src/breaker-store.js";

describe("BreakerStore", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hr-breaker-store-"));
    stateFile = path.join(dir, "breaker_state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadAll() returns {} when the state file doesn't exist yet", () => {
    const store = new BreakerStore(stateFile);
    expect(store.loadAll()).toEqual({});
  });

  it("save() then loadAll() round-trips a tripped snapshot", () => {
    const store = new BreakerStore(stateFile);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
    });
  });

  it("save() with a fully-healthy snapshot removes any existing entry instead of writing a no-op record", () => {
    const store = new BreakerStore(stateFile);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("codex_cli", { failures: 0, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({});
  });

  it("tracks multiple services independently", () => {
    const store = new BreakerStore(stateFile);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("claude_code_cli", { failures: 2, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
      claude_code_cli: { failures: 2, blockedUntilMs: null },
    });
  });

  it("a later save() for one service doesn't clobber another service's entry", () => {
    const store = new BreakerStore(stateFile);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    store.save("claude_code_cli", { failures: 1, blockedUntilMs: null });
    store.save("codex_cli", { failures: 0, blockedUntilMs: null });
    expect(store.loadAll()).toEqual({
      claude_code_cli: { failures: 1, blockedUntilMs: null },
    });
  });

  it("loadAll() tolerates a corrupted state file by returning {}", () => {
    writeFileSync(stateFile, "{ not valid json");
    const store = new BreakerStore(stateFile);
    expect(store.loadAll()).toEqual({});
  });

  it("loadAll() skips malformed entries but keeps well-formed ones", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        codex_cli: { failures: 3, blockedUntilMs: 1_900_000_000_000 },
        garbage_entry: null,
        weird_entry: "not an object",
      }),
    );
    const store = new BreakerStore(stateFile);
    expect(store.loadAll()).toEqual({
      codex_cli: { failures: 3, blockedUntilMs: 1_900_000_000_000 },
    });
  });

  it("writes are atomic — no leftover .tmp files after a save()", () => {
    const store = new BreakerStore(stateFile);
    store.save("codex_cli", { failures: 5, blockedUntilMs: 1_900_000_000_000 });
    const raw = readFileSync(stateFile, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      codex_cli: { failures: 5, blockedUntilMs: 1_900_000_000_000 },
    });
  });
});
