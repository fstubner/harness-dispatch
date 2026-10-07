/**
 * Operator instructions: `instructions:` at the top level of config.yaml and
 * on each route, delivered to every connecting agent in the server's
 * instructions and shown per route in `usage`. Written once in config instead
 * of in each client's own instruction file.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { loadConfig, type WhichFn } from "../src/config.js";
import { MAX_INSTRUCTIONS_CHARS } from "../src/config/instructions.js";
import { configToYaml } from "../src/configure-yaml.js";
import { ConfigHotReloader, RuntimeHolder, type RuntimeState } from "../src/mcp/config-hot-reload.js";
import { buildMcpServerInstance, serverInstructions } from "../src/mcp/server.js";
import type { RouterConfig } from "../src/types.js";

const noCli: WhichFn = async () => null;
const allClis: WhichFn = async (cmd: string) => `/fake/bin/${cmd}`;

async function load(yaml: string, which: WhichFn = noCli): Promise<RouterConfig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-instructions-"));
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(file, yaml, "utf8");
  return loadConfig(file, { whichFn: which });
}

const ENDPOINT = [
  "endpoints:",
  "  - name: local_box",
  "    base_url: http://127.0.0.1:1234/v1",
  "    model: one-model",
  "    billing_kind: local_compute",
  "    instructions: one model loaded; leave hints.model unset",
  "  - name: spare_box",
  "    base_url: http://127.0.0.1:1235/v1",
  "    model: other",
  "    billing_kind: local_compute",
  "    enabled: false",
  "    instructions: never shown, the route is off",
];

describe("instructions in config.yaml", () => {
  it("reads the global block and each route's, on every route shape", async () => {
    const cfg = await load(
      [
        "instructions: |",
        "  Pick the cheapest model that can do the task.",
        "detect: true",
        "overrides:",
        "  claude_code_cli:",
        "    instructions: haiku for sweeps, sonnet for most work, opus for hard judgment",
        ...ENDPOINT,
        "",
      ].join("\n"),
      allClis,
    );
    expect(cfg.instructions).toBe("Pick the cheapest model that can do the task.");
    expect(cfg.services["claude_code_cli"]?.instructions).toMatch(/^haiku for sweeps/);
    expect(cfg.services["local_box"]?.instructions).toMatch(/^one model loaded/);
    expect(cfg.configWarnings ?? []).toEqual([]);
  });

  it("cuts an over-long value to the cap and says so, and drops one that is not text", async () => {
    const cfg = await load(
      [
        `instructions: "${"x".repeat(MAX_INSTRUCTIONS_CHARS + 50)}"`,
        "endpoints:",
        "  - name: local_box",
        "    base_url: http://127.0.0.1:1234/v1",
        "    model: one-model",
        "    billing_kind: local_compute",
        "    instructions: [not, text]",
        "",
      ].join("\n"),
    );
    expect(cfg.instructions).toHaveLength(MAX_INSTRUCTIONS_CHARS);
    expect(cfg.services["local_box"]?.instructions).toBeUndefined();
    const warnings = (cfg.configWarnings ?? []).join("\n");
    expect(warnings).toMatch(/instructions are 1050 characters; only the first 1000/);
    expect(warnings).toMatch(/endpoints\[0\].*instructions must be text, not a list/);
  });

  it("survives a configure rewrite", async () => {
    const cfg = await load(["instructions: global policy", ...ENDPOINT, ""].join("\n"));
    const reloaded = await load(configToYaml(cfg, { redactLiterals: false }));
    expect(reloaded.instructions).toBe("global policy");
    expect(reloaded.services["local_box"]?.instructions).toMatch(/^one model loaded/);
  });
});

describe("what a connecting agent is told", () => {
  it("appends the global and enabled routes' instructions to the server's own", async () => {
    const cfg = await load(["instructions: global policy", ...ENDPOINT, ""].join("\n"));
    const text = serverInstructions(cfg);
    expect(text).toMatch(/^This server turns/);
    expect(text).toContain("global policy");
    expect(text).toContain("- local_box: one model loaded");
    expect(text, "a disabled route's instructions were sent").not.toContain("spare_box");
  });

  it("does not put a secret the config interpolated into the text", async () => {
    process.env["HD_TEST_SECRET_KEY"] = "sk-test-SECRET-value-123456";
    try {
      const cfg = await load(
        [
          "instructions: the key is ${HD_TEST_SECRET_KEY}",
          "endpoints:",
          "  - name: paid_box",
          "    base_url: http://127.0.0.1:1234/v1",
          "    model: m",
          "    billing_kind: local_compute",
          "    api_key: ${HD_TEST_SECRET_KEY}",
          "",
        ].join("\n"),
      );
      expect(serverInstructions(cfg)).not.toContain("sk-test-SECRET-value-123456");
    } finally {
      delete process.env["HD_TEST_SECRET_KEY"];
    }
  });

  it("reaches a real MCP client when it connects", async () => {
    const cfg = await load(["instructions: global policy", ...ENDPOINT, ""].join("\n"));
    const holder = new RuntimeHolder({ config: cfg } as unknown as RuntimeState);
    const server = buildMcpServerInstance(holder, {} as unknown as ConfigHotReloader);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "instructions-test", version: "test" }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const received = client.getInstructions() ?? "";
      expect(received).toContain("global policy");
      expect(received).toContain("- local_box: one model loaded");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
