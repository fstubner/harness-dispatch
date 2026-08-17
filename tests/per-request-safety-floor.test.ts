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
