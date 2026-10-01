/**
 * The Arena-ELO leaderboard was cut. Its two config keys are still ACCEPTED so
 * an existing config keeps loading, and each says plainly that it no longer
 * does anything. Routing is tier, then weight x capability, then fallback.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { QuotaCache } from "../src/quota.js";
import { Router } from "../src/router.js";
import type { Dispatcher } from "../src/dispatchers/base.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-lbremoved-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function load(body: string) {
  const file = path.join(dir, `c-${Math.random().toString(36).slice(2, 8)}.yaml`);
  await fs.writeFile(file, body, "utf8");
  return loadConfig(file, { whichFn: async () => null });
}

const stub = (id: string): Dispatcher =>
  ({
    id,
    isAvailable: () => true,
    async dispatch() {
      return { output: "", service: id, success: true };
    },
    async *stream() {
      yield { type: "completion", result: { output: "", service: id, success: true } };
    },
    async checkQuota() {
      return { service: id, source: "unknown" };
    },
  }) as unknown as Dispatcher;

describe("the removed leaderboard keys", () => {
  it("warns that a route's leaderboard_model has no effect, and still loads the route", async () => {
    const cfg = await load(
      "clis:\n  - name: a\n    harness: codex\n    leaderboard_model: gpt-5\n",
    );
    expect(Object.keys(cfg.services)).toEqual(["a"]);
    const w = (cfg.configWarnings ?? []).join(" | ");
    expect(w).toContain("leaderboard_model");
    expect(w).toContain("removed, has no effect");
    expect(w).not.toContain("unknown key");
  });

  it("warns on the legacy services: shape too, which has no unknown-key check", async () => {
    const cfg = await load(
      "services:\n  a:\n    type: cli\n    command: echo\n    leaderboard_model: gpt-5\n",
    );
    expect((cfg.configWarnings ?? []).join(" | ")).toContain("removed, has no effect");
  });

  it("warns on an overrides: entry for a detected route", async () => {
    const cfg = await load("overrides:\n  codex_cli:\n    leaderboard_model: gpt-5\n");
    expect((cfg.configWarnings ?? []).join(" | ")).toContain("leaderboard_model: removed");
  });

  it("warns that a top-level leaderboard: block has no effect", async () => {
    const cfg = await load("leaderboard:\n  enabled: true\nclis: []\n");
    const w = (cfg.configWarnings ?? []).join(" | ");
    expect(w).toContain("leaderboard: recognised but REMOVED");
    expect(w).not.toContain("unknown top-level");
    expect((cfg as { leaderboard?: unknown }).leaderboard).toBeUndefined();
  });

  it("`tier:` alone orders routes — the old `zzz-…` leaderboard_model workaround is not needed", async () => {
    // The shape of the maintainer's own overrides: a leaderboard_model chosen
    // so it matches nothing, only there to stop an ELO-derived tier winning
    // over the written `tier:`. Now the written tier is the only tier.
    const cfg = await load(
      [
        "clis:",
        "  - name: first",
        "    harness: codex",
        "    tier: 2",
        "    leaderboard_model: zzz-no-such-model-force-fallback-tier",
        "  - name: second",
        "    harness: codex",
        "    tier: 1",
        "",
      ].join("\n"),
    );
    expect(cfg.services.first!.tier).toBe(2);
    expect(cfg.services.second!.tier).toBe(1);
    // Allowed to be unbillable here: this is about ordering, not billing.
    for (const svc of Object.values(cfg.services)) svc.allowPaidUsage = true;
    const dispatchers = { first: stub("first"), second: stub("second") };
    const router = new Router(cfg, new QuotaCache(dispatchers), dispatchers);
    const decision = await router.pickService({ hints: { taskType: "execute" } });
    expect(decision?.service).toBe("second");
    expect(decision?.tier).toBe(1);
  });
});
