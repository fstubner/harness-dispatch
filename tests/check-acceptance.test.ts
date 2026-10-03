/**
 * The release gate refuses a tag whose CHANGELOG has no section for it. Run
 * against a scratch tree holding a valid acceptance record, so the CHANGELOG is
 * the only thing that differs between the two cases.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-acceptance.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function gate(changelog: string) {
  const root = mkdtempSync(path.join(tmpdir(), "hd-accept-"));
  roots.push(root);
  mkdirSync(path.join(root, "acceptance"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(
    path.join(root, "acceptance", "1.2.3.md"),
    "# Acceptance\n\n- version: 1.2.3\n- verdict: SHIP\n- date: 2026-01-01\n- reviewer: test\n",
  );
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  return spawnSync(process.execPath, [SCRIPT, "1.2.3"], {
    env: { ...process.env, CHECK_ACCEPTANCE_ROOT: root },
    encoding: "utf8",
  });
}

describe("check-acceptance", () => {
  it("passes when the CHANGELOG has the version's heading", () => {
    const run = gate("# Changelog\n\n## [Unreleased]\n\n## [1.2.3] — 2026-01-01\n- thing\n");
    expect(run.status, run.stderr).toBe(0);
  });

  it("refuses when the CHANGELOG has no heading for the version", () => {
    const run = gate("# Changelog\n\n## [Unreleased]\n\n## [1.2.2] — 2025-12-01\n");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no \"## [1.2.3]\" heading");
  });
});
