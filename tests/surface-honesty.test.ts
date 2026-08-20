/**
 * The surfaces a user actually reads must not disagree with each other.
 *
 * Findings 4-6 of an independent acceptance review. Each is a case where one
 * part of the tool knew something and the part the user was looking at did
 * not say it.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildRouteBilling } from "../src/billing.js";
import { main } from "../src/bin.js";
import { QuotaCache } from "../src/quota.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-honesty-"));
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const GENERIC = (extra: string): string =>
  [
    "clis:",
    "  - name: g",
    "    harness: generic",
    "    command: node",
    "    tier: 3",
    `    ${extra}`,
    "    protocol:",
    '      args: ["-e", "0", "{{prompt}}"]',
    "      output: { mode: text }",
    "",
  ].join("\n");

describe("a declared billing_kind drives the paid flag", () => {
  it("does not report paid=possible for a route declared local_compute", async () => {
    // status showed `billing=local_compute paid=possible` — two fields of one
    // record contradicting each other — because the generic harness default
    // (paidUsagePossible: true) beat the declared kind. The route was then
    // skipped by billing policy.
    const file = path.join(dir, "a.yaml");
    await fs.writeFile(file, GENERIC("billing_kind: local_compute"), "utf8");
    const cfg = await loadConfig(file, { whichFn: async () => null });
    const svc = cfg.services["g"]!;
    expect(svc.paidUsagePossible).toBe(false);
    expect(buildRouteBilling(svc).paidUsagePossible).toBe(false);
  });

  it("keeps paid=possible when the declared kind really is metered", async () => {
    const file = path.join(dir, "b.yaml");
    await fs.writeFile(file, GENERIC("billing_kind: metered_api"), "utf8");
    const cfg = await loadConfig(file, { whichFn: async () => null });
    expect(cfg.services["g"]?.paidUsagePossible).toBe(true);
  });

  it("still lets an explicit paid_usage_possible win over the inference", async () => {
    const file = path.join(dir, "c.yaml");
    await fs.writeFile(
      file,
      GENERIC("billing_kind: local_compute\n    paid_usage_possible: true"),
      "utf8",
    );
    const cfg = await loadConfig(file, { whichFn: async () => null });
    expect(cfg.services["g"]?.paidUsagePossible).toBe(true);
  });
});

describe("unknown CLI flags", () => {
  async function run(argv: string[]): Promise<number> {
    try {
      return await main(argv);
    } catch {
      // main throws UsageError; bin's top-level handler turns it into exit 1.
      return 1;
    }
  }

  it("fails rather than printing human text with a success code", async () => {
    // `status --jsonn` exited 0 with human output, so a cron job piping it to
    // jq got garbage AND a success code. A wrong exit code is the one thing
    // automation cannot recover from.
    expect(await run(["status", "--jsonn"])).toBe(1);
  });

  it("accepts the real flag", async () => {
    expect(await run(["--help"])).toBe(0);
  });
});

describe("the docs a user reads must name the tools that actually exist", () => {
  /**
   * Adding cancel_job left FIVE documents claiming a three-tool surface:
   * AGENTS.md, CLAUDE.md, README.md, ux-walkthrough.md and the plugin skill
   * whose whole job is telling another agent what it can call. Nothing failed
   * — every test passed with the docs describing a surface that no longer
   * existed, and the CI smoke check only caught it because it happened to
   * pin the list too.
   *
   * A doc that lists the tools is a promise about the surface, so it is
   * checked against TOOL_NAMES rather than against a copy of the list.
   */
  const docs = [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "plugin/skills/delegating-work/SKILL.md",
  ];

  it.each(docs)("%s names every registered tool", async (rel) => {
    const { TOOL_NAMES } = await import("../src/mcp/tools.js");
    const text = await fs.readFile(path.join(process.cwd(), rel), "utf8");
    const missing = TOOL_NAMES.filter((name) => !text.includes(name));
    expect(missing, `${rel} does not mention: ${missing.join(", ")}`).toEqual([]);
  });

  it("ux-walkthrough states the right tool count", async () => {
    const { TOOL_NAMES } = await import("../src/mcp/tools.js");
    const text = await fs.readFile(path.join(process.cwd(), "ux-walkthrough.md"), "utf8");
    const words = ["zero", "one", "two", "three", "four", "five", "six"];
    // The walkthrough is what an acceptance reviewer follows literally, so a
    // stale count sends them looking for a tool that is not there — or worse,
    // to tick off a surface they did not actually check.
    expect(text).toContain(`Exactly ${words[TOOL_NAMES.length]}`);
  });
});
