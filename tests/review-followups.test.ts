/**
 * Findings 3, 5, 6 and 7 of an independent acceptance review.
 *
 * Every one is the same family this codebase keeps producing: something the
 * user wrote is accepted, quietly does nothing, and the surface reports
 * success.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-followup-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function warningsFor(body: string): Promise<string> {
  const file = path.join(dir, `c-${Math.abs(body.length)}-${Math.random().toString(36).slice(2, 7)}.yaml`);
  await fs.writeFile(file, body, "utf8");
  const cfg = await loadConfig(file, { whichFn: async () => null });
  return (cfg.configWarnings ?? []).join(" | ");
}

describe("billing enums fail open, so they must warn", () => {
  it("warns on a misspelled billing_kind instead of using the harness default", async () => {
    // `metered-api` (hyphen) silently resolved to
    // included_plan_then_flexible_credits with paidUsagePossible false — a
    // metered route quietly marked as free. Billing is the other hard
    // constraint the product states, so it belongs in the same check as the
    // safety enums.
    const w = await warningsFor("clis:\n  - name: a\n    harness: codex\n    billing_kind: metered-api\n");
    expect(w).toContain("billing_kind");
    expect(w).toContain("metered-api");
  });

  it("accepts every real billing_confidence value", async () => {
    // The first version of this check listed high/medium/low, which are not
    // the real values — it warned about valid configs until the enum was read
    // from the source rather than guessed.
    for (const v of ["documented", "inferred", "unknown", "unsupported"]) {
      const w = await warningsFor(`clis:\n  - name: a\n    harness: codex\n    billing_confidence: ${v}\n`);
      expect(w, `${v} should be accepted`).not.toContain("billing_confidence");
    }
  });
});

describe("keys accepted but not implemented", () => {
  it("says default_safety_profile has no effect rather than accepting it silently", async () => {
    // A safety-control NAME that does nothing is the exact failure the
    // validation module exists to prevent.
    const w = await warningsFor("default_safety_profile: read_only\nclis: []\n");
    expect(w).toMatch(/default_safety_profile/);
    expect(w).toMatch(/NOT IMPLEMENTED/);
  });

  it("does not call it a typo, because it is not one", async () => {
    const w = await warningsFor("protocols: {}\nclis: []\n");
    expect(w).toMatch(/NOT IMPLEMENTED/);
    expect(w).not.toMatch(/unknown top-level/);
  });
});

describe("escalate_model parity", () => {
  it("is honoured on an endpoints: entry, not only clis:", async () => {
    const cfg = await loadConfig(
      await (async () => {
        const f = path.join(dir, "esc.yaml");
        await fs.writeFile(
          f,
          [
            "clis:",
            "  - name: a",
            "    harness: codex",
            "    escalate_model: big-model",
            "endpoints:",
            "  - name: b",
            "    base_url: https://example.test/v1",
            "    model: m",
            "    escalate_model: big-model",
            "",
          ].join("\n"),
          "utf8",
        );
        return f;
      })(),
      { whichFn: async () => null },
    );
    expect(cfg.services["a"]?.escalateModel).toBe("big-model");
    expect(cfg.services["b"]?.escalateModel).toBe("big-model");
  });
});

describe("out-of-range numeric route fields", () => {
  /**
   * The oldest routing defect on the open-item list: recognised numeric keys
   * were type-checked but never range-checked, and the router MULTIPLIES
   * weight and cli_capability into the score while ordering tiers ascending.
   * A negative pair is therefore not a demotion — it promotes the route past
   * every legitimate one, silently.
   *
   * Measured against the pre-fix build with the config below: the route was
   * selected with tier -5 and a score of 299.8, versus 0.88 for a normal
   * route, and `configWarnings` was empty.
   */
  async function routeFrom(body: string) {
    const file = path.join(dir, `n-${Math.random().toString(36).slice(2, 7)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    return loadConfig(file, { whichFn: async () => null });
  }

  const NEGATIVE = [
    "clis:",
    "  - name: a",
    "    harness: codex",
    "    tier: -5",
    "    weight: -100",
    "    cli_capability: -3",
    "",
  ].join("\n");

  it("does not let a negative tier sort ahead of every real route", async () => {
    const cfg = await routeFrom(NEGATIVE);
    expect(cfg.services["a"]?.tier).toBeGreaterThanOrEqual(1);
  });

  it("does not let a negative weight and capability multiply into a winning score", async () => {
    const cfg = await routeFrom(NEGATIVE);
    expect(cfg.services["a"]?.weight).toBeGreaterThan(0);
    expect(cfg.services["a"]?.cliCapability).toBeGreaterThan(0);
  });

  it("says so rather than correcting it silently", async () => {
    const cfg = await routeFrom(NEGATIVE);
    const w = (cfg.configWarnings ?? []).join(" | ");
    expect(w).toContain("tier");
    expect(w).toContain("minimum");
  });

  it("leaves a legitimate above-1 cli_capability alone", async () => {
    // 1.1 ships in this repo's own config.default.yaml as deliberate tuning,
    // so a range check that rejected it would break a documented value.
    const cfg = await routeFrom(
      ["clis:", "  - name: a", "    harness: codex", "    cli_capability: 1.1", ""].join("\n"),
    );
    expect(cfg.services["a"]?.cliCapability).toBe(1.1);
    expect((cfg.configWarnings ?? []).join(" | ")).not.toContain("minimum");
  });

  it("catches the same mistake in an endpoints: entry", async () => {
    const cfg = await routeFrom(
      [
        "endpoints:",
        "  - name: e",
        "    base_url: https://example.test/v1",
        "    model: m",
        "    weight: -100",
        "",
      ].join("\n"),
    );
    expect(cfg.services["e"]?.weight).toBeGreaterThan(0);
  });
});

describe("top-level isolation keys that do nothing", () => {
  /**
   * `policy:` and `workspace_policy:` were allow-listed at the top level and
   * read nowhere. Both ARE real per-route keys, which is what makes the
   * top-level spelling plausible: it reads like a global default for the
   * per-route setting, and no such default exists. An isolation control that
   * silently does nothing is the exact failure this module was created for.
   */
  it("says a top-level workspace_policy has no effect", async () => {
    const w = await warningsFor("workspace_policy: copy\nclis: []\n");
    expect(w).toContain("workspace_policy");
    expect(w).toContain("NOT IMPLEMENTED");
  });

  it("says a top-level policy has no effect", async () => {
    const w = await warningsFor("policy: copy\nclis: []\n");
    expect(w).toContain("NOT IMPLEMENTED");
  });

  it("still honours workspace_policy on the route itself", async () => {
    // The warning must not imply the per-route key is dead too.
    const cfg = await loadConfig(
      await (async () => {
        const f = path.join(dir, "wp.yaml");
        await fs.writeFile(
          f,
          ["clis:", "  - name: a", "    harness: codex", "    workspace_policy: copy", ""].join("\n"),
          "utf8",
        );
        return f;
      })(),
      { whichFn: async () => null },
    );
    expect(cfg.services["a"]?.workspacePolicy).toBe("copy");
  });
});

describe("non-finite numeric route fields", () => {
  /**
   * The range check added for negative values did not cover the infinite
   * ones, and the branch that DID catch them warned without neutralising.
   * An acceptance pass measured the result: `tier: -.inf, weight: .inf`
   * loading as tier=-Infinity weight=Infinity — ahead of every tier and above
   * every score — underneath a warning reading "IGNORED, and the built-in
   * default applies instead". The message asserted the opposite of what
   * happened, which is worse than the original silence.
   *
   * `1e999` is the same defect by a different door: YAML types it as a
   * STRING, and `Number("1e999")` is Infinity, which `!Number.isNaN(...)`
   * accepted as "reads as a number" — so it passed the type check and then
   * the range check, producing weight=Infinity with NO warning at all.
   */
  async function routeFrom(body: string) {
    const file = path.join(dir, `f-${Math.random().toString(36).slice(2, 7)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    return loadConfig(file, { whichFn: async () => null });
  }

  const cli = (fields: string[]) =>
    ["clis:", "  - name: a", "    harness: codex", ...fields.map((f) => `    ${f}`), ""].join("\n");

  it("does not load an infinite tier or weight", async () => {
    const cfg = await routeFrom(cli(["tier: -.inf", "weight: .inf"]));
    expect(Number.isFinite(cfg.services["a"]?.tier)).toBe(true);
    expect(Number.isFinite(cfg.services["a"]?.weight)).toBe(true);
  });

  it("does not load NaN", async () => {
    const cfg = await routeFrom(cli(["tier: .nan", "weight: .nan"]));
    expect(Number.isNaN(cfg.services["a"]?.tier)).toBe(false);
    expect(Number.isNaN(cfg.services["a"]?.weight)).toBe(false);
  });

  it("catches an overflowing numeric STRING, which used to warn about nothing", async () => {
    const cfg = await routeFrom(cli(["weight: 1e999"]));
    expect(Number.isFinite(cfg.services["a"]?.weight)).toBe(true);
    expect((cfg.configWarnings ?? []).join(" | ")).toContain("weight");
  });

  it("names the value the operator actually wrote, not null", async () => {
    // JSON.stringify(Infinity) is "null", so the warning used to report
    // `tier is null` for a file containing `-.inf`.
    const cfg = await routeFrom(cli(["tier: -.inf"]));
    const w = (cfg.configWarnings ?? []).join(" | ");
    expect(w).toContain("-Infinity");
    expect(w).not.toContain("tier is null");
  });

  it("explains the right mechanism for a field routing does not score", async () => {
    const cfg = await routeFrom(cli(["timeout_ms: 0"]));
    const w = (cfg.configWarnings ?? []).join(" | ");
    expect(w).toContain("timeout_ms");
    expect(w).not.toContain("PROMOTES");
  });
});

