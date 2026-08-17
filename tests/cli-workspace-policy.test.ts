/**
 * `workspace_policy` on a `clis:` route must actually be read.
 *
 * It was handled for `services:` and `endpoints:` — both route through
 * billingFields — but buildCliServiceConfig does not call that, so the key was
 * silently dropped on the primary documented way to define a route. Asking for
 * `copy` gave you `shared_locked`: the LESS isolated default, with no warning,
 * because the key is spelled right and the value is valid. The fail-open enum
 * check cannot catch this class — nothing was reading the field at all.
 *
 * Found while hunting a concurrency serializer: with the setting ignored, the
 * two policies were indistinguishable in a benchmark (31.4s vs 31.1s). Once
 * honoured, `copy` ran 12 jobs in 11.7s against `shared_locked`'s 31.4s.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-wspol-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function configWith(policyLine: string): Promise<string> {
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "clis:",
      "  - name: probe",
      "    harness: generic",
      "    command: node",
      "    tier: 3",
      ...(policyLine ? [`    ${policyLine}`] : []),
      "    protocol:",
      '      args: ["-e", "0"]',
      "      output: { mode: text }",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("workspace_policy on a clis: entry", () => {
  it.each(["copy", "git_worktree", "shared", "shared_locked"])(
    "is honoured for %s",
    async (policy) => {
      const cfg = await loadConfig(await configWith(`workspace_policy: ${policy}`), {
        whichFn: async () => null,
      });
      expect(cfg.services["probe"]?.workspacePolicy).toBe(policy);
    },
  );

  it("stays undefined when not set, so the route keeps the built-in default", async () => {
    const cfg = await loadConfig(await configWith(""), { whichFn: async () => null });
    expect(cfg.services["probe"]?.workspacePolicy).toBeUndefined();
  });

  it("ignores an invalid value and warns, rather than inventing a policy", async () => {
    const cfg = await loadConfig(await configWith("workspace_policy: coppy"), {
      whichFn: async () => null,
    });
    expect(cfg.services["probe"]?.workspacePolicy).toBeUndefined();
    expect((cfg.configWarnings ?? []).join(" ")).toContain("coppy");
  });
});
