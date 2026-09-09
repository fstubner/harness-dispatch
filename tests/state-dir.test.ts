import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
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

describe("POSIX defaults measured in a container", () => {
  /**
   * A POSIX audit — the first one this project has ever had — found three
   * things that are invisible on Windows and were therefore never tested.
   */
  it("the default workspaces root is per-user on POSIX, plain on Windows", async () => {
    // /tmp is shared on Linux while os.tmpdir() is per-user on Windows, so a
    // single shared folder name meant whoever dispatched first owned
    // /tmp/harness-dispatch 0700 and every other user was refused `copy` and
    // `git_worktree` outright. Reproduced with two ordinary unprivileged
    // users; the same mechanism locks you out of your own tool after one
    // `sudo` run. The ownership guard is unchanged — this gives it a root per
    // user, which is what it assumes it is protecting.
    const { workspacesBase } = await import("../src/workspaces.js");
    const saved = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    try {
      const base = workspacesBase();
      if (process.platform === "win32") {
        expect(base).toContain("harness-dispatch");
      } else {
        expect(base, "no uid segment: a second user is locked out").toMatch(
          /harness-dispatch-\d+/,
        );
      }
    } finally {
      if (saved !== undefined) process.env.HARNESS_DISPATCH_WORKSPACES_DIR = saved;
    }
  });

  it("the POSIX command-line budget counts bytes, not UTF-16 units", async () => {
    // Measured through the built artifact: 100,000 CJK characters in one
    // argument measured 100,021 against a 129,024 budget so the guard did not
    // fire, while the kernel saw 300,000 bytes and the spawn died E2BIG —
    // exactly what the guard exists to prevent. Reachable via the one shipped
    // route that puts the prompt in argv rather than on stdin.
    const wide = "漢".repeat(1000);
    expect(Buffer.byteLength(wide, "utf8")).toBe(3000);
    expect(wide.length).toBe(1000);
    // The product must agree with the kernel, not with String.length.
    const src = readFileSync(
      path.join(process.cwd(), "src", "dispatchers", "generic-cli.ts"),
      "utf8",
    );
    expect(src, "the POSIX branch is back to counting code units").toContain(
      'Buffer.byteLength(a, "utf8")',
    );
  });
});
