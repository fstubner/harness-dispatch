import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stateRoot, userConfigPath } from "../src/state-dir.js";

// Every state path is built on stateRoot(): config, jobs, breaker state,
// quota counters, logs, workspace locks. A live code review found it trusting
// `??`, which treats an EMPTY variable as a real value — and an empty value is
// exactly what a launcher or shell produces when it forwards a variable that
// is not set. The result was a state root of "", so all of the above resolved
// against the process's current directory: two commands run from different
// places would silently use different state.

const VAR = "HARNESS_DISPATCH_STATE_DIR";
const saved = process.env[VAR];

afterEach(() => {
  if (saved === undefined) delete process.env[VAR];
  else process.env[VAR] = saved;
});

describe("stateRoot", () => {
  it("ignores an empty variable instead of rooting every state path at the cwd", () => {
    process.env[VAR] = "";
    const root = stateRoot();
    expect(root, "an empty override produced an empty state root").not.toBe("");
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toBe(path.join(os.homedir(), ".harness-dispatch"));
    // The consequence the emptiness actually had:
    expect(path.isAbsolute(userConfigPath())).toBe(true);
  });

  it("ignores a whitespace-only variable for the same reason", () => {
    process.env[VAR] = "   ";
    expect(path.isAbsolute(stateRoot())).toBe(true);
    expect(stateRoot()).toBe(path.join(os.homedir(), ".harness-dispatch"));
  });

  it("anchors a relative value, so a runner spawned elsewhere reads the same root", () => {
    process.env[VAR] = "hd-state";
    const root = stateRoot();
    expect(path.isAbsolute(root), "a relative override stayed relative").toBe(true);
    expect(root).toBe(path.resolve("hd-state"));
  });

  it("uses an absolute value as given", () => {
    const dir = path.join(os.tmpdir(), "hd-state-abs");
    process.env[VAR] = dir;
    expect(stateRoot()).toBe(path.resolve(dir));
    expect(userConfigPath()).toBe(path.join(path.resolve(dir), "config.yaml"));
  });
});

describe("every directory env var follows the same rule", () => {
  /**
   * `stateRoot` was fixed for an empty value and gained a careful comment
   * explaining why. Its five siblings kept `??` and kept the bug — measured:
   * `HARNESS_DISPATCH_JOBS_DIR=""` put the jobs tree in the process's current
   * directory, and `HARNESS_DISPATCH_LOG_DIR=""` wrote dispatches.jsonl there.
   * An upgrade audit found two of them; there were five.
   *
   * Table-driven on purpose. A per-variable test is what let one get fixed
   * while four did not, so adding a variable without adding it here should be
   * the thing that fails.
   */
  const VARS: Array<[string, () => Promise<string>]> = [
    ["HARNESS_DISPATCH_STATE_DIR", async () => (await import("../src/state-dir.js")).stateRoot()],
    ["HARNESS_DISPATCH_HOME", async () => (await import("../src/auth.js")).tokenPath()],
    ["HARNESS_DISPATCH_LOG_DIR", async () => (await import("../src/dispatch-log.js")).dispatchLogPath()],
    ["HARNESS_DISPATCH_JOBS_DIR", async () => (await import("../src/jobs/store.js")).jobsRoot()],
    ["HARNESS_DISPATCH_WORKSPACES_DIR", async () => (await import("../src/workspaces.js")).workspacesBase()],
  ];

  for (const [name, read] of VARS) {
    it(`${name}: empty means unset, not the empty path`, async () => {
      const saved = process.env[name];
      try {
        process.env[name] = "";
        const empty = await read();
        expect(empty, `${name}="" produced a relative path`).not.toBe("");
        expect(path.isAbsolute(empty), `${name}="" produced ${empty}`).toBe(true);

        process.env[name] = "   ";
        expect(path.isAbsolute(await read()), `${name}="   " produced a relative path`).toBe(true);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    });

    it(`${name}: a relative value is anchored`, async () => {
      // A detached job runner starts in a different working directory than the
      // server that spawned it, so an unanchored relative path meant the two
      // disagreed about where state lived.
      const saved = process.env[name];
      try {
        process.env[name] = "rel-state";
        const resolved = await read();
        expect(path.isAbsolute(resolved), `${name} stayed relative: ${resolved}`).toBe(true);
        expect(resolved).toContain("rel-state");
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    });
  }
});
