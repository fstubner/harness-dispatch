/**
 * `api_key_file:` — a route key read from a file at load time.
 *
 * The documented ways to hand the server a key were an inherited environment
 * variable (reaches every process the user runs) or an MCP client `env` block
 * (plaintext JSON in the home directory). Both are readable by a delegate that
 * can read the home directory (audit5 F6). A file the server alone opens keeps
 * the key out of every process environment.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { configToYaml } from "../src/configure-yaml.js";
import { collectSecrets } from "../src/redaction.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-keyfile-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const KEY = "gsk-file-held-key-0123456789";

async function configWith(line: string): Promise<string> {
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "endpoints:",
      "  - name: groq",
      "    base_url: https://api.groq.example.test/openai/v1",
      "    model: some-model",
      `    ${line}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("api_key_file", () => {
  it("loads the key from a file next to the config, and redaction knows it", async () => {
    await fs.mkdir(path.join(dir, "keys"));
    await fs.writeFile(path.join(dir, "keys", "groq"), `${KEY}\n`, "utf8");
    const cfg = await loadConfig(await configWith("api_key_file: keys/groq"), {
      whichFn: async () => null,
    });
    expect(cfg.services["groq"]!.apiKey).toBe(KEY);
    expect(collectSecrets(cfg)).toContain(KEY);
    expect(cfg.configWarnings ?? []).not.toContainEqual(expect.stringMatching(/api_key_file/));
    expect(Object.values(process.env)).not.toContain(KEY);
  });

  it("is written back by configure as the file, never as the key", async () => {
    await fs.writeFile(path.join(dir, "groq.key"), KEY, "utf8");
    const cfg = await loadConfig(await configWith("api_key_file: groq.key"), {
      whichFn: async () => null,
    });
    for (const redactLiterals of [false, true]) {
      const out = configToYaml(cfg, { redactLiterals });
      expect(out).toContain("api_key_file: groq.key");
      expect(out).not.toContain(KEY);
      expect(out).not.toMatch(/^\s*api_key:/m);
    }
  });

  it("refuses an unreadable file, naming the route", async () => {
    await expect(
      loadConfig(await configWith("api_key_file: nope.key"), { whichFn: async () => null }),
    ).rejects.toThrow(/route "groq": api_key_file .*nope\.key could not be read/);
  });

  it("refuses api_key and api_key_file together", async () => {
    await fs.writeFile(path.join(dir, "groq.key"), KEY, "utf8");
    const file = await configWith("api_key_file: groq.key");
    await fs.appendFile(file, "    api_key: literal-key-0123456789\n", "utf8");
    await expect(loadConfig(file, { whichFn: async () => null })).rejects.toThrow(/not both/);
  });
});
