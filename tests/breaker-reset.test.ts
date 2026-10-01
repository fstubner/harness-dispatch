/**
 * `harness-dispatch breaker reset <route>` — the supported way to close a
 * persisted breaker. OPERATIONS.md used to say a restart clears it; it does
 * not (state is saved per route so a restart cannot forget a cooldown), which
 * left deleting a file by hand as the only way out.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/bin.js";
import { BreakerStore } from "../src/breaker-store.js";

let dir: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hr-breaker-reset-"));
  prevState = process.env.HARNESS_DISPATCH_STATE_DIR;
  prevConfig = process.env.HARNESS_DISPATCH_CONFIG;
  process.env.HARNESS_DISPATCH_STATE_DIR = dir;
  const cfg = path.join(dir, "config.yaml");
  writeFileSync(cfg, "clis:\n  - name: flaky\n    harness: codex\n");
  process.env.HARNESS_DISPATCH_CONFIG = cfg;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.HARNESS_DISPATCH_STATE_DIR;
  else process.env.HARNESS_DISPATCH_STATE_DIR = prevState;
  if (prevConfig === undefined) delete process.env.HARNESS_DISPATCH_CONFIG;
  else process.env.HARNESS_DISPATCH_CONFIG = prevConfig;
  rmSync(dir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (c: string) => {
    chunks.push(String(c));
    return true;
  };
  try {
    return { code: await main(argv), out: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
}

const trip = (route: string): void => {
  new BreakerStore().update(route, () => ({
    failures: 5,
    blockedUntilMs: Date.now() + 300_000,
    lastFailureAtMs: Date.now(),
  }));
};

describe("breaker reset", () => {
  it("closes a tripped breaker and says how long it had left", async () => {
    trip("flaky");
    expect(new BreakerStore().loadAll()["flaky"]?.blockedUntilMs).not.toBeNull();
    const { code, out } = await run(["breaker", "reset", "flaky"]);
    expect(code).toBe(0);
    expect(out).toMatch(/"flaky" was tripped \(\d+s of cooldown left\); it is closed now/);
    expect(new BreakerStore().loadAll()["flaky"]).toBeUndefined();
  });

  it("clears the record of a route that is no longer configured", async () => {
    trip("gone");
    const { code } = await run(["breaker", "reset", "gone"]);
    expect(code).toBe(0);
    expect(new BreakerStore().loadAll()["gone"]).toBeUndefined();
  });

  it("is not silent about a name that matches nothing", async () => {
    const { code, out } = await run(["breaker", "reset", "typo_cli"]);
    expect(code).toBe(1);
    expect(out).toMatch(/no breaker record for "typo_cli", and it is not a configured route/);
  });

  it("a configured route with no record is a no-op, exit 0", async () => {
    const { code, out } = await run(["breaker", "reset", "flaky"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to clear");
  });

  it("asks for a route", async () => {
    await expect(main(["breaker", "reset"])).rejects.toThrow(/missing route/);
    await expect(main(["breaker", "wipe", "x"])).rejects.toThrow(/unknown breaker action/);
  });
});
