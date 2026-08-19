/**
 * Config loader tests.
 *
 * Covers: legacy YAML format, auto-detect + overrides, ${ENV_VAR} interpolation,
 * and the mtime-based watchConfig poller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, watchConfig, type WhichFn } from "../src/config.js";

// ---- fixture files -------------------------------------------------------

/** Newline, as a named constant purely to keep long join() lines readable. */
const NL = "\n";

async function writeTmpYaml(name: string, text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `harness-dispatch-test-`));
  const p = path.join(dir, name);
  await fs.writeFile(p, text, "utf-8");
  return p;
}

// Mock which-functions for deterministic auto-detect.
const noCliFound: WhichFn = async () => null;
const allCliFound: WhichFn = async (cmd) => `/usr/bin/${cmd}`;
const onlyClaudeFound: WhichFn = async (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null);
const onlyAntigravityFound: WhichFn = async (cmd) =>
  cmd === "agy" ? "/usr/bin/agy" : null;

describe("loadConfig — legacy full format", () => {
  it("passes a YAML with a top-level services: key through verbatim", async () => {
    const yamlText = `
services:
  alpha:
    enabled: true
    type: cli
    command: alpha-bin
    tier: 1
    weight: 1.5
    cli_capability: 1.10
    leaderboard_model: claude-opus-4-6
    timeout_ms: 1800000
    capabilities:
      execute: 0.9
      plan: 1.0
      review: 0.95
  beta:
    enabled: false
    type: openai_compatible
    base_url: http://localhost:11434/v1
    model: llama3
    tier: 3
`;
    const p = await writeTmpYaml("config.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual(["alpha", "beta"]);
    expect(cfg.services.alpha!.tier).toBe(1);
    expect(cfg.services.alpha!.weight).toBeCloseTo(1.5, 10);
    expect(cfg.services.alpha!.cliCapability).toBeCloseTo(1.1, 10);
    expect(cfg.services.alpha!.leaderboardModel).toBe("claude-opus-4-6");
    expect(cfg.services.alpha!.timeoutMs).toBe(1_800_000);
    expect(cfg.services.alpha!.capabilities.execute).toBeCloseTo(0.9, 10);
    expect(cfg.services.beta!.enabled).toBe(false);
    expect(cfg.services.beta!.type).toBe("openai_compatible");
    expect(cfg.services.beta!.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("parses protocol: on a legacy-format harness: generic service (not just clis: entries)", async () => {
    const yamlText = `
services:
  my_cli:
    enabled: true
    type: cli
    harness: generic
    command: my-cli
    tier: 1
    protocol:
      args: ["{{prompt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("legacy-generic.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli!.protocol).toEqual({
      args: ["{{prompt}}"],
      output: { mode: "text" },
    });
  });

  it("warns loudly (doesn't silently drop) when clis:/endpoints:/overrides: sit alongside services:", async () => {
    const yamlText = `
services:
  old_route:
    enabled: true
    type: cli
    command: old-bin
    tier: 1
clis:
  - name: new_route
    harness: codex
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: llama3.2
`;
    const p = await writeTmpYaml("mixed-format.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });

    // The known behavior: clis:/endpoints: are still ignored (legacy wins).
    expect(Object.keys(cfg.services)).toEqual(["old_route"]);
    // The fix: it's no longer silent.
    const warningText = cfg.configWarnings!.join("\n");
    expect(warningText).toContain("services:");
    expect(warningText).toContain("clis:");
    expect(warningText).toContain("endpoints:");
  });

  it("does NOT warn about clis:/endpoints: when services: is used alone", async () => {
    const yamlText = `
services:
  old_route:
    enabled: true
    type: cli
    command: old-bin
    tier: 1
`;
    const p = await writeTmpYaml("services-only.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.configWarnings ?? []).toEqual([]);
  });

  it("inherits maxInputTokens/maxOutputTokens from the named harness's shipped defaults (legacy format)", async () => {
    // antigravity_cli's shipped entry declares a 2M-token context window;
    // router.ts's preferLargeContext boost keys off this DECLARED value,
    // not the harness name, so a legacy entry naming the harness must
    // still inherit it or the boost silently becomes a no-op.
    const yamlText = `
services:
  agy_legacy:
    enabled: true
    type: cli
    harness: antigravity_cli
    command: agy
    tier: 1
`;
    const p = await writeTmpYaml("legacy-inherit-tokens.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.agy_legacy!;
    expect(svc.maxInputTokens).toBe(2_000_000);
    expect(svc.maxOutputTokens).toBe(65536);
  });

  it("an explicit max_input_tokens on a legacy entry still wins over the harness default", async () => {
    const yamlText = `
services:
  agy_legacy:
    enabled: true
    type: cli
    harness: antigravity_cli
    command: agy
    tier: 1
    max_input_tokens: 500000
`;
    const p = await writeTmpYaml("legacy-explicit-tokens.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.agy_legacy!.maxInputTokens).toBe(500000);
  });
});

describe("loadConfig — ${ENV_VAR} interpolation warnings", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("warns when a ${VAR} reference resolves to nothing because the env var is unset", async () => {
    delete process.env["HR_TEST_DEFINITELY_UNSET_VAR"];
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    api_key: \${HR_TEST_DEFINITELY_UNSET_VAR}
    protocol:
      args: ["{{prompt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("unset-env-var.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = cfg.configWarnings!.join("\n");
    expect(warningText).toContain("HR_TEST_DEFINITELY_UNSET_VAR");
    // The field itself still silently empties (existing, documented
    // behavior) — the fix is that it's no longer UNREPORTED.
    expect(cfg.services.my_cli!.apiKey).toBeUndefined();
  });

  it("does NOT warn when the referenced env var is actually set", async () => {
    process.env["HR_TEST_SET_VAR"] = "sk-real-value";
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    api_key: \${HR_TEST_SET_VAR}
    protocol:
      args: ["{{prompt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("set-env-var.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.configWarnings ?? []).toEqual([]);
    expect(cfg.services.my_cli!.apiKey).toBe("sk-real-value");
  });

  it("warns for an unset env var reached via the legacy services: format too", async () => {
    delete process.env["HR_TEST_DEFINITELY_UNSET_VAR"];
    const yamlText = `
services:
  my_svc:
    enabled: true
    type: openai_compatible
    base_url: http://localhost:1234/v1
    model: llama3
    api_key: \${HR_TEST_DEFINITELY_UNSET_VAR}
`;
    const p = await writeTmpYaml("legacy-unset-env-var.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = cfg.configWarnings!.join("\n");
    expect(warningText).toContain("HR_TEST_DEFINITELY_UNSET_VAR");
  });
});

describe("loadConfig — auto-detect + overrides", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns only services whose CLI is on PATH", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyClaudeFound });
    expect(Object.keys(cfg.services)).toEqual(["claude_code_cli"]);
    const svc = cfg.services.claude_code_cli!;
    expect(svc.harness).toBe("claude_code");
    expect(svc.command).toBe("claude");
    expect(svc.cliCapability).toBeCloseTo(1.1, 10);
    expect(svc.leaderboardModel).toBe("claude-opus-4-6");
    expect(svc.billingKind).toBeUndefined();
  });

  it("returns all default services when all CLIs are found", async () => {
    const cfg = await loadConfig(undefined, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual([
      "antigravity_cli",
      "claude_code_cli",
      "codex_cli",
      "cursor_cli",
    ]);
  });

  it("claude_code_cli's protocol actually forwards api_key via ANTHROPIC_API_KEY (not silently dropped)", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyClaudeFound });
    expect(cfg.services.claude_code_cli!.protocol?.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
  });

  it("merges overrides onto auto-detected defaults", async () => {
    const yamlText = `
overrides:
  claude_code_cli:
    weight: 1.5
    timeout_ms: 1200000
    capabilities:
      execute: 0.5
`;
    const p = await writeTmpYaml("minimal.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    const cc = cfg.services.claude_code_cli!;
    expect(cc.weight).toBeCloseTo(1.5, 10);
    expect(cc.timeoutMs).toBe(1_200_000);
    expect(cc.capabilities.execute).toBeCloseTo(0.5, 10);
    // Non-overridden capability stays at default
    expect(cc.capabilities.plan).toBeCloseTo(1.0, 10);
    // A route with no override has no timeoutMs — the dispatcher's own
    // hard-coded default applies.
    expect(cfg.services.codex_cli!.timeoutMs).toBeUndefined();
  });

  it("honors the disabled list", async () => {
    const yamlText = `
disabled: [cursor_cli, codex_cli]
`;
    const p = await writeTmpYaml("disabled.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual(["antigravity_cli", "claude_code_cli"]);
  });

  it("warns instead of silently ignoring a pre-rename disabled: name", async () => {
    const yamlText = `
disabled: [cursor]
`;
    const p = await writeTmpYaml("disabled-old-name.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    // "cursor" doesn't match cursor_cli, so the route is NOT disabled — this
    // documents the (surprising, hence the warning) actual behavior.
    expect(Object.keys(cfg.services)).toContain("cursor_cli");
    expect(cfg.configWarnings).toBeDefined();
    expect(cfg.configWarnings!.join("\n")).toContain("cursor");
  });

  it("warns instead of silently ignoring a pre-rename overrides: key", async () => {
    const yamlText = `
overrides:
  cursor:
    weight: 5
`;
    const p = await writeTmpYaml("overrides-old-name.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    // The override was never applied — cursor_cli keeps its normal weight.
    expect(cfg.services.cursor_cli!.weight).not.toBe(5);
    expect(cfg.configWarnings).toBeDefined();
    expect(cfg.configWarnings!.join("\n")).toContain("overrides.cursor");
  });

  it("adds endpoints from the endpoints: list", async () => {
    const yamlText = `
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: llama3
    tier: 3
    weight: 0.8
    workspace_policy: copy
    timeout_ms: 300000
`;
    const p = await writeTmpYaml("endpoints.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.ollama).toBeDefined();
    expect(cfg.services.ollama!.type).toBe("openai_compatible");
    expect(cfg.services.ollama!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.services.ollama!.tier).toBe(3);
    expect(cfg.services.ollama!.weight).toBeCloseTo(0.8, 10);
    expect(cfg.services.ollama!.workspacePolicy).toBe("copy");
    expect(cfg.services.ollama!.timeoutMs).toBe(300_000);
  });

  it("detects Antigravity CLI from the agy command", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyAntigravityFound });
    const svc = cfg.services.antigravity_cli!;

    expect(Object.keys(cfg.services)).toEqual(["antigravity_cli"]);
    expect(svc.command).toBe("agy");
    expect(svc.harness).toBe("antigravity_cli");
    expect(svc.surface).toBe("antigravity_cli");
  });

  it("classifies local OpenAI-compatible endpoints with explicit endpoint metadata", async () => {
    const yamlText = `
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: qwen2.5-coder
  - name: lmstudio
    base_url: http://127.0.0.1:1234/v1
    model: qwen3-coder
`;
    const p = await writeTmpYaml("local-endpoints.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });

    expect(cfg.services.ollama!.endpointMode).toBe("direct_openai_compatible");
    expect(cfg.services.ollama!.endpointProvider).toBe("ollama");
    expect(cfg.services.ollama!.wireProtocol).toBe("openai_chat_completions");
    expect(cfg.services.ollama!.billingKind).toBe("local_compute");
    expect(cfg.services.ollama!.paidUsagePossible).toBe(false);

    expect(cfg.services.lmstudio!.endpointProvider).toBe("lmstudio");
  });

  it("parses wire_protocol: anthropic_messages on an endpoint entry", async () => {
    const yamlText = `
endpoints:
  - name: anthropic_api
    base_url: https://api.anthropic.com/v1
    model: claude-opus-4-6
    api_key: sk-ant-test
    wire_protocol: anthropic_messages
    allow_paid_usage: true
    max_output_tokens: 8192
`;
    const p = await writeTmpYaml("anthropic-endpoint.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.anthropic_api!;

    expect(svc.wireProtocol).toBe("anthropic_messages");
    expect(svc.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(svc.maxOutputTokens).toBe(8192);
  });

  it("parses thinking_level and max_input_tokens on an endpoint entry (previously silently dropped)", async () => {
    const yamlText = `
endpoints:
  - name: openrouter_thinking
    base_url: https://openrouter.ai/api/v1
    model: openai/gpt-5.6
    api_key: sk-or-test
    thinking_level: high
    max_input_tokens: 200000
    allow_paid_usage: true
`;
    const p = await writeTmpYaml("endpoint-thinking.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.openrouter_thinking!;

    expect(svc.thinkingLevel).toBe("high");
    expect(svc.maxInputTokens).toBe(200000);
  });
});

describe("loadConfig — ${ENV_VAR} interpolation", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("replaces ${CODEX_API_KEY} with the environment value via the *_cli_api_key shorthand", async () => {
    process.env.CODEX_API_KEY = "test-key-xyz";
    const yamlText = `
codex_cli_api_key: \${CODEX_API_KEY}
`;
    const p = await writeTmpYaml("env.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(cfg.services.codex_cli!.apiKey).toBe("test-key-xyz");
  });

  it("interpolates strings inside nested overrides", async () => {
    process.env.MY_MODEL = "custom-model-1";
    const yamlText = `
overrides:
  claude_code_cli:
    model: \${MY_MODEL}
`;
    const p = await writeTmpYaml("nested.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(cfg.services.claude_code_cli!.model).toBe("custom-model-1");
  });

  it("interpolates a reference EMBEDDED in a longer string, as the shipped config promises", async () => {
    // config.default.yaml has said "anywhere in a string value" all along; the
    // implementation was anchored to whole-string matches, so
    // `base_url: https://\${HOST}/v1` stayed a literal dollar-brace and failed
    // downstream with an error that never mentioned the env var.
    process.env.HR_TEST_HOST = "inference.local:8080";
    const yamlText = `
endpoints:
  - name: local_inference
    base_url: https://\${HR_TEST_HOST}/v1
    model: m
`;
    const p = await writeTmpYaml("embedded.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.local_inference!.baseUrl).toBe("https://inference.local:8080/v1");
  });

  it("warns about an unset var even when the reference is embedded", async () => {
    const yamlText = `
endpoints:
  - name: local_inference
    base_url: https://\${HR_TEST_DEFINITELY_UNSET_VAR}/v1
    model: m
`;
    const p = await writeTmpYaml("embedded-unset.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect((cfg.configWarnings ?? []).join(" ")).toContain("HR_TEST_DEFINITELY_UNSET_VAR");
  });
});

describe("loadConfig — clis: (explicit, endpoints-style CLI declarations)", () => {
  it("adds a custom-named CLI route decoupled from the auto-detect default name", async () => {
    const yamlText = `
clis:
  - name: codex_sol
    harness: codex
    model: gpt-5.6-sol
    tier: 1
    weight: 0.9
`;
    const p = await writeTmpYaml("clis.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.codex_sol!;
    expect(svc.harness).toBe("codex");
    expect(svc.model).toBe("gpt-5.6-sol");
    expect(svc.command).toBe("codex"); // inherited from CLI_DEFAULTS.codex
    expect(svc.weight).toBeCloseTo(0.9, 10);
  });

  it("is not gated on which() — added even when the CLI isn't detected", async () => {
    const yamlText = `
clis:
  - name: codex_sol
    harness: codex
`;
    const p = await writeTmpYaml("clis-nowhich.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.codex_sol).toBeDefined();
  });

  it("skips entries with an unknown harness and records why in configWarnings", async () => {
    const yamlText = `
clis:
  - name: bogus
    harness: not_a_real_harness
`;
    const p = await writeTmpYaml("clis-bogus.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.bogus).toBeUndefined();
    expect(cfg.configWarnings).toBeDefined();
    expect(cfg.configWarnings!.join("\n")).toContain("not_a_real_harness");
  });

  it("records a warning for a clis: entry missing name/harness", async () => {
    const yamlText = `
clis:
  - model: gpt-5.6-sol
`;
    const p = await writeTmpYaml("clis-missing.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.configWarnings).toBeDefined();
    expect(cfg.configWarnings!.join("\n")).toContain("missing required");
  });

  it("supports an inline api_key like endpoints do", async () => {
    const yamlText = `
clis:
  - name: codex_metered
    harness: codex
    api_key: sk-inline-test
`;
    const p = await writeTmpYaml("clis-apikey.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.codex_metered!;
    expect(svc.apiKey).toBe("sk-inline-test");
    expect(svc.authSource).toBe("api_key");
    expect(svc.billingKind).toBe("metered_api");
  });

  it("can coexist with an auto-detected route of the same harness under a different name", async () => {
    const yamlText = `
clis:
  - name: codex_sol
    harness: codex
    model: gpt-5.6-sol
`;
    const p = await writeTmpYaml("clis-coexist.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual([
      "antigravity_cli",
      "claude_code_cli",
      "codex_cli",
      "codex_sol",
      "cursor_cli",
    ]);
  });
});

describe("loadConfig — top-level settings (telemetry, retention)", () => {
  it("parses telemetry.enabled and retention.jobs_days in the modern format", async () => {
    const yamlText = `
telemetry:
  enabled: true
retention:
  jobs_days: 3
clis: []
`;
    const p = await writeTmpYaml("settings-modern.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.telemetry).toEqual({ enabled: true });
    expect(cfg.retention).toEqual({ jobsDays: 3 });
  });

  it("parses the same settings in the legacy services: format", async () => {
    const yamlText = `
telemetry:
  enabled: true
retention:
  jobs_days: 14
services:
  alpha:
    enabled: true
    type: cli
    command: alpha-bin
    tier: 1
`;
    const p = await writeTmpYaml("settings-legacy.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.telemetry).toEqual({ enabled: true });
    expect(cfg.retention).toEqual({ jobsDays: 14 });
  });

  it("defaults to no telemetry and no retention override when absent", async () => {
    const cfg = await loadConfig(undefined, { whichFn: noCliFound });
    expect(cfg.telemetry).toBeUndefined();
    expect(cfg.retention).toBeUndefined();
  });
});

describe("loadConfig — clis: harness: generic (config-driven CLI protocol)", () => {
  it("is never auto-detected, even when every CLI is found", async () => {
    const cfg = await loadConfig(undefined, { whichFn: allCliFound });
    expect(cfg.services.generic).toBeUndefined();
    expect(Object.keys(cfg.services)).not.toContain("generic");
  });

  it("parses a full protocol block into the route's ServiceConfig", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    tier: 3
    protocol:
      args: ["-p", "{{prompt}}", "{{working_dir}}", "{{model}}", "{{safety}}", "--json"]
      working_dir: { flag: "--cd" }
      model: { flag: "--model" }
      output:
        mode: json_field
        fields: ["result", "output"]
      safety:
        read_only: ["--mode", "plan"]
        full_auto: ["--dangerous"]
`;
    const p = await writeTmpYaml("clis-generic.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    expect(svc.harness).toBe("generic");
    expect(svc.command).toBe("my-cli");
    expect(svc.protocol).toEqual({
      args: ["-p", "{{prompt}}", "{{working_dir}}", "{{model}}", "{{safety}}", "--json"],
      workingDir: { flag: "--cd" },
      model: { flag: "--model" },
      output: { mode: "json_field", fields: ["result", "output"] },
      safety: { read_only: ["--mode", "plan"], full_auto: ["--dangerous"] },
    });
  });

  it("skips a generic entry missing command, with a warning", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    protocol:
      prompt_input: { mode: positional }
      output_mode: text
`;
    const p = await writeTmpYaml("clis-generic-nocommand.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    expect(cfg.configWarnings!.join("\n")).toContain("requires an explicit \"command\"");
  });

  it("skips a generic entry missing protocol, with a warning", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
`;
    const p = await writeTmpYaml("clis-generic-noprotocol.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    expect(cfg.configWarnings!.join("\n")).toContain("requires a \"protocol\" block");
  });

  it("warns on an unrecognized {{placeholder}} in protocol.args — the primary user typo", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["{{promt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-typo-placeholder.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = cfg.configWarnings!.join("\n");
    expect(warningText).toContain("{{promt}}");
    expect(warningText).toContain("literal");
    // A typo'd prompt placeholder also means the prompt is never sent at all.
    expect(warningText).toContain("{{prompt}}");
  });

  it("does NOT report the same protocol defect twice under two different labels", async () => {
    // addClis pre-validates (to skip malformed entries before the route
    // ever lands) and buildCliServiceConfig parses the same protocol block
    // again to actually build it — a naive implementation reports every
    // defect once per parse, i.e. twice per real problem.
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["{{promt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-dedup.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    // An unrecognized placeholder passes through as a literal token rather
    // than failing to parse, so the entry is built successfully — meaning
    // BOTH addClis's pre-validation pass and buildCliServiceConfig's real
    // parse run against it, and would each warn without the dedup fix.
    const occurrences = (cfg.configWarnings ?? []).filter((w) => w.includes("{{promt}}")).length;
    expect(occurrences).toBe(1);
  });

  it("warns when protocol.args has no {{prompt}} and stdin is not enabled", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["--go"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-no-prompt.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.configWarnings!.join("\n")).toMatch(/prompt (is|will) never/i);
  });

  it("does NOT warn about a missing {{prompt}} when stdin: true carries it", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["--go", "-"]
      stdin: true
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-stdin-ok.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect((cfg.configWarnings ?? []).join("\n")).not.toMatch(/prompt (is|will) never/i);
  });

  it("skips a generic entry with args missing, with a warning", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-badprompt.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    expect(cfg.configWarnings!.join("\n")).toContain("protocol.args");
  });

  it("skips a generic entry with an invalid output.mode, with a warning", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["{{prompt}}"]
      output: { mode: carrier_pigeon }
`;
    const p = await writeTmpYaml("clis-generic-badoutput.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    expect(cfg.configWarnings!.join("\n")).toContain("protocol.output.mode");
  });

  it("defaults billing to unknown/blocked — no way to know an arbitrary CLI's real billing model", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["{{prompt}}"]
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-billing.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    expect(svc.billingKind).toBe("unknown");
    expect(svc.paidUsagePossible).toBe(true);
  });

  it("minimal protocol (positional prompt, text output, no working_dir/model) parses with those fields absent", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      args: ["{{prompt}}"]
      stdin: true
      output: { mode: text }
`;
    const p = await writeTmpYaml("clis-generic-minimal.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    expect(svc.protocol).toEqual({ args: ["{{prompt}}"], stdin: true, output: { mode: "text" } });
  });

  it("resolves protocol: <name> to a named preset", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: cursor-agent
    protocol: cursor
`;
    const p = await writeTmpYaml("clis-generic-preset.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    expect(svc.protocol?.workingDir).toEqual({ flag: "--workspace", fallback: "home" });
    expect(svc.protocol?.apiKeyEnvVar).toBe("CURSOR_API_KEY");
  });

  it("skips an entry with an unrecognized preset name, with a warning listing valid names", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol: not_a_real_preset
`;
    const p = await writeTmpYaml("clis-generic-badpreset.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    const warningText = cfg.configWarnings!.join("\n");
    expect(warningText).toContain("not_a_real_preset");
    expect(warningText).toContain("cursor");
  });

  it("protocol.extends starts from a preset and overrides only the given fields", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-codex-fork
    protocol:
      extends: codex
      model: { flag: "--llm-model" }
`;
    const p = await writeTmpYaml("clis-generic-extends.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    // Overridden field:
    expect(svc.protocol?.model).toEqual({ flag: "--llm-model" });
    // Everything else inherited from the codex preset, untouched:
    expect(svc.protocol?.stdin).toBe(true);
    expect(svc.protocol?.args?.[0]).toBe("exec");
    expect(svc.protocol?.output.eventRules?.length).toBeGreaterThan(0);
  });

  it("protocol.extends merges safety per-profile instead of replacing the whole map", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-codex-fork
    protocol:
      extends: codex
      safety:
        full_auto: ["--yolo"]
`;
    const p = await writeTmpYaml("clis-generic-extends-safety.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const svc = cfg.services.my_cli!;
    // Overridden profile:
    expect(svc.protocol?.safety?.full_auto).toEqual(["--yolo"]);
    // Untouched profiles still present from the preset:
    expect(svc.protocol?.safety?.read_only).toEqual(["--sandbox", "read-only"]);
    expect(svc.protocol?.safety?.workspace_edit).toEqual(["--sandbox", "workspace-write"]);
  });

  it("skips protocol.extends with an unrecognized preset name, with a warning", async () => {
    const yamlText = `
clis:
  - name: my_cli
    harness: generic
    command: my-cli
    protocol:
      extends: not_a_real_preset
      model: { flag: "--model" }
`;
    const p = await writeTmpYaml("clis-generic-extends-bad.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.my_cli).toBeUndefined();
    expect(cfg.configWarnings!.join("\n")).toContain("not_a_real_preset");
  });

  it("a built-in route's overrides.protocol accepts a preset name too", async () => {
    const yamlText = `
overrides:
  claude_code_cli:
    protocol: codex
`;
    const p = await writeTmpYaml("overrides-preset.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: onlyClaudeFound });
    const svc = cfg.services.claude_code_cli!;
    // Structurally identical to the codex preset now, despite being the
    // claude_code_cli route — proof presets aren't tied to route identity.
    expect(svc.protocol?.stdin).toBe(true);
    expect(svc.protocol?.args?.[0]).toBe("exec");
  });
});

describe("loadConfig — safety enums that fail open", () => {
  // The two typo cases the suite never covered, and the two that matter:
  // unlike a typo'd placeholder or preset name (both already warned), an
  // unrecognised safety_profile or workspace_policy silently resolves to a
  // LESS restrictive default — write access, or a shared workspace where an
  // isolated copy was asked for.
  it("warns when safety_profile is misspelled instead of silently granting write access", async () => {
    const yamlText = `
clis:
  - name: typo_route
    harness: codex
    safety_profile: read_onlyy
`;
    const p = await writeTmpYaml("clis-typo-safety-profile.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = (cfg.configWarnings ?? []).join(NL);
    expect(warningText).toContain("safety_profile");
    expect(warningText).toContain("read_onlyy");
    // The value really was dropped, so the warning is not cosmetic.
    expect(cfg.services["typo_route"]?.safetyProfile).toBeUndefined();
  });

  it("warns when workspace_policy is misspelled instead of silently sharing the workspace", async () => {
    const yamlText = `
clis:
  - name: typo_ws
    harness: codex
    workspace_policy: coppy
`;
    const p = await writeTmpYaml("clis-typo-workspace-policy.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = (cfg.configWarnings ?? []).join(NL);
    expect(warningText).toContain("workspace_policy");
    expect(warningText).toContain("coppy");
  });

  it("stays quiet for valid values", async () => {
    const yamlText = `
clis:
  - name: fine
    harness: codex
    safety_profile: read_only
    workspace_policy: copy
`;
    const p = await writeTmpYaml("clis-valid-enums.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    const warningText = (cfg.configWarnings ?? []).join(NL);
    expect(warningText).not.toContain("safety_profile");
    expect(warningText).not.toContain("workspace_policy");
  });
});

describe("watchConfig", () => {
  let watchers: Array<{ stop(): void }> = [];

  beforeEach(() => {
    watchers = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    for (const w of watchers) w.stop();
  });

  it("calls onChange when the file's mtime changes", async () => {
    const p = await writeTmpYaml("watch.yaml", "disabled: []\n");
    const events: Array<{ time: number }> = [];
    const w = watchConfig(
      p,
      () => {
        events.push({ time: Date.now() });
      },
      { intervalMs: 50, whichFn: noCliFound },
    );
    watchers.push(w);

    // Wait for initial baseline poll to register current mtime.
    await new Promise((r) => setTimeout(r, 120));

    // Force a visibly newer mtime (some filesystems have 1-second resolution).
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, "disabled: [cursor]\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);

    // Give the poller a couple of ticks to notice.
    await new Promise((r) => setTimeout(r, 250));

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("stops polling after stop() is called", async () => {
    const p = await writeTmpYaml("stop.yaml", "disabled: []\n");
    let calls = 0;
    const w = watchConfig(
      p,
      () => {
        calls += 1;
      },
      { intervalMs: 30, whichFn: noCliFound },
    );
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    const callsAfterStop = calls;
    // Modify the file — the stopped watcher should not notice.
    await new Promise((r) => setTimeout(r, 30));
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, "disabled: [cursor]\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(callsAfterStop);
  });
});
