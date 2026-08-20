/**
 * `clis:`, `endpoints:` and `services:` must honour the same shared keys.
 *
 * This file produced five silent-drop defects, all one shape: a
 * correctly-spelled, correctly-valued setting read by one route shape and
 * ignored by another (workspace_policy, api_keys, effective_safety,
 * escalate_model, plus unwarned unknown keys). KNOWN_ROUTE_KEYS cannot catch
 * it — that catches a MISSPELLED key, not a valid key nobody reads.
 *
 * THE REFACTOR THIS TEST ASKED FOR NOW EXISTS. The header used to say the
 * correct fix was a table-driven resolver and that this test pinned the
 * invariant until someone wrote it; src/config/route-fields.ts is that
 * resolver, and all three builders call it. So the job here changed:
 *
 *   1. It still proves each key survives every shape end-to-end, because a
 *      table nothing is wired to would pass a unit test and fail a user.
 *   2. It now DERIVES the key list from the resolver's own table, so the list
 *      cannot fall behind the implementation. That mattered: the previous
 *      hand-written version pinned 16 keys, missed escalate_model, and the
 *      gap it existed to catch went to a human reviewer instead.
 *
 * The legacy `services:` shape is covered too. It had none, which is how a
 * refactor of billingFields() silently stripped five of its fields — the same
 * defect class, produced while removing it.
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
  // Added after a review found escalate_model honoured on clis: and dropped on
  // endpoints: — this list pinned 16 keys and missed it, so the gap it exists
  // to catch went to a human instead.
  { yaml: "escalate_model: big-model", field: "escalateModel", expected: "big-model" },
  { yaml: "safety_profile: read_only", field: "safetyProfile", expected: "read_only" },
  { yaml: "effective_safety: read_only", field: "effectiveSafety", expected: "read_only" },
  { yaml: "workspace_policy: copy", field: "workspacePolicy", expected: "copy" },
  { yaml: "billing_kind: metered_api", field: "billingKind", expected: "metered_api" },
  { yaml: 'billing_notes: "note"', field: "billingNotes", expected: "note" },
  { yaml: "paid_usage_possible: true", field: "paidUsagePossible", expected: true },
  { yaml: "allow_paid_usage: true", field: "allowPaidUsage", expected: true },
  { yaml: "provider: openai", field: "provider", expected: "openai" },
  { yaml: 'model_hint: "hint text"', field: "modelHint", expected: "hint text" },
  // Added when this file started deriving its list from the resolver's table:
  // these three were in neither the old hand-written list nor any other test,
  // so nothing proved any shape read them.
  { yaml: "timeout_ms: 900000", field: "timeoutMs", expected: 900000 },
  { yaml: "billing_confidence: documented", field: "billingConfidence", expected: "documented" },
  { yaml: 'models: ["m-one", "m-two"]', field: "models", expected: ["m-one", "m-two"] },
];

type Shape = "clis" | "endpoints" | "services";

async function routeFrom(shape: Shape, fragment: string): Promise<ServiceConfig> {
  const body =
    shape === "clis"
      ? ["clis:", "  - name: probe", "    harness: codex", `    ${fragment}`, ""].join("\n")
      : shape === "endpoints"
        ? [
            "endpoints:",
            "  - name: probe",
            "    base_url: https://example.test/v1",
            "    model: m",
            `    ${fragment}`,
            "",
          ].join("\n")
        : [
            "services:",
            "  probe:",
            "    type: cli",
            "    harness: codex",
            "    command: codex",
            `    ${fragment}`,
            "",
          ].join("\n");
  const file = path.join(dir, `p-${Buffer.from(fragment + shape).toString("hex").slice(0, 12)}.yaml`);
  await fs.writeFile(file, body, "utf8");
  const cfg = await loadConfig(file, { whichFn: async () => null });
  return cfg.services["probe"]!;
}

const SHAPES: Shape[] = ["clis", "endpoints", "services"];

describe("shared route keys are honoured by every entry shape", () => {
  it.each(SHARED_FIELDS)("$yaml", async ({ yaml, field, expected }) => {
    for (const shape of SHAPES) {
      const svc = await routeFrom(shape, yaml);
      expect(svc, `${shape}: dropped "${yaml}" entirely`).toBeDefined();
      // toEqual, not toBe: `models` is an array.
      expect(svc[field], `${shape}: did not honour "${yaml}"`).toEqual(expected);
    }
  });

  it("covers every key the shared resolver owns", async () => {
    // The guard against this test decaying. The resolver's table is the
    // implementation's own list of shared keys; if a row is added there
    // without a case here, the new field ships with no proof that all three
    // shapes read it — which is exactly how escalate_model slipped through
    // the previous hand-maintained version of this file.
    const { SHARED_ROUTE_FIELD_KEYS } = await import("../src/config/route-fields.js");
    const covered = new Set(SHARED_FIELDS.map((f) => f.yaml.split(":")[0]!.trim()));
    const missing = SHARED_ROUTE_FIELD_KEYS.filter((k) => !covered.has(k));
    expect(missing, `shared resolver keys with no parity case: ${missing.join(", ")}`).toEqual([]);
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
