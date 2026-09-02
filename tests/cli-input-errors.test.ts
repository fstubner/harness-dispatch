/**
 * A CLI user who typed something wrong gets one actionable line.
 *
 * Findings 5-9 of an independent acceptance review, all the same shape: bad
 * input either crashed with a raw Node/js-yaml stack trace, or was silently
 * ignored and replaced with a default. Both are bad, but the silent ones are
 * worse — `--config /typo.yaml` printed a confident, healthy-looking route
 * table for a config it never loaded, and `--port abc` bound a random port and
 * announced it as though that was what you asked for.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, resolveConfigPath } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-clierr-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadConfig — bad config files", () => {
  it("rejects an explicit path that does not exist, rather than auto-detecting", async () => {
    // The dangerous case: falling through produced a full healthy route table
    // built from defaults, so a typo'd path looked like a working config.
    const missing = path.join(dir, "nope.yaml");
    await expect(loadConfig(missing)).rejects.toThrow(/config file not found/);
    await expect(loadConfig(missing)).rejects.toThrow(/nope\.yaml/);
  });

  it("still auto-detects when no path is given at all", async () => {
    // The implicit fallback is deliberate and must survive the fix above.
    const cfg = await loadConfig(undefined, { whichFn: async () => null });
    expect(cfg).toBeDefined();
  });

  it("names the file and the problem for malformed YAML", async () => {
    const bad = path.join(dir, "bad.yaml");
    await fs.writeFile(bad, "clis: [\n  bad: : :\n", "utf8");
    const err = await loadConfig(bad).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not valid YAML/);
    expect((err as Error).message).toContain("bad.yaml");
    // The old failure was js-yaml's own exception escaping unhandled, which
    // never said which file it came from.
    expect((err as Error).name).toBe("Error");
  });
});

describe("config validation warnings", () => {
  async function warningsFor(body: string): Promise<string> {
    const file = path.join(dir, `w-${Math.abs(body.length)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    const cfg = await loadConfig(file, { whichFn: async () => null });
    return (cfg.configWarnings ?? []).join(" | ");
  }

  it("warns about an unknown top-level key instead of reporting none", async () => {
    // `doctor` said "no unrecognized config entries" while ignoring this
    // entirely — the check's name promised something it did not do.
    expect(await warningsFor("nonsense_key: 5\nclis: []\n")).toMatch(/unknown top-level config key/);
  });

  it("warns when max_concurrent_runs is present but unusable", async () => {
    // Silently defaulting means someone who set a concurrency bound got a
    // different one and was never told — and this governs how many agent CLIs
    // run at once.
    const w = await warningsFor('max_concurrent_runs: "banana"\nclis: []\n');
    expect(w).toMatch(/max_concurrent_runs/);
    expect(w).toMatch(/IGNORED/);
  });

  it("stays quiet for a valid config", async () => {
    const w = await warningsFor("max_concurrent_runs: 8\nclis: []\nendpoints: []\n");
    expect(w).not.toMatch(/unknown top-level/);
    expect(w).not.toMatch(/max_concurrent_runs/);
  });

  it("does not warn about the documented per-route api key shorthand", async () => {
    const w = await warningsFor('codex_cli_api_key: "sk-x"\nclis: []\n');
    expect(w).not.toMatch(/unknown top-level/);
  });
});

describe("per-route unknown keys — the root cause, not another instance", () => {
  /**
   * Three silent-drop defects were found in config.ts in one day and each was
   * patched individually. Measured afterwards, a route carrying three
   * misspelled keys still produced ZERO warnings and silently got none of
   * them. The parser reads what it recognises and cannot tell a key it does
   * not know from a key that is absent — so every future misspelling was
   * guaranteed to fail the same silent way.
   *
   * These are safety and isolation controls, so "silently absent" means
   * "silently less restrictive".
   */
  async function warn(body: string): Promise<string[]> {
    const file = path.join(dir, `r-${Math.abs(body.length)}.yaml`);
    await fs.writeFile(file, body, "utf8");
    const cfg = await loadConfig(file, { whichFn: async () => null });
    return (cfg.configWarnings ?? []).filter((w) => w.includes("unknown key"));
  }

  it("names every misspelled key on a clis: entry", async () => {
    const w = await warn(
      "clis:\n  - name: probe\n    harness: codex\n    workspace_polcy: copy\n    safety_profil: read_only\n",
    );
    expect(w.join(" ")).toContain("workspace_polcy");
    expect(w.join(" ")).toContain("safety_profil");
  });

  it("names a misspelled key on an endpoints: entry too", async () => {
    // The two entry shapes share one key list deliberately — parallel lists
    // drifting is what produced the original defects.
    const w = await warn(
      "endpoints:\n  - name: e\n    base_url: https://x/v1\n    model: m\n    safety_profil: read_only\n",
    );
    expect(w.join(" ")).toContain("safety_profil");
  });

  it("says the setting is not in effect, not merely that it is unknown", async () => {
    // A user who typo'd a safety control needs to know it is off, not just
    // that a word was unrecognised.
    const w = await warn("clis:\n  - name: probe\n    harness: codex\n    workspace_polcy: copy\n");
    expect(w[0]).toMatch(/IGNORED/);
    expect(w[0]).toMatch(/NOT in effect/);
  });

  it("stays silent on a fully-populated valid route", async () => {
    // The risk of a positive list is false warnings on real configs. The
    // shipped config.default.yaml and the repo's own config.yaml both produce
    // zero; this pins a dense hand-written entry as well.
    const w = await warn(
      [
        "clis:",
        "  - name: probe",
        "    harness: codex",
        "    tier: 1",
        "    weight: 1.2",
        "    model: gpt-5.6-terra",
        "    cli_capability: 1.0",
        "    thinking_level: high",
        "    leaderboard_model: gpt-5",
        "    max_input_tokens: 400000",
        "    max_output_tokens: 128000",
        "    safety_profile: read_only",
        "    workspace_policy: copy",
        "    allow_paid_usage: false",
        "    paid_usage_possible: false",
        "    billing_kind: included_plan_usage",
        "    capabilities: { execute: 1.0, plan: 0.9, review: 0.9 }",
        "",
      ].join("\n"),
    );
    expect(w).toEqual([]);
  });
});

