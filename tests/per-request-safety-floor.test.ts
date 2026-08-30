/**
 * A capability floor that differs by requested profile.
 *
 * `effective_safety` was a single value, which cannot describe a CLI whose
 * capability genuinely varies by mode. cursor-agent is exactly that: verified
 * 2026-08-17, `--mode plan` declined to create or overwrite files while the
 * identical invocation without it created the file. Pinned at one value the
 * route had to claim full_auto for everything, so it was skipped for every
 * ordinary request and a paid-for tool never ran.
 *
 * The floor must still be honoured — this is a safety control, and widening it
 * by accident is the failure that matters. Hence the workspace_edit cases.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { effectiveSafetyProfile, safetyProfileCompatible } from "../src/safety.js";
import type { ServiceConfig } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-floor-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function loadRoute(effectiveSafetyYaml: string): Promise<ServiceConfig> {
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "clis:",
      "  - name: probe",
      "    harness: generic",
      "    command: node",
      "    tier: 3",
      effectiveSafetyYaml,
      "    protocol:",
      '      args: ["-e", "0"]',
      "      output: { mode: text }",
      "",
    ].join("\n"),
    "utf8",
  );
  const cfg = await loadConfig(file, { whichFn: async () => null });
  return cfg.services["probe"]!;
}

describe("effective_safety as a per-request map", () => {
  const MAP = [
    "    effective_safety:",
    "      read_only: read_only",
    "      workspace_edit: full_auto",
    "      full_auto: full_auto",
  ].join("\n");

  it("gives each requested profile its own floor", async () => {
    const svc = await loadRoute(MAP);
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("read_only");
    expect(effectiveSafetyProfile(svc, "workspace_edit")).toBe("full_auto");
    expect(effectiveSafetyProfile(svc, "full_auto")).toBe("full_auto");
  });

  it("makes the route usable for read_only while still refusing workspace_edit", async () => {
    // The whole point: a route that was skipped for everything can now serve
    // read-only work, without its write-capable mode being reclassified.
    const svc = await loadRoute(MAP);
    expect(safetyProfileCompatible(svc, "read_only")).toBe(true);
    expect(safetyProfileCompatible(svc, "workspace_edit")).toBe(false);
    expect(safetyProfileCompatible(svc, "full_auto")).toBe(true);
  });

  it("still accepts a single value, unchanged", async () => {
    const svc = await loadRoute("    effective_safety: full_auto");
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("full_auto");
    expect(safetyProfileCompatible(svc, "read_only")).toBe(false);
  });

  it("ignores a bad entry rather than letting a typo widen that request's floor", async () => {
    const cfgFile = [
      "    effective_safety:",
      "      read_only: read_onlyy",
      "      workspace_edit: full_auto",
    ].join("\n");
    const svc = await loadRoute(cfgFile);
    // The typo'd entry is dropped, so read_only falls through to the request
    // itself rather than silently inheriting something permissive.
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("read_only");
    expect(effectiveSafetyProfile(svc, "workspace_edit")).toBe("full_auto");
  });

  it("warns about the bad entry instead of dropping it silently", async () => {
    const file = path.join(dir, "warn.yaml");
    await fs.writeFile(
      file,
      [
        "clis:",
        "  - name: probe",
        "    harness: generic",
        "    command: node",
        "    tier: 3",
        "    effective_safety:",
        "      read_only: read_onlyy",
        "    protocol:",
        '      args: ["-e", "0"]',
        "      output: { mode: text }",
        "",
      ].join("\n"),
      "utf8",
    );
    const cfg = await loadConfig(file, { whichFn: async () => null });
    expect((cfg.configWarnings ?? []).join(" ")).toContain("read_onlyy");
  });

  it("falls through to the request when a profile is not listed at all", async () => {
    const svc = await loadRoute("    effective_safety:\n      read_only: read_only");
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("read_only");
    // Unlisted: no floor claimed, so the request stands rather than defaulting
    // to something stricter or looser than anyone declared.
    expect(effectiveSafetyProfile(svc, "full_auto")).toBe("full_auto");
  });
});

describe("the shipped cursor route", () => {
  it("serves read_only work but not workspace_edit", async () => {
    // Pins the behaviour change end to end, through the real shipped defaults.
    const file = path.join(dir, "cursor.yaml");
    await fs.writeFile(
      file,
      "clis:\n  - name: cursor_cli\n    harness: cursor\n    command: cursor-agent\n",
      "utf8",
    );
    const cfg = await loadConfig(file, { whichFn: async () => "/usr/bin/cursor-agent" });
    const svc = cfg.services["cursor_cli"]!;
    expect(safetyProfileCompatible(svc, "read_only")).toBe(true);
    expect(safetyProfileCompatible(svc, "workspace_edit")).toBe(false);
    expect(svc.protocol?.safety?.read_only).toEqual(["--mode", "plan"]);
  });
});

describe("a CLI route with no flags for the requested profile", () => {
  const base = {
    name: "byo",
    enabled: true,
    type: "cli" as const,
    harness: "generic",
    command: "my-cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: { execute: 1, plan: 1, review: 1 },
    escalateOn: [],
    leaderboardModel: "",
    maxOutputTokens: 100,
    maxInputTokens: 100,
    provider: "custom" as const,
    surface: "custom" as const,
    authSource: "unknown" as const,
    billingKind: "unknown" as const,
    paidUsagePossible: true,
    billingConfidence: "unknown" as const,
  };

  it("reports full_auto, so a stricter request refuses the route", () => {
    // `{{safety}}` expands to the protocol's args for the requested profile,
    // and to [] when the profile is missing — so a route defining only
    // workspace_edit and full_auto, asked for read_only, launched the harness
    // with NO safety arguments at all. This function used to echo the request
    // back, so nothing skipped the route and the dispatch log recorded
    // `safetyProfile: read_only` for a run that carried no restriction. An
    // acceptance pass measured the child's argv: just the prompt.
    const svc = {
      ...base,
      protocol: {
        args: ["{{safety}}", "{{prompt}}"],
        safety: {
          workspace_edit: ["--write"],
          full_auto: ["--yolo"],
        },
      },
    } as never;

    expect(effectiveSafetyProfile(svc, "read_only")).toBe("full_auto");
    expect(
      safetyProfileCompatible(svc, "read_only"),
      "a route that cannot prove it constrains anything must not serve read_only",
    ).toBe(false);
    // The profiles it DOES define still work.
    expect(effectiveSafetyProfile(svc, "workspace_edit")).toBe("workspace_edit");
    expect(safetyProfileCompatible(svc, "workspace_edit")).toBe(true);
  });

  it("leaves a route that declares no safety flags at all alone", () => {
    // No `protocol.safety` means safety is not expressed through flags —
    // that is the shipped `harness: generic` shape, and inventing a refusal
    // for it would break every route that constrains itself another way.
    const svc = { ...base, protocol: { args: ["{{prompt}}"] } } as never;
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("read_only");
    expect(safetyProfileCompatible(svc, "read_only")).toBe(true);
  });

  it("honours an effective_safety pin on a route that is NOT flag-controlled", () => {
    // Declaring the floor is how a route says "I am read-only by
    // construction" without needing a flag to prove it — a wrapper script, or
    // anything whose limits are not expressed as arguments. No `safety:` map,
    // so there is no flag for the pin to contradict.
    const svc = {
      ...base,
      effectiveSafety: "read_only",
      protocol: { args: ["{{prompt}}"] },
    } as never;
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("read_only");
    expect(safetyProfileCompatible(svc, "read_only")).toBe(true);
  });

  it("a pin does NOT silence the flag check on a route that is flag-controlled", () => {
    // The previous version of this test used exactly this fixture while
    // claiming the route was "read-only by construction". It is not: it
    // controls safety with flags and has none for read_only, so `{{safety}}`
    // expands to [] and the harness launches unconstrained. An acceptance
    // pass measured the argv (just the prompt) and the file the "read_only"
    // dispatch wrote into the project. A declaration cannot conjure a flag.
    const svc = {
      ...base,
      effectiveSafety: "read_only",
      protocol: { args: ["{{safety}}"], safety: { full_auto: ["--yolo"] } },
    } as never;
    expect(effectiveSafetyProfile(svc, "read_only")).toBe("full_auto");
    expect(safetyProfileCompatible(svc, "read_only")).toBe(false);
  });

  it("a pin still applies where the flags DO back it", () => {
    // The guard must not fire on the case the pin legitimately covers: a
    // harness whose capability varies by mode, with a flag for the mode asked
    // for. Pinning workspace_edit down to read_only is honoured.
    const svc = {
      ...base,
      effectiveSafety: { workspace_edit: "read_only" },
      protocol: { args: ["{{safety}}"], safety: { workspace_edit: ["--sandbox"] } },
    } as never;
    expect(effectiveSafetyProfile(svc, "workspace_edit")).toBe("read_only");
    expect(safetyProfileCompatible(svc, "workspace_edit")).toBe(true);
  });
});
