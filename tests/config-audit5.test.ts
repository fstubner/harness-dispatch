/**
 * Config, `configure`, `connect` and CLI-flag defects from the fifth audit
 * (and the fourth's A5 verification), one test per defect.
 *
 * Same family as the rest of this suite: something the user wrote is accepted,
 * quietly becomes something else, and the surface reports success.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/bin.js";
import { planClientWrites, writeClientEntry } from "../src/client-register.js";
import { loadConfig } from "../src/config.js";
import { configToYaml } from "../src/configure-yaml.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-audit5-cfg-"));
});

afterEach(async () => {
  delete process.env["HRA5_KEY"];
  delete process.env["HRA5_UNSET"];
  await fs.rm(dir, { recursive: true, force: true });
});

const found = async (): Promise<string | null> => "/bin/x";

async function load(body: string, whichFn: (c: string) => Promise<string | null> = async () => null) {
  const file = path.join(dir, `c-${Math.random().toString(36).slice(2, 8)}.yaml`);
  await fs.writeFile(file, body, "utf8");
  return loadConfig(file, { whichFn });
}

const warnings = (cfg: { configWarnings?: readonly string[] }): string =>
  (cfg.configWarnings ?? []).join(" | ");

describe("configure keeps what it re-emits", () => {
  it("writes the shorthand `<route>_api_key: ${VAR}` back as a reference, not the secret", async () => {
    process.env["HRA5_KEY"] = "sk-test-FAKE-hra5";
    const cfg = await load("codex_cli_api_key: ${HRA5_KEY}\n", found);
    const yamlText = configToYaml(cfg, { redactLiterals: false });
    expect(yamlText).not.toContain("sk-test-FAKE-hra5");
    expect(yamlText).toContain("${HRA5_KEY}");
  });

  it("round-trips a legacy services: entry that names no harness", async () => {
    // Its own protocol block and billing, no `harness:` — the route worked,
    // and was written back as a clis: entry the loader rejects.
    const legacy = [
      "services:",
      "  mytool:",
      "    type: cli",
      "    command: node",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    protocol:",
      '      args: ["-e", "1", "{{prompt}}"]',
      "      output: { mode: text }",
      "",
    ].join("\n");
    const before = await load(legacy);
    expect(Object.keys(before.services)).toEqual(["mytool"]);

    const written = path.join(dir, "written.yaml");
    await fs.writeFile(written, configToYaml(before, { redactLiterals: false }), "utf8");
    const after = await loadConfig(written, { whichFn: async () => null });
    expect(Object.keys(after.services), warnings(after)).toEqual(["mytool"]);
    expect(after.services.mytool!.protocol).toBeDefined();
  });

  it("round-trips `clis: []` as still-no-routes, not as 'detect everything'", async () => {
    const before = await load("clis: []\n", found);
    expect(Object.keys(before.services)).toEqual([]);
    expect(before.detectionRan).toBe(false);

    const written = path.join(dir, "written.yaml");
    await fs.writeFile(written, configToYaml(before, { redactLiterals: false }), "utf8");
    const after = await loadConfig(written, { whichFn: found });
    expect(Object.keys(after.services)).toEqual([]);
    expect(after.detectionRan).toBe(false);
  });

  it("keeps `escalate_on: []` through a rewrite", async () => {
    const before = await load(
      "clis:\n  - name: a\n    harness: codex\n    escalate_model: big\n    escalate_on: []\n",
    );
    expect(before.services.a!.escalateOn).toEqual([]);
    expect(configToYaml(before, { redactLiterals: false })).toContain("escalate_on: []");
  });
});

describe("legacy services: parity with the modern shapes", () => {
  it("marks an endpoint whose ${VAR} key is unset, so it is skipped rather than shown ready", async () => {
    delete process.env["HRA5_UNSET"];
    const cfg = await load(
      [
        "services:",
        "  ep:",
        "    type: openai_compatible",
        "    base_url: http://example.invalid/v1",
        "    model: m",
        "    api_key: ${HRA5_UNSET}",
        "",
      ].join("\n"),
    );
    expect(cfg.services.ep!.apiKeyUnsetRef).toBe("${HRA5_UNSET}");
  });

  it("reports that detection did not run", async () => {
    const cfg = await load("services:\n  a:\n    type: cli\n    command: echo\n");
    expect(cfg.detectionRan).toBe(false);
  });
});

describe("a malformed list entry", () => {
  for (const block of ["clis", "endpoints"] as const) {
    it(`warns on a bare "-" in ${block}: instead of throwing a TypeError`, async () => {
      const cfg = await load(`${block}:\n  -\n  - name: ok\n    harness: codex\n    base_url: http://x/v1\n    model: m\n`);
      expect(warnings(cfg)).toContain(`${block}[0]: is empty or not a mapping`);
    });
  }

  it("names the missing field instead of always saying name and/or harness", async () => {
    const cfg = await load("clis:\n  - name: a\n");
    expect(warnings(cfg)).toContain('clis[0]: missing required "harness" — entry ignored');
  });
});

describe("escalate_on", () => {
  it("honours an empty list, and says what a list of typos did", async () => {
    const empty = await load("clis:\n  - name: a\n    harness: codex\n    escalate_on: []\n");
    expect(empty.services.a!.escalateOn).toEqual([]);

    const typo = await load("clis:\n  - name: a\n    harness: codex\n    escalate_on: [executee]\n");
    expect(typo.services.a!.escalateOn).toEqual([]);
    expect(warnings(typo)).toContain("escalate_on has \"executee\"");
    expect(warnings(typo)).toContain("never escalates");

    const absent = await load("clis:\n  - name: a\n    harness: codex\n");
    expect(absent.services.a!.escalateOn).toEqual(["plan", "review"]);
  });
});

describe("accepted-but-ignored top-level keys", () => {
  it("says `version` and a top-level `protocol` do nothing", async () => {
    const cfg = await load("version: 1\nprotocol: {}\nclis: []\n");
    const w = warnings(cfg);
    expect(w).toContain("version: recognised but NEVER READ");
    expect(w).toContain("protocol: recognised but NEVER READ at the top level");
    expect(w).not.toContain("unknown top-level");
  });
});

describe("connect: a client file created after the plan was made", () => {
  it("merges into it, with a backup, instead of replacing it", async () => {
    const home = path.join(dir, "home");
    await fs.mkdir(home, { recursive: true });
    const plans = planClientWrites("/projects/hd/config.yaml", {
      home,
      command: ["harness-dispatch"],
      installed: () => true,
    });
    const plan = plans.find((p) => p.id === "claude-code")!;
    expect(plan.state).toBe("missing-file");

    // The client's first launch, during the prompt.
    await fs.writeFile(
      plan.file,
      JSON.stringify({ mcpServers: { other: { command: "keepme" } }, theme: "dark" }),
      "utf8",
    );
    const outcome = await writeClientEntry(plan, { stamp: "t" });
    expect(outcome.action).toBe("written");
    expect(outcome.backupPath).toBeDefined();

    const now = JSON.parse(await fs.readFile(plan.file, "utf8")) as {
      mcpServers: Record<string, unknown>;
      theme?: string;
    };
    expect(now.mcpServers["other"]).toEqual({ command: "keepme" });
    expect(now.mcpServers["harness-dispatch"]).toBeDefined();
    expect(now.theme).toBe("dark");
  });
});

describe("a flag that takes a value, given none", () => {
  it("--service followed by another flag is a missing value, not a route called --config", async () => {
    await expect(main(["dispatch", "hi", "--service", "--config", "x.yaml"])).rejects.toThrow(
      /--service needs a value/,
    );
  });

  for (const flag of ["--service", "--clients", "--host", "--interval"]) {
    it(`${flag} with no value is a usage error`, async () => {
      await expect(main(["dispatch", "hi", flag])).rejects.toThrow(
        new RegExp(`${flag} needs a value`),
      );
    });
  }
});
