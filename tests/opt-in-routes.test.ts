/**
 * Antigravity is opt-in. Google's terms for the service object to third-party
 * tools using it, so auto-detection finding `agy` must not make it routable;
 * an operator turns it on, in words, and an explicit `clis:` entry already is
 * that decision.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type WhichFn } from "../src/config.js";
import { configToYaml } from "../src/configure-yaml.js";
import { renderStatusText, type HarnessDispatchStatus, type RouteStatus } from "../src/status.js";

const allCliFound: WhichFn = async (cmd) => `/usr/bin/${cmd}`;
const onlyAgy: WhichFn = async (cmd) => (cmd === "agy" ? "/usr/bin/agy" : null);

async function writeTmpYaml(text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-optin-"));
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(p, text, "utf-8");
  return p;
}

describe("antigravity_cli is opt-in", () => {
  it("auto-detection adds it switched off, and says it is off by default", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyAgy });
    const svc = cfg.services.antigravity_cli!;
    expect(svc.enabled).toBe(false);
    expect(svc.offByDefault).toBe(true);
  });

  it("leaves the other detected harnesses on", async () => {
    const cfg = await loadConfig(undefined, { whichFn: allCliFound });
    expect(cfg.services.claude_code_cli!.enabled).toBe(true);
    expect(cfg.services.codex_cli!.enabled).toBe(true);
    expect(cfg.services.cursor_cli!.enabled).toBe(true);
    expect(cfg.services.antigravity_cli!.enabled).toBe(false);
  });

  it("overrides.antigravity_cli.enabled: true turns it on", async () => {
    const p = await writeTmpYaml("overrides:\n  antigravity_cli:\n    enabled: true\n");
    const cfg = await loadConfig(p, { whichFn: onlyAgy });
    expect(cfg.services.antigravity_cli!.enabled).toBe(true);
    expect(cfg.services.antigravity_cli!.offByDefault).toBeUndefined();
  });

  it("an explicit clis: entry for it is already the decision and stays on", async () => {
    const p = await writeTmpYaml("clis:\n  - name: agy_mine\n    harness: antigravity_cli\n");
    const cfg = await loadConfig(p, { whichFn: onlyAgy });
    expect(cfg.services.agy_mine!.enabled).toBe(true);
    expect(cfg.services.agy_mine!.offByDefault).toBeUndefined();
  });

  it("a legacy services: entry for it stays on", async () => {
    const p = await writeTmpYaml(
      "services:\n  agy_legacy:\n    type: cli\n    harness: antigravity_cli\n    command: agy\n",
    );
    const cfg = await loadConfig(p, { whichFn: onlyAgy });
    expect(cfg.services.agy_legacy!.enabled).toBe(true);
  });

  it("configure writes it as an entry with enabled: false, which keeps it off on reload", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyAgy });
    const text = configToYaml(cfg, { redactLiterals: true });
    expect(text).toContain("enabled: false");
    const reloaded = await loadConfig(await writeTmpYaml(text), { whichFn: onlyAgy });
    expect(reloaded.services.antigravity_cli!.enabled).toBe(false);
  });

  it("status explains why it is off and how to turn it on", () => {
    const route = {
      id: "antigravity_cli",
      harness: "antigravity_cli",
      enabled: false,
      available: true,
      type: "cli",
      tier: 1,
      weight: 1,
      cliCapability: 1,
      billing: {
        provider: "google",
        surface: "antigravity_cli",
        authSource: "product_login",
        kind: "free_quota",
        paidUsagePossible: false,
        allowPaidUsage: false,
        paidUsageRequiresOptIn: false,
        confidence: "documented",
      },
      safetyProfile: "workspace_edit",
      effectiveSafetyProfile: "full_auto",
      quota: { score: 1 },
      breaker: { tripped: false, failures: 0 },
      offByDefault: true,
    } as RouteStatus;
    const status: HarnessDispatchStatus = {
      name: "harness-dispatch",
      generatedAt: "2026-10-08T00:00:00.000Z",
      routes: [route],
      ready: [],
      skippedRoutes: [],
    };
    const text = renderStatusText(status);
    expect(text).toContain("off by default");
    expect(text).toContain("overrides: { antigravity_cli: { enabled: true } }");
  });
});
