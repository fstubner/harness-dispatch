/**
 * `clis:` and `endpoints:` must honour the same shared keys.
 *
 * This file has produced three silent-drop defects: workspace_policy read for
 * `services:`/`endpoints:` but not `clis:`, api_keys read for `clis:` but not
 * `endpoints:`, and unknown top-level keys unwarned. The cause is two field
 * lists maintained in parallel — buildCliServiceConfig resolves each field
 * inline against harness defaults, while addEndpoints routes through
 * billingFields() — so a key added to one is easy to forget in the other.
 *
 * WHY A TEST RATHER THAN A REFACTOR. The obvious unification (make the CLI
 * path call billingFields) is wrong: the CLI path resolves
 * `override.X ?? defaults.X` against harness defaults from
 * config.default.yaml, and billingFields(raw) has no defaults layer at all.
 * Collapsing them would silently drop the fallback that every built-in
 * harness relies on. The correct unification is a table-driven resolver —
 * a real refactor of the file that governs safety controls.
 *
 * KNOWN_ROUTE_KEYS does not cover this case either: it catches a MISSPELLED
 * key, not a correctly-spelled key that one builder happens not to read.
 *
 * So this pins the invariant instead. If the two paths drift, a test fails
 * naming the key — which is the part that was actually dangerous, since these
 * include safety and isolation controls where "silently absent" means
 * "silently less restrictive".
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import type { ServiceConfig } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-parity-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** yaml fragment -> the ServiceConfig field it must populate, and the value expected. */
const SHARED_FIELDS: Array<{
  yaml: string;
  field: keyof ServiceConfig;
  expected: unknown;
}> = [
  { yaml: "tier: 2", field: "tier", expected: 2 },
  { yaml: "weight: 1.25", field: "weight", expected: 1.25 },
  { yaml: "cli_capability: 0.75", field: "cliCapability", expected: 0.75 },
  { yaml: "max_input_tokens: 123456", field: "maxInputTokens", expected: 123456 },
  { yaml: "max_output_tokens: 4096", field: "maxOutputTokens", expected: 4096 },
  { yaml: "thinking_level: high", field: "thinkingLevel", expected: "high" },
  { yaml: "leaderboard_model: some-model", field: "leaderboardModel", expected: "some-model" },
  { yaml: "safety_profile: read_only", field: "safetyProfile", expected: "read_only" },
  { yaml: "effective_safety: read_only", field: "effectiveSafety", expected: "read_only" },
  { yaml: "workspace_policy: copy", field: "workspacePolicy", expected: "copy" },
  { yaml: "billing_kind: metered_api", field: "billingKind", expected: "metered_api" },
  { yaml: 'billing_notes: "note"', field: "billingNotes", expected: "note" },
  { yaml: "paid_usage_possible: true", field: "paidUsagePossible", expected: true },
  { yaml: "allow_paid_usage: true", field: "allowPaidUsage", expected: true },
  { yaml: "provider: openai", field: "provider", expected: "openai" },
  { yaml: 'model_hint: "hint text"', field: "modelHint", expected: "hint text" },
];

async function routeFrom(shape: "clis" | "endpoints", fragment: string): Promise<ServiceConfig> {
  const body =
    shape === "clis"
      ? ["clis:", "  - name: probe", "    harness: codex", `    ${fragment}`, ""].join("\n")
      : [
          "endpoints:",
          "  - name: probe",
          "    base_url: https://example.test/v1",
          "    model: m",
          `    ${fragment}`,
          "",
        ].join("\n");
  const file = path.join(dir, `p-${Buffer.from(fragment + shape).toString("hex").slice(0, 12)}.yaml`);
  await fs.writeFile(file, body, "utf8");
  const cfg = await loadConfig(file, { whichFn: async () => null });
  return cfg.services["probe"]!;
}

describe("shared route keys are honoured by both entry shapes", () => {
  it.each(SHARED_FIELDS)("$yaml", async ({ yaml, field, expected }) => {
    const viaClis = await routeFrom("clis", yaml);
    const viaEndpoints = await routeFrom("endpoints", yaml);

    expect(viaClis, `clis: dropped "${yaml}"`).toBeDefined();
    expect(viaEndpoints, `endpoints: dropped "${yaml}"`).toBeDefined();
    expect(viaClis[field], `clis: did not honour "${yaml}"`).toBe(expected);
    expect(viaEndpoints[field], `endpoints: did not honour "${yaml}"`).toBe(expected);
  });

  it("every shared key under test is in KNOWN_ROUTE_KEYS", async () => {
    // Otherwise the unknown-key warning would fire on a key this test proves
    // is legitimate — the two mechanisms have to agree on the legal surface.
    const body = [
      "clis:",
      "  - name: probe",
      "    harness: codex",
      ...SHARED_FIELDS.map((f) => `    ${f.yaml}`),
      "",
    ].join("\n");
    const file = path.join(dir, "all-keys.yaml");
    await fs.writeFile(file, body, "utf8");
    const cfg = await loadConfig(file, { whichFn: async () => null });
    const unknown = (cfg.configWarnings ?? []).filter((w) => w.includes("unknown key"));
    expect(unknown).toEqual([]);
  });
});
