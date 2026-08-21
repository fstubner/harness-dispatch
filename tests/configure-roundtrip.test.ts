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
 * Top-level settings went the same way: nothing recomputes `disabled:` or
 * `max_concurrent_runs`, so a dropped value is simply gone.
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
    expect(reloaded.disabled).toContain("cursor_cli");
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
