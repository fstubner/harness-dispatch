/**
 * The `connect` COMMAND, as opposed to the module underneath it.
 *
 * `tests/client-register.test.ts` covers `planClientWrites`, `writeClientEntry`
 * and `removeClientEntry` thoroughly. Nothing covered the CLI that drives
 * them, and that is where an acceptance pass found `connect --remove`
 * removing nothing: it printed "our entry is here — will be removed", exited
 * 0, and left the file byte-identical.
 *
 * The cause was that `chooseInteractively` filtered out plans in the
 * `matches` state — correct when registering, since a matching entry needs no
 * write, and exactly backwards when removing, where `matches` IS the entry
 * being removed. Only the bare form was affected; `--clients` bypasses that
 * function. The bare form is the one README documents twice and OPERATIONS.md
 * once.
 *
 * These tests drive `main()` end to end rather than the module, because the
 * defect lived entirely in the command's own argument handling.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/bin.js";

let home: string;
const claudeFile = (): string => path.join(home, ".claude.json");

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (c: string) => {
    chunks.push(String(c));
    return true;
  };
  try {
    return { code: await fn(), stdout: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hd-connect-cli-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // A pre-existing file with an unrelated server, so removal can be shown to
  // take out our entry and nothing else.
  await fs.writeFile(
    claudeFile(),
    JSON.stringify({ numStartups: 7, mcpServers: { github: { command: "gh-mcp" } } }, null, 2),
    "utf8",
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
});

/** Register through the CLI, so the entry is exactly what removal looks for. */
async function register(): Promise<void> {
  const out = await capture(() => main(["connect", "--clients", "claude-code", "--yes"]));
  expect(out.code, out.stdout).toBe(0);
  const after = JSON.parse(await fs.readFile(claudeFile(), "utf8"));
  expect(Object.keys(after.mcpServers)).toContain("harness-dispatch");
}

describe("connect --remove without --clients", () => {
  it("actually removes the entry it says it will remove", async () => {
    await register();
    const before = await fs.readFile(claudeFile(), "utf8");

    const out = await capture(() => main(["connect", "--remove", "--yes"]));
    expect(out.code).toBe(0);

    const after = await fs.readFile(claudeFile(), "utf8");
    expect(after, "the file was untouched despite reporting success").not.toBe(before);
    const parsed = JSON.parse(after);
    expect(Object.keys(parsed.mcpServers)).not.toContain("harness-dispatch");
  });

  it("leaves unrelated servers and settings alone", async () => {
    await register();
    await capture(() => main(["connect", "--remove", "--yes"]));
    const parsed = JSON.parse(await fs.readFile(claudeFile(), "utf8"));
    expect(parsed.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(parsed.numStartups).toBe(7);
  });

  it("is a no-op when there is no entry to remove", async () => {
    // `missing-entry` must NOT become actionable just because --remove
    // inverted the filter: there is nothing to take out.
    const before = await fs.readFile(claudeFile(), "utf8");
    const out = await capture(() => main(["connect", "--remove", "--yes"]));
    expect(out.code).toBe(0);
    expect(await fs.readFile(claudeFile(), "utf8")).toBe(before);
  });

  it("still refuses a hand-edited entry without --force", async () => {
    // The consent gate must survive the fix: a `differs` entry is actionable
    // under --remove, but removing it needs --force.
    const parsed = JSON.parse(await fs.readFile(claudeFile(), "utf8"));
    parsed.mcpServers["harness-dispatch"] = { command: "my-own-wrapper" };
    await fs.writeFile(claudeFile(), JSON.stringify(parsed, null, 2), "utf8");
    const before = await fs.readFile(claudeFile(), "utf8");

    const out = await capture(() => main(["connect", "--remove", "--yes"]));
    // Exit 1, and that is a second improvement from the same fix: before it,
    // a hand-edited entry was filtered out of the bare --remove entirely, so
    // the command exited 0 having silently done nothing. It is now actionable,
    // refused for want of consent, and reports that it did not happen.
    expect(out.code).toBe(1);
    expect(await fs.readFile(claudeFile(), "utf8")).toBe(before);
  });
});