describe("an empty route list is an opinion about routes", () => {
  /**
   * `clis: []` is the most explicit way to say "no CLI routes", and the
   * commit that made configs authoritative named it as the motivating
   * failure — in the past tense, while it still loaded every harness on the
   * machine, because `definesRoutes` required a NON-EMPTY array.
   *
   * `whichFn` here pretends every harness is installed. It never runs one.
   */
  const pretendInstalled = async (cmd: string) => `/fake/bin/${cmd}`;

  async function routesFor(body: string): Promise<string[]> {
    const file = path.join(dir, `e-${Math.random().toString(36).slice(2, 7)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    const cfg = await loadConfig(file, { whichFn: pretendInstalled });
    return Object.keys(cfg.services);
  }

  it("isolates a config from every installed harness", async () => {
    expect(await routesFor("clis: []\n")).toEqual([]);
  });

  it("does the same for an empty endpoints list", async () => {
    expect(await routesFor("endpoints: []\n")).toEqual([]);
  });

  it("still auto-detects for a config that mentions no route list at all", async () => {
    // The carve-out that keeps an overrides-only config working must survive:
    // it tunes detection rather than replacing it.
    expect((await routesFor("overrides:\n  codex_cli:\n    tier: 2\n")).length).toBeGreaterThan(0);
  });
});

describe("a config that lists routes must not carry dead controls", () => {
  const pretendInstalled = async (cmd: string) => `/fake/bin/${cmd}`;

  async function warningsWith(body: string): Promise<string> {
    const file = path.join(dir, `d-${Math.random().toString(36).slice(2, 7)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    const cfg = await loadConfig(file, { whichFn: pretendInstalled });
    return (cfg.configWarnings ?? []).join(" | ");
  }

  it("warns when clis: is written as a mapping instead of a list", async () => {
    // The entries vanish, detection runs, and the user who was naming their
    // own routes silently gets every installed paid harness instead.
    const w = await warningsWith("clis:\n  my_route:\n    harness: codex\n");
    expect(w).toContain("must be a LIST");
  });

  it("warns for endpoints: written as a mapping too", async () => {
    const w = await warningsWith("endpoints:\n  mine:\n    base_url: http://x/v1\n");
    expect(w).toContain("must be a LIST");
  });

  it("gives a legacy services: config the same top-level key warnings", async () => {
    // The legacy shape returned before the top-level check ran, so the same
    // key warned twice in one format and not at all in the other.
    const w = await warningsWith(
      ["policy: copy", "services:", "  a:", "    type: cli", "    command: echo", ""].join("\n"),
    );
    expect(w).toContain("NOT IMPLEMENTED");
  });
});
