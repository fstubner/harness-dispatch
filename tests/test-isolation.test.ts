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

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { authDir } from "../src/auth.js";
import { loadConfig, resolveConfigPath } from "../src/config.js";
import { logDir } from "../src/dispatch-log.js";
import { jobsRoot } from "../src/jobs/store.js";
import { stateRoot } from "../src/state-dir.js";
import { workspacesBase } from "../src/workspaces.js";
import { ISOLATED_DIR_VARS } from "./global-setup.js";

/**
 * The user's real home, from the OS account record rather than HOME or
 * USERPROFILE — the variables the run redirects, and so the ones that cannot
 * be trusted to name it.
 */
const realHome = os.userInfo().homedir;
const realState = path.join(realHome, ".harness-dispatch");

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

describe("the test run cannot write to the user's real state", () => {
  it("redirects the home directory for the whole run", () => {
    expect(os.homedir(), "global-setup.ts must point HOME/USERPROFILE at a scratch home").not.toBe(
      realHome,
    );
  });

  it("sets every directory variable the product reads", () => {
    for (const name of Object.keys(ISOLATED_DIR_VARS)) {
      expect(process.env[name], `${name} is not set by global-setup.ts`).toBeTruthy();
    }
  });

  it("resolves every place the product writes to somewhere outside ~/.harness-dispatch", () => {
    const resolved = {
      stateRoot: stateRoot(),
      logDir: logDir(),
      jobsRoot: jobsRoot(),
      workspacesBase: workspacesBase(),
      authDir: authDir(),
    };
    for (const [what, dir] of Object.entries(resolved)) {
      expect(inside(dir, realState), `${what} resolves to ${dir}, inside the real state dir`).toBe(false);
    }
  });

  it("hands the same isolation to a process a test spawns with the inherited environment", () => {
    // What the detached runners, the stdio server tests and the CLI tests do.
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        "const os = require('node:os'); process.stdout.write(JSON.stringify({ home: os.homedir(), state: process.env.HARNESS_DISPATCH_STATE_DIR, ws: process.env.HARNESS_DISPATCH_WORKSPACES_DIR }))",
      ],
      { encoding: "utf8", env: { ...process.env } },
    );
    const child = JSON.parse(out) as { home: string; state?: string; ws?: string };
    expect(child.home).not.toBe(realHome);
    expect(child.state).toBeTruthy();
    expect(child.ws).toBeTruthy();
    expect(inside(child.state!, realState)).toBe(false);
  });
});

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
