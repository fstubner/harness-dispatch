/**
 * The suite must not be able to reach a real coding harness.
 *
 * This is the one side channel that costs MONEY rather than tidiness. The
 * log, state and jobs directories are sandboxed in setup-env.ts because tests
 * WRITE to them; config is sandboxed there because of what a test can
 * DISCOVER — the shipped defaults filtered by which harness CLIs are on PATH.
 * On a maintainer's machine that is claude_code_cli, codex_cli, cursor_cli and
 * antigravity_cli, on real subscriptions.
 *
 * It has happened: one boundary test dispatched to the real Claude Code on
 * every `npm test` and every CI run, measured at 6.4s and 47k input tokens,
 * under a comment asserting it could not reach a route.
 *
 * And the exposure is wider than the CLI fleet. Measured on this maintainer's
 * machine while writing these tests: with the guard removed, `resolveConfigPath()`
 * finds the repo's own `config.yaml` and a bare load yields `groq_api`,
 * `gemini_api`, `router9_api` and `local_inference` — the developer's REAL
 * config, carrying real API keys. A third test here checked the four harness
 * CLI names and was deleted for that reason: it passed under sabotage, because
 * the routes actually reachable were not CLIs at all. Asserting the route table
 * is EMPTY covers every kind of route, including the ones nobody thought to
 * list.
 *
 * These assertions are deterministic on every platform, which is the point.
 * "Does a bare config load find routes?" is not — on CI no harnesses are
 * installed, so it passes with or without the guard, and a test that cannot
 * fail where it runs is not evidence. Asserting the guard is IN PLACE fails
 * everywhere the moment it is removed.
 *
 * Verified independently on 2026-09-01 by shimming `claude`, `codex`,
 * `cursor-agent` and `agy` ahead of the real ones on PATH and recording every
 * outbound connection: across a full run, zero harness invocations and one
 * network request, to a deliberately unreachable hostname in a DNS-failure
 * test.
 */

import { describe, expect, it } from "vitest";

import { loadConfig, resolveConfigPath } from "../src/config.js";

describe("the test suite is isolated from real harnesses", () => {
  it("points config resolution at a sandbox, not the user's own", () => {
    const configured = process.env["HARNESS_DISPATCH_CONFIG"];
    expect(configured, "setup-env.ts must pin HARNESS_DISPATCH_CONFIG").toBeDefined();
    // resolveConfigPath is the function every entry point uses, so this pins
    // the rung of the precedence ladder rather than just the variable.
    expect(resolveConfigPath()).toBe(configured);
  });

  it("resolves to a config that declares no routes at all", async () => {
    const path = resolveConfigPath();
    expect(path).toBeDefined();
    const cfg = await loadConfig(path);
    expect(Object.keys(cfg.services)).toEqual([]);
  });

});
