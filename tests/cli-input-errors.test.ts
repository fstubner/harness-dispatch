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

import { loadConfig } from "../src/config.js";

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
