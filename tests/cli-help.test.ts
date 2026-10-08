/**
 * `<command> --help` prints that command's help, not the global block.
 *
 * Every subcommand printed the same text, so finding the flags `doctor` takes
 * meant reading past `serve` and `dispatch`. The global block also offered
 * `serve [--port 3333]` while saying the port defaults to a random free one.
 */

import { describe, expect, it } from "vitest";

import { main } from "../src/bin.js";

async function help(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (c: string) => {
    chunks.push(String(c));
    return true;
  };
  try {
    expect(await main(args)).toBe(0);
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
  return chunks.join("");
}

const COMMANDS = ["configure", "connect", "doctor", "status", "usage", "breaker", "serve", "mcp", "dispatch", "auth"];

describe("per-command help", () => {
  it.each(COMMANDS)("%s --help prints its own usage, flags and an example", async (command) => {
    const text = await help([command, "--help"]);
    expect(text).toMatch(new RegExp(`^Usage: harness-dispatch ${command}\\b`));
    expect(text).toContain("Example: harness-dispatch");
    // Not the global block.
    expect(text).not.toContain("Options:");
  });

  it("gives each command different help", async () => {
    const texts = await Promise.all(COMMANDS.map((c) => help([c, "--help"])));
    expect(new Set(texts).size).toBe(COMMANDS.length);
  });

  it("gives an alias its command's help", async () => {
    expect(await help(["route", "--help"])).toBe(await help(["dispatch", "--help"]));
  });

  it("keeps the global help for --help alone and for an unknown word", async () => {
    expect(await help(["--help"])).toContain("Options:");
    expect(await help(["constructor", "--help"])).toContain("Options:");
  });

  it("states serve's real port behaviour", async () => {
    expect(await help(["serve", "--help"])).toContain("Without it, a random free port is chosen");
    expect(await help(["--help"])).not.toContain("--port 3333");
  });
});
