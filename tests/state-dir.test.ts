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