describe("resolveConfigPath — one resolution, shared by the server and its runners", () => {
  const VAR = "HARNESS_DISPATCH_CONFIG";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAR];
    delete process.env[VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it("honours HARNESS_DISPATCH_CONFIG", () => {
    // job-runner.ts read this variable and bin.ts did not, while job-runner's
    // header claimed the two mirrored each other. With it set in the ambient
    // environment the server routed on auto-detected defaults while the runner
    // it spawned loaded a different file — the two halves of one dispatch
    // working from different configs, and nothing reported it.
    process.env[VAR] = path.join(dir, "from-env.yaml");
    expect(resolveConfigPath()).toBe(path.join(dir, "from-env.yaml"));
  });

  it("lets an explicit --config win over the variable", () => {
    process.env[VAR] = path.join(dir, "from-env.yaml");
    expect(resolveConfigPath(path.join(dir, "explicit.yaml"))).toBe(path.join(dir, "explicit.yaml"));
  });

  it("treats a variable pointing at a missing file as an error, not as auto-detect", async () => {
    // CHANGELOG 0.6.0 claimed the server reported this. Only the detached
    // runner did; the CLI and server ignored the variable outright, so a
    // typo'd path printed a confident route table built from defaults.
    const missing = path.join(dir, "nope.yaml");
    process.env[VAR] = missing;
    const resolved = resolveConfigPath();
    expect(resolved).toBe(missing);
    await expect(loadConfig(resolved!, { whichFn: async () => null })).rejects.toThrow(
      /config file not found/,
    );
  });

  it("falls back to the state directory's config.yaml when the current directory has none", async () => {
    // `configure` writes there now (userConfigPath), so a config written from
    // one directory is found by a command run from any other. Before this the
    // lookup stopped at ./config.yaml, and a user who ran configure in ~ and
    // doctor in a project got "0 configured route(s)" with no hint why.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hd-resolve-cwd-"));
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "hd-resolve-state-"));
    const userFile = path.join(state, "config.yaml");
    await fs.writeFile(userFile, "clis: []\n", "utf8");
    const savedCwd = process.cwd();
    const savedState = process.env["HARNESS_DISPATCH_STATE_DIR"];
    process.chdir(cwd);
    process.env["HARNESS_DISPATCH_STATE_DIR"] = state;
    try {
      expect(resolveConfigPath()).toBe(userFile);
      // And the current directory still wins when it has one.
      await fs.writeFile(path.join(cwd, "config.yaml"), "clis: []\n", "utf8");
      expect(resolveConfigPath()).toBe("config.yaml");
    } finally {
      process.chdir(savedCwd);
      if (savedState === undefined) delete process.env["HARNESS_DISPATCH_STATE_DIR"];
      else process.env["HARNESS_DISPATCH_STATE_DIR"] = savedState;
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(state, { recursive: true, force: true });
    }
  });

  it("ignores an empty variable rather than resolving to an empty path", () => {
    process.env[VAR] = "";
    // Falls through to ./config.yaml-or-nothing; either is fine, an empty
    // string is not.
    expect(resolveConfigPath()).not.toBe("");
  });
});
