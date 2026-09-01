/**
 * `configure` must not destroy what it re-emits.
 *
 * The round-trip dropped the `protocol:` block, and `harness: generic` has no
 * shipped preset to restore it — config.ts then refuses the entry outright
 * ("requires a protocol block — entry ignored"). So regenerating a config
 * deleted every user-added harness, and `configure --yes --force` wrote that
 * over their file. `--force` is what the tool's own overwrite message tells
 * them to use, and adding a harness is the documented README path.
 *
 * Top-level settings went the same way: nothing recomputes
 * `max_concurrent_runs`, so a dropped value is simply gone. `disabled:` is
 * the exception and goes the other way now — see the test below.
 *
 * Built-in harnesses deliberately keep the lean output — their preset supplies
 * protocol and billing, and emitting a copy would freeze a snapshot that stops
 * following future default changes.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/bin.js";
import { loadConfig } from "../src/config.js";
import { QuotaCache } from "../src/quota.js";

let dir: string;

const SOURCE = [
  "max_concurrent_runs: 7",
  "disabled: [cursor_cli]",
  "clis:",
  "  - name: fake_echo",
  "    harness: generic",
  "    command: node",
  "    tier: 3",
  "    billing_kind: local_compute",
  "    paid_usage_possible: false",
  "    protocol:",
  '      args: ["-e", "console.log(1)", "{{prompt}}"]',
  "      output: { mode: text }",
  "",
].join("\n");

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (c: string) => {
    chunks.push(String(c));
    return true;
  };
  try {
    return { code: await fn(), stdout: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-roundtrip-"));
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("configure round-trip", () => {
  it("keeps a user-added generic route alive through configure --print", async () => {
    const src = path.join(dir, "in.yaml");
    await fs.writeFile(src, SOURCE, "utf8");

    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    expect(printed.code).toBe(0);

    const out = path.join(dir, "out.yaml");
    await fs.writeFile(out, printed.stdout, "utf8");
    const reloaded = await loadConfig(out, { whichFn: async () => null });

    // The route survives, rather than being dropped for a missing protocol.
    expect(Object.keys(reloaded.services)).toContain("fake_echo");
    expect(reloaded.services["fake_echo"]?.protocol).toBeDefined();
    const warnings = (reloaded.configWarnings ?? []).join(" ");
    expect(warnings).not.toMatch(/requires a "protocol" block/);
  });

  it("preserves top-level settings that nothing else recomputes", async () => {
    const src = path.join(dir, "in2.yaml");
    await fs.writeFile(src, SOURCE, "utf8");
    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    const out = path.join(dir, "out2.yaml");
    await fs.writeFile(out, printed.stdout, "utf8");
    const reloaded = await loadConfig(out, { whichFn: async () => null });

    expect(reloaded.maxConcurrentRuns).toBe(7);
  });

  it("drops disabled: from a generated config that lists its own routes", async () => {
    // This used to assert the opposite, and was right when it was written:
    // nothing recomputed `disabled:`, so re-emitting it was the only way to
    // keep it. Once a config that lists routes became authoritative, carrying
    // it forward became actively wrong — the disabled route is simply absent
    // from `clis:`, so the name says nothing, and `doctor` reports that
    // `disabled:` had no effect and EXITS 1. An acceptance pass reproduced
    // the whole chain: the setup command generated a config that failed the
    // project's own health check.
    const src = path.join(dir, "in2b.yaml");
    await fs.writeFile(src, SOURCE, "utf8");
    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    expect(printed.stdout).toContain("clis:");
    expect(printed.stdout).not.toContain("disabled:");

    const out = path.join(dir, "out2b.yaml");
    await fs.writeFile(out, printed.stdout, "utf8");
    const reloaded = await loadConfig(out, { whichFn: async () => null });
    // The point of dropping it: the generated file is clean, not merely tidy.
    const warnings = (reloaded.configWarnings ?? []).join(" ");
    expect(warnings).not.toMatch(/disabled/);
    // And cursor_cli is still gone, which is what the operator asked for.
    expect(Object.keys(reloaded.services)).not.toContain("cursor_cli");
  });

  it("preserves a generic route's declared billing, which has no default to fall back on", async () => {
    const src = path.join(dir, "in3.yaml");
    await fs.writeFile(src, SOURCE, "utf8");
    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    const out = path.join(dir, "out3.yaml");
    await fs.writeFile(out, printed.stdout, "utf8");
    const reloaded = await loadConfig(out, { whichFn: async () => null });

    // Dropping these flipped the route to paid=possible and got it skipped.
    expect(reloaded.services["fake_echo"]?.billingKind).toBe("local_compute");
    expect(reloaded.services["fake_echo"]?.paidUsagePossible).toBe(false);
  });

  it("keeps an api_key ${VAR} reference when the variable is not set", async () => {
    // The reference must survive REGARDLESS of this shell's environment. It
    // did not: an unset variable interpolates to "", the route was emitted
    // with base_url and model but no api_key line at all, and
    // `configure --yes --force` wrote that over a correct config — the key
    // silently gone. envRefs cannot fix this on its own, because it is keyed
    // by resolved value and every unset variable resolves to the same "".
    delete process.env["HR_TEST_ABSENT_KEY"];
    const src = path.join(dir, "in5.yaml");
    await fs.writeFile(
      src,
      [
        "endpoints:",
        "  - name: probe_ep",
        "    base_url: https://example.test/v1",
        "    model: m",
        "    api_key: ${HR_TEST_ABSENT_KEY}",
        "",
      ].join("\n"),
      "utf8",
    );

    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain("api_key: ${HR_TEST_ABSENT_KEY}");
    // And no placeholder stood in for it — that would name the wrong variable.
    expect(printed.stdout).not.toContain("YOUR_API_KEY_ENV_VAR");
  });

  it("still omits protocol for built-in harnesses, whose preset supplies it", async () => {
    // The lean output is deliberate: emitting a copy would freeze a snapshot
    // that stops tracking future preset changes.
    const src = path.join(dir, "in4.yaml");
    await fs.writeFile(src, "clis:\n  - name: codex_cli\n    harness: codex\n", "utf8");
    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    expect(printed.stdout).toContain("harness: codex");
    expect(printed.stdout).not.toMatch(/^\s+protocol:/m);
  });
});

describe("detect: survives a regenerate", () => {
  /**
   * `detect: false` is the only setting that isolates a machine from its
   * installed paid CLIs — it is what this suite's own `setup-env.ts` relies
   * on. It was a top-level key with no field on RouterConfig, so nothing
   * carried it and `configure` dropped it silently.
   *
   * Measured before the fix: `detect: false` + `max_concurrent_runs: 2`
   * regenerated as `max_concurrent_runs: 2` alone, and reloading with all four
   * harness CLIs present yielded claude_code_cli, codex_cli, cursor_cli and
   * antigravity_cli. A bare `detect: false` regenerated as the literal `{}`,
   * where even the "this config defines no routes" warning is suppressed —
   * its trigger requires a non-empty document.
   */
  const pretendInstalled = async (cmd: string) => `/fake/bin/${cmd}`;

  async function regenerate(body: string, name: string): Promise<string> {
    const src = path.join(dir, name);
    await fs.writeFile(src, body, "utf8");
    const printed = await capture(() => main(["configure", "--print", "--config", src]));
    expect(printed.code).toBe(0);
    return printed.stdout;
  }

  it("keeps detect: false rather than dropping it", async () => {
    const out = await regenerate("detect: false\nmax_concurrent_runs: 2\n", "d1.yaml");
    expect(out).toContain("detect: false");
    expect(out).toContain("max_concurrent_runs: 2");
  });

  it("keeps a bare detect: false, which otherwise regenerates as nothing at all", async () => {
    const out = await regenerate("detect: false\n", "d2.yaml");
    expect(out).toContain("detect: false");
  });

  it("leaves the regenerated config still isolated from installed harnesses", async () => {
    // The assertion that matters: not the text, but that reloading it on a
    // machine where every harness IS present still yields no routes.
    const out = await regenerate("detect: false\n", "d3.yaml");
    const reloaded = path.join(dir, "d3-out.yaml");
    await fs.writeFile(reloaded, out, "utf8");
    const cfg = await loadConfig(reloaded, { whichFn: pretendInstalled });
    expect(Object.keys(cfg.services)).toEqual([]);
  });

  it("does not invent detect: for a config that never mentioned it", async () => {
    // Carrying the RESOLVED value would write `detect: true` into every config
    // that merely omitted it, turning a default into a permanent declaration.
    const out = await regenerate("max_concurrent_runs: 3\n", "d4.yaml");
    expect(out).not.toContain("detect:");
  });

  it("keeps detect: true too, which is the opt-in to additive behaviour", async () => {
    const out = await regenerate(
      ["detect: true", "clis:", "  - name: fake_echo", "    harness: generic", "    command: node",
       "    protocol:", '      args: ["-e", "console.log(1)", "{{prompt}}"]',
       "      output: { mode: text }", ""].join("\n"),
      "d5.yaml",
    );
    expect(out).toContain("detect: true");
  });
});
