import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexLoginState } from "../src/dispatchers/shared/harness-login.js";

// Real spawns against fake `codex` executables, not a mocked child_process:
// the whole point of the probe is what the CLI's exit code and text mean, so
// the test has to go through an actual process. Windows gets a .cmd, which
// cross-spawn runs the same way npm's own codex shim runs.

const dir = mkdtempSync(path.join(tmpdir(), "hd-login-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeCodex(name: string, text: string, code: number): string {
  if (process.platform === "win32") {
    const file = path.join(dir, `${name}.cmd`);
    writeFileSync(file, `@echo off\r\necho ${text}\r\nexit /b ${code}\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${text}"\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("codexLoginState", () => {
  it("reads exit 0 as logged in", async () => {
    expect(await codexLoginState(fakeCodex("in", "Logged in using ChatGPT", 0))).toBe("logged_in");
  });

  it("reads a non-zero exit that says so as logged out", async () => {
    expect(await codexLoginState(fakeCodex("out", "Not logged in", 1))).toBe("logged_out");
  });

  it("reads a non-zero exit with any other text as unknown, never as logged out", async () => {
    // An older codex without `login status` fails with a usage error. That
    // must not fail a working install.
    expect(await codexLoginState(fakeCodex("old", "error: unrecognized subcommand", 2))).toBe(
      "unknown",
    );
  });

  it("reads a command that cannot be spawned as unknown", async () => {
    expect(await codexLoginState(path.join(dir, "does-not-exist"))).toBe("unknown");
  });
});
