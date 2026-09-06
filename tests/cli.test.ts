import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const startMcpServerMock = vi.fn();
vi.mock("../src/mcp/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp/server.js")>();
  return {
    ...actual,
    startMcpServer: (...args: unknown[]) => startMcpServerMock(...args),
  };
});

import { main } from "../src/bin.js";
import { QuotaCache } from "../src/quota.js";

async function writeConfig(opts: { includePaidRoute?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-cli-"));
  const file = path.join(dir, "config.yaml");
  const paidRoute = opts.includePaidRoute
    ? [
        "  paid:",
        "    enabled: true",
        "    type: openai_compatible",
        "    base_url: https://api.openai.com/v1",
        "    model: gpt-paid",
        "    provider: openai",
        "    surface: openai_api",
        "    auth_source: api_key",
        "    billing_kind: metered_api",
        "    paid_usage_possible: true",
        "    billing_confidence: documented",
        "    tier: 1",
        "    weight: 2",
        "    cli_capability: 1",
        "    capabilities:",
        "      execute: 1",
        "      plan: 1",
        "      review: 1",
        "",
      ]
    : [];
  await fs.writeFile(
    file,
    [
      "services:",
      "  local:",
      "    enabled: true",
      "    type: openai_compatible",
      "    base_url: http://127.0.0.1:1/v1",
      "    model: local-test",
      "    provider: local",
      "    surface: local_endpoint",
      "    auth_source: local_network",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    billing_confidence: documented",
      "    tier: 3",
      "    weight: 1",
      "    cli_capability: 1",
      "    capabilities:",
      "      execute: 1",
      "      plan: 1",
      "      review: 1",
      "",
      ...paidRoute,
    ].join("\n"),
    "utf-8",
  );
  return file;
}

async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("CLI parser", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("prints public help with the v0.4 commands", async () => {
    const result = await capture(() => main(["--help"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("harness-dispatch configure");
    expect(result.stdout).toContain("harness-dispatch doctor");
    expect(result.stdout).toContain("harness-dispatch doctor --live");
    expect(result.stdout).toContain("harness-dispatch status");
    expect(result.stdout).toContain("harness-dispatch serve");
    expect(result.stdout).toContain("harness-dispatch auth show");
    expect(result.stdout).not.toContain("list-services");
    expect(result.stdout).not.toContain("dashboard");
  });

  it.each([["--version"], ["-v"]])(
    "prints the version for %s, without loading config",
    async (flag) => {
      // `--version` exited 1 with "unknown option", which reads like the
      // binary is broken rather than like the flag is missing. The MCP
      // handshake has always carried the version, so an agent could see it; a
      // human diagnosing an install could not ask.
      //
      // No --config here on purpose: a version is what you ask for when
      // something is already wrong, so it must not depend on a loadable
      // config, a readable jobs root, or any route being reachable.
      const result = await capture(() => main([flag]));
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  it("reports UNREADABLE SAVED STATE, which is not a config problem", async () => {
    // doctor read `configWarnings` directly, so a corrupt breaker record or
    // usage counters that cannot reach disk were invisible to it - it printed
    // eleven green checks over state it could not read. `status` grew a "State
    // problems" heading and doctor did not follow; two acceptance passes
    // recorded that silence as open.
    //
    // The record is written for a route the config does NOT define, which is
    // what routes it to stateWarnings rather than onto a per-route line - the
    // corrupt-legacy-blob case, and any route since renamed.
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-doctor-state-"));
    const breakerDir = path.join(stateDir, "breaker_state");
    await fs.mkdir(breakerDir, { recursive: true });
    await fs.writeFile(path.join(breakerDir, "route_since_renamed.json"), "{ truncated", "utf8");
    const prev = process.env.HARNESS_DISPATCH_STATE_DIR;
    process.env.HARNESS_DISPATCH_STATE_DIR = stateDir;
    try {
      const config = await writeConfig();
      const result = await capture(() => main(["doctor", "--config", config, "--json"]));
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
      const check = report.checks.find((c) => c.name === "saved-state");
      expect(check, "doctor has no saved-state check").toBeDefined();
      // ok:false, not just a detail line — a check that reports the problem
      // while still passing is the same silence one level in.
      expect(check!.ok, "doctor reported unreadable state as fine").toBe(false);
      expect(check!.detail).toContain("route_since_renamed");
    } finally {
      if (prev === undefined) delete process.env.HARNESS_DISPATCH_STATE_DIR;
      else process.env.HARNESS_DISPATCH_STATE_DIR = prev;
      await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("reports git as its own doctor check rather than failing later at workspace diff", async () => {
    // Without git, a delegate's work COMPLETES in an isolated workspace and
    // then `workspace diff` dies with `spawn git ENOENT` — a message about a
    // program the user was never told they needed. Reported at setup instead.
    //
    // Not a hard requirement: dispatch works fine without it, and the response
    // carries workspaceRoot so the changes are recoverable by hand. So this
    // asserts the check EXISTS and explains itself, not that it passes.
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const result = await capture(() => main(["doctor", "--config", config]));
    expect(result.stdout).toMatch(/\bgit\b/);
    expect(result.stdout).toMatch(/workspace|worktree/i);
    // The property the first version of this test missed. It asserted the
    // check EXISTED and said nothing about the exit code — so the check
    // shipped setting ok:false, and `doctor` exited 1 on a machine with no
    // git, contradicting its own comment, the CHANGELOG and the README, all
    // three of which call git optional. An install script gating on this exit
    // code would have failed a working install.
    expect(result.code, "doctor failed overall on an otherwise healthy install").toBe(0);
  });

  it("keeps doctor's exit code at 0 when git is missing, because git is optional", async () => {
    // Same assertion with git genuinely absent — the case that was broken.
    // Mocked rather than PATH-stripped: removing PATH also breaks harness
    // detection and config-warnings, so the run fails for reasons that have
    // nothing to do with git and the test proves nothing.
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const whichAvailable = await import("../src/dispatchers/shared/which-available.js");
    vi.spyOn(whichAvailable, "commandAvailable").mockImplementation((cmd: string) =>
      cmd === "git" ? false : true,
    );
    const config = await writeConfig();
    const result = await capture(() => main(["doctor", "--config", config]));
    expect(result.stdout).toMatch(/NOT FOUND/);
    expect(result.stdout).toMatch(/optional/i);
    expect(result.code, "a machine without git is a supported configuration").toBe(0);
  });

  describe("--config at the boundary (twenty-fifth pass, finding 3)", () => {
    it("names the path when --config is a directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-config-dir-"));
      await expect(capture(() => main(["doctor", "--config", dir]))).rejects.toThrow(
        new RegExp(`${dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*is a directory`),
      );
    });

    it("refuses an empty --config value instead of silently auto-detecting", async () => {
      await expect(capture(() => main(["doctor", "--config", ""]))).rejects.toThrow(
        /--config needs a path/,
      );
    });

    it("does not credit an empty config file with the routes detection found", async () => {
      vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-config-empty-"));
      const empty = path.join(dir, "config.yaml");
      await fs.writeFile(empty, "", "utf8");
      const result = await capture(() => main(["doctor", "--config", empty, "--json"]));
      const config = (JSON.parse(result.stdout).checks as Array<{ name: string; detail: string }>).find(
        (c) => c.name === "config",
      );
      expect(config?.detail).toContain("auto-detected");
      expect(config?.detail).toContain("defines no routes of its own");
      expect(config?.detail).not.toMatch(/ from /);
    });

    it("names a harness on PATH that an authoritative config leaves out", async () => {
      // Finding 5: codex-only config, claude installed since, "1 ready
      // route(s)" and no hint.
      vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
      const whichAvailable = await import("../src/dispatchers/shared/which-available.js");
      vi.spyOn(whichAvailable, "commandAvailable").mockImplementation(
        (cmd: string) => cmd === "codex" || cmd === "claude",
      );
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-config-authoritative-"));
      const file = path.join(dir, "config.yaml");
      await fs.writeFile(file, ["clis:", "  - name: codex_cli", "    harness: codex", ""].join("\n"));
      const result = await capture(() => main(["doctor", "--config", file, "--json"]));
      const routes = (JSON.parse(result.stdout).checks as Array<{ name: string; detail: string }>).find(
        (c) => c.name === "routes",
      );
      expect(routes?.detail).toContain("Installed but not in this config: claude");
      expect(routes?.detail).toContain("detect: true");
      expect(routes?.detail).not.toContain("codex —");
    });
  });

  describe("route-health", () => {
    // A route that has never succeeded keeps being selected and keeps failing:
    // the breaker forgets after its cooldown, so a genuinely dead endpoint
    // costs one doomed attempt on every dispatch it wins. Seen on the
    // maintainer's machine at 8 calls and 0 successes while being preferred
    // for review work.
    async function doctorWithCounts(calls: number, successes: number) {
      vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
      // The counts reach doctor through fullStatus(), which is what a real
      // run reads back off disk; stubbing there keeps the test on the same
      // path rather than reaching into the cache's internals.
      vi.spyOn(QuotaCache.prototype, "fullStatus").mockResolvedValue({
        local: {
          used: null,
          limit: null,
          remaining: null,
          resetAt: null,
          source: "unknown",
          localCallCount: calls,
          localSuccessCount: successes,
        },
      } as unknown as Awaited<ReturnType<QuotaCache["fullStatus"]>>);
      const config = await writeConfig();
      const result = await capture(() => main(["doctor", "--config", config, "--json"]));
      const checks = JSON.parse(result.stdout).checks as Array<{ name: string; detail: string; ok: boolean }>;
      return checks.find((c) => c.name === "route-health");
    }

    it("names a route that has failed every call it was given", async () => {
      const check = await doctorWithCounts(8, 0);
      expect(check?.detail).toMatch(/has never succeeded \(8 calls, 0 successes\)/);
      // Advisory: a dead route is worth saying, not worth failing an install
      // that is otherwise fine.
      expect(check?.ok, "a dead route failed the whole doctor run").toBe(true);
    });

    it("stays quiet while a route has too few calls to judge", async () => {
      const check = await doctorWithCounts(2, 0);
      expect(check?.detail).toMatch(/no ready route has failed every call/);
    });

    it("stays quiet for a route that has succeeded at least once", async () => {
      const check = await doctorWithCounts(20, 1);
      expect(check?.detail).toMatch(/no ready route has failed every call/);
    });
  });

  describe("harness-login", () => {
    // Seen on the cold-install walk: an installed, never-logged-in Codex
    // passed every doctor check and the first dispatch failed with a raw
    // OpenAI 401. commandAvailable is mocked so the route is "ready" on a
    // runner with no codex; the login answer is mocked because a real one
    // needs real credentials. harness-login.test.ts covers the real spawn.
    async function writeCodexConfig(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-codex-"));
      const file = path.join(dir, "config.yaml");
      await fs.writeFile(file, ["clis:", "  - name: codex_cli", "    harness: codex", ""].join("\n"));
      return file;
    }
    async function doctorWith(state: "logged_in" | "logged_out" | "unknown") {
      vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
      const whichAvailable = await import("../src/dispatchers/shared/which-available.js");
      vi.spyOn(whichAvailable, "commandAvailable").mockReturnValue(true);
      const login = await import("../src/dispatchers/shared/harness-login.js");
      const probe = vi.spyOn(login, "codexLoginState").mockResolvedValue(state);
      const config = await writeCodexConfig();
      const result = await capture(() => main(["doctor", "--config", config, "--json"]));
      const checks = JSON.parse(result.stdout).checks as Array<{
        name: string;
        ok: boolean;
        detail: string;
      }>;
      return { result, probe, check: checks.find((c) => c.name === "harness-login") };
    }

    it("fails, names the route, and says to run codex login when codex is logged out", async () => {
      const { result, probe, check } = await doctorWith("logged_out");
      expect(probe).toHaveBeenCalledWith("codex");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("codex_cli");
      expect(check?.detail).toContain("codex login");
      expect(result.code).toBe(1);
    });

    it("passes when codex says it is logged in", async () => {
      const { check } = await doctorWith("logged_in");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("logged in");
    });

    it("does not fail a working install when the CLI gives no usable answer", async () => {
      const { check } = await doctorWith("unknown");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toMatch(/could not determine/);
    });
  });

  it.each([
    ["--safety", "read_onlyy", /--safety: invalid value/],
    ["--task-type", "excute", /--task-type: invalid value/],
  ])("rejects a typo'd %s rather than dropping to a default", async (flag, value, message) => {
    // A dropped --safety would hand the delegate MORE access than asked for —
    // the same failure the MCP and HTTP surfaces were both hardened against,
    // which is why `hints` is strict on both. A new flag reaching a delegate
    // gets the same treatment.
    // main() THROWS UsageError; the entry point above it turns that into one
    // line and exit 1 (verified against the built binary). Asserting the throw
    // is asserting the same contract one layer in.
    const config = await writeConfig();
    await expect(
      capture(() => main(["dispatch", flag, value, "--config", config, "hi"])),
    ).rejects.toThrow(message);
  });

  it("names dispatch in help, with route still accepted as the older spelling", async () => {
    // The CLI called this `route` while the MCP tool called it `dispatch`, for
    // the same operation. `dispatch` is the name now; `route` keeps working
    // because it is what the last two years of muscle memory types.
    const help = await capture(() => main(["--help"]));
    expect(help.stdout).toContain("harness-dispatch dispatch");
    const config = await writeConfig();
    // No prompt: both spellings should reach the same usage error, not an
    // "unknown command". It THROWS now rather than returning 1 — the message
    // used to be written straight to stderr, which bypassed the one place
    // that knows whether --json was asked for, so `dispatch --json` reported
    // failure as a bare sentence.
    await expect(main(["route", "--config", config])).rejects.toThrow(/missing prompt/);
  });

  it("supports status --json", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const result = await capture(() => main(["status", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      routes: Array<Record<string, unknown> & { id: string }>;
      skippedRoutes: unknown[];
    };
    expect(parsed.name).toBe("harness-dispatch");
    expect(parsed.routes[0]!.id).toBe("local");
    expect(parsed.routes[0]).toHaveProperty("billing");
    expect(parsed.routes[0]).toHaveProperty("effectiveSafetyProfile");
    expect(parsed.routes[0]).not.toHaveProperty("kind");
    expect(Array.isArray(parsed.skippedRoutes)).toBe(true);
  });

  it("loads ./config.yaml by default when --config is omitted", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const dir = path.dirname(config);
    const originalCwd = process.cwd();
    // This test is ABOUT the config-path precedence ladder, and the suite-wide
    // isolation guard in setup-env.ts occupies the rung above the one under
    // test (HARNESS_DISPATCH_CONFIG beats ./config.yaml). So it has to own the
    // variable rather than inherit it — otherwise it asserts the guard's
    // behaviour instead of its own.
    const savedEnvConfig = process.env["HARNESS_DISPATCH_CONFIG"];
    delete process.env["HARNESS_DISPATCH_CONFIG"];
    process.chdir(dir);
    try {
      const result = await capture(() => main(["status", "--json"]));
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        routes: Array<{ id: string }>;
      };
      expect(parsed.routes[0]!.id).toBe("local");
    } finally {
      process.chdir(originalCwd);
      if (savedEnvConfig === undefined) delete process.env["HARNESS_DISPATCH_CONFIG"];
      else process.env["HARNESS_DISPATCH_CONFIG"] = savedEnvConfig;
    }
  });

  it("writes a bare configure --yes to the state directory, not the current one, and doctor names it", async () => {
    // Seen on the cold-install walk: run from `/`, configure wrote
    // `/config.yaml`, and doctor from any other directory could not see it.
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hd-configure-cwd-"));
    const stateParent = await fs.mkdtemp(path.join(os.tmpdir(), "hd-configure-state-"));
    const state = path.join(stateParent, "nested");
    const savedCwd = process.cwd();
    const savedState = process.env["HARNESS_DISPATCH_STATE_DIR"];
    const savedEnvConfig = process.env["HARNESS_DISPATCH_CONFIG"];
    process.chdir(cwd);
    process.env["HARNESS_DISPATCH_STATE_DIR"] = state;
    delete process.env["HARNESS_DISPATCH_CONFIG"];
    try {
      const written = await capture(() => main(["configure", "--yes", "--no-clients"]));
      expect(written.code).toBe(0);
      const expected = path.join(state, "config.yaml");
      expect(written.stdout).toContain(`Wrote ${expected}`);
      await expect(fs.stat(expected)).resolves.toBeDefined();
      await expect(fs.stat(path.join(cwd, "config.yaml"))).rejects.toThrow();

      // A different directory, no --config: doctor finds it and says which.
      process.chdir(stateParent);
      const doctored = await capture(() => main(["doctor", "--json"]));
      const checks = JSON.parse(doctored.stdout).checks as Array<{ name: string; detail: string }>;
      expect(checks.find((c) => c.name === "config")?.detail).toContain(expected);
    } finally {
      process.chdir(savedCwd);
      if (savedState === undefined) delete process.env["HARNESS_DISPATCH_STATE_DIR"];
      else process.env["HARNESS_DISPATCH_STATE_DIR"] = savedState;
      if (savedEnvConfig === undefined) delete process.env["HARNESS_DISPATCH_CONFIG"];
      else process.env["HARNESS_DISPATCH_CONFIG"] = savedEnvConfig;
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(stateParent, { recursive: true, force: true });
    }
  });

  it("still refuses to overwrite an existing ./config.yaml on bare configure --yes", async () => {
    const config = await writeConfig();
    const dir = path.dirname(config);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await capture(() => main(["configure", "--yes"]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("already exists");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("surfaces configWarnings for an unrecognized overrides: key in doctor and configure", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-cli-warn-"));
    const configPath = path.join(dir, "config.yaml");
    // Shorthand auto-detect format with a pre-rename override key — nothing
    // is auto-detected on a bare test machine, but the warning fires purely
    // from parsing overrides:, independent of which()/route detection.
    await fs.writeFile(configPath, "overrides:\n  cursor:\n    weight: 5\n", "utf-8");

    const doctorResult = await capture(() =>
      main(["doctor", "--json", "--config", configPath]),
    );
    // doctor correctly reports failure (exit 1) when config has an
    // unrecognized entry — that's a real misconfiguration, not something to
    // silently pass like the intentional billing/safety skip checks.
    expect(doctorResult.code).toBe(1);
    const doctorParsed = JSON.parse(doctorResult.stdout) as {
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    const warningCheck = doctorParsed.checks.find((c) => c.name === "config-warnings");
    expect(warningCheck?.ok).toBe(false);
    expect(warningCheck?.detail).toContain("overrides.cursor");

    const configureResult = await capture(() =>
      main(["configure", "--config", configPath]),
    );
    expect(configureResult.code).toBe(0);
    expect(configureResult.stdout).toContain("Ignored config entries");
    expect(configureResult.stdout).toContain("overrides.cursor");
  });

  it("maps hidden dashboard and list-services aliases to status", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const dashboard = await capture(() => main(["dashboard", "--config", config]));
    expect(dashboard.code).toBe(0);
    expect(dashboard.stdout).toContain("harness-dispatch status");

    const list = await capture(() => main(["list-services", "--config", config]));
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.stdout) as { routes: Array<{ id: string }> };
    expect(parsed.routes[0]!.id).toBe("local");
  });

  it("supports configure --print without writing config", async () => {
    const config = await writeConfig();
    const result = await capture(() => main(["configure", "--print", "--config", config]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("endpoints:");
    expect(result.stdout).toContain("name: local");
    expect(result.stdout).not.toContain("version: 4");
    expect(result.stdout).not.toContain("services:");
  });

  it("does not write a misleading safety_profile for a route whose real effective_safety is a stricter floor", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-cli-safety-"));
    const configPath = path.join(dir, "config.yaml");
    // harness: cursor pulls effective_safety: full_auto from the shipped
    // harness defaults (config.default.yaml) without this entry declaring it
    // itself — exactly the auto-detected-route shape configure normally sees.
    await fs.writeFile(
      configPath,
      "services:\n  my_cursor:\n    enabled: true\n    type: cli\n    harness: cursor\n    command: cursor-agent\n",
      "utf-8",
    );

    const result = await capture(() => main(["configure", "--print", "--config", configPath]));
    expect(result.code).toBe(0);
    // The route's real capability floor must be written faithfully. For cursor
    // that is now a PER-REQUEST map, because --mode plan is genuinely
    // read-only while default print mode has write and shell — one value
    // cannot express both, and flattening it to a string here would either
    // overstate the floor for read-only work or understate it for the rest.
    expect(result.stdout).toContain("effective_safety:");
    expect(result.stdout).toContain("read_only: read_only");
    expect(result.stdout).toContain("workspace_edit: full_auto");
    // ...and must NOT also claim safety_profile: workspace_edit, which used
    // to be baked in as a fallback default even though nobody chose it and
    // it contradicts the effective_safety `status` actually enforces.
    expect(result.stdout).not.toContain("safety_profile:");
  });

  it("writes a modern config whose MCP snippet uses an absolute --config path, and round-trips through loadConfig", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const source = await writeConfig();
    const printed = await capture(() => main(["configure", "--print", "--config", source]));
    expect(printed.code).toBe(0);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-cli-out-"));
    const target = path.join(dir, "out.yaml");
    await fs.writeFile(target, printed.stdout, "utf-8");

    const written = await fs.readFile(target, "utf-8");
    expect(written).not.toContain("version: 4");
    expect(written).not.toMatch(/^services:/m);

    const { loadConfig } = await import("../src/config.js");
    const reloaded = await loadConfig(target);
    expect(Object.keys(reloaded.services)).toContain("local");

    // Now exercise the real --yes write path against a not-yet-existing
    // target and check the printed MCP snippet points at it absolutely.
    //
    // `target` was written above, so it EXISTS — this used to be run against
    // it and passed only because the overwrite guard was skipped whenever
    // --config was supplied. That was the bug; a genuinely fresh path is what
    // the comment always claimed to be testing.
    //
    // `--no-clients` pins the paste path deliberately. Without it this
    // assertion passed or failed on whether the MACHINE running the suite
    // happens to have Claude Code or Cursor installed: with one, the absolute
    // path appears in `connect`'s plan output and the test passes for a reason
    // it does not state; with none — every CI runner — it appeared nowhere and
    // the test failed. Machine-dependent tests are worse than absent ones.
    const freshTarget = path.join(dir, "fresh-config.yaml");
    const writeResult = await capture(() =>
      main(["configure", "--yes", "--no-clients", "--config", freshTarget]),
    );
    expect(writeResult.code).toBe(0);
    expect(writeResult.stdout).toContain(`Wrote ${freshTarget}`);
    expect(writeResult.stdout).toContain(JSON.stringify(path.resolve(freshTarget)));

    // And whatever this machine has, setup ends with something actionable:
    // either a registration plan, or the snippet to paste. Neither branch may
    // leave the user with a written config and no way to connect it.
    const handoffTarget = path.join(dir, "handoff-config.yaml");
    const handoff = await capture(() =>
      main(["configure", "--yes", "--config", handoffTarget]),
    );
    expect(handoff.code).toBe(0);
    expect(handoff.stdout).toMatch(/Registering with clients:|No MCP clients found/);
    expect(handoff.stdout).toContain(JSON.stringify(path.resolve(handoffTarget)));

    // And an existing file is now refused rather than destroyed.
    const clobber = await capture(() => main(["configure", "--yes", "--config", target]));
    expect(clobber.code).toBe(1);
    expect(clobber.stderr).toContain("already exists");
    expect(await fs.readFile(target, "utf-8")).toBe(written);

    // --force is the deliberate opt-in.
    const forced = await capture(() =>
      main(["configure", "--yes", "--force", "--config", target]),
    );
    expect(forced.code).toBe(0);
  });

  it("configure never emits a resolved api_key — ${VAR} round-trips, a literal is redacted", async () => {
    // configToYaml emitted svc.apiKey, which config.ts has already resolved
    // from ${VAR} at load time. `configure --print` is documented as the safe
    // preview and is what someone pastes into a bug report, so this wrote
    // live credentials to stdout and, via --yes, to disk.
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-secret-"));
    const source = path.join(dir, "config.yaml");
    await fs.writeFile(
      source,
      [
        "endpoints:",
        "  - name: from_env",
        "    base_url: https://api.example.com/v1",
        "    api_key: ${SENTINEL_CFG_KEY}",
        "    model: m",
        "  - name: from_literal",
        "    base_url: https://api.example.com/v1",
        "    api_key: sk-literal-must-not-leak",
        "    model: m",
        "",
      ].join("\n"),
      "utf-8",
    );

    process.env.SENTINEL_CFG_KEY = "resolved-secret-must-not-leak";
    try {
      const printed = await capture(() => main(["configure", "--print", "--config", source]));
      expect(printed.code).toBe(0);

      expect(printed.stdout).not.toContain("resolved-secret-must-not-leak");
      expect(printed.stdout).not.toContain("sk-literal-must-not-leak");

      // The reference survives verbatim, so the preview still reloads to the
      // same effective config for anyone with the variable set.
      expect(printed.stdout).toContain("${SENTINEL_CFG_KEY}");
      // A literal has no reference to restore; it becomes a placeholder, and
      // that substitution is announced rather than silent.
      expect(printed.stdout).toContain("${YOUR_API_KEY_ENV_VAR}");
      expect(printed.stderr).toMatch(/literals in the source config/);
    } finally {
      delete process.env.SENTINEL_CFG_KEY;
    }
  });

  it("supports doctor --json without running a live probe", async () => {
    process.env.HARNESS_DISPATCH_HTTP_TOKEN = "test-token";
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig();
    const result = await capture(() => main(["doctor", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; detail: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "live-probe")?.detail).toContain(
      "skipped",
    );
  });

  it("reports paid blockers without failing doctor when a safe route is ready", async () => {
    vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
    const config = await writeConfig({ includePaidRoute: true });
    const result = await capture(() => main(["doctor", "--json", "--config", config]));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      status: { skippedRoutes: Array<{ route: string; code: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "billing-policy")?.ok).toBe(true);
    expect(parsed.status.skippedRoutes).toEqual([
      expect.objectContaining({ route: "paid", code: "paid_blocked" }),
    ]);
  });

  it("supports auth show through the environment token", async () => {
    process.env.HARNESS_DISPATCH_HTTP_TOKEN = "test-token";
    const result = await capture(() => main(["auth", "show"]));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("test-token");
  });

  it("forwards --config through the mcp command instead of dropping it", async () => {
    // main() blocks forever on the stdio MCP lifetime promise (shutdown only
    // happens via process.exit on a real signal) — don't await it to
    // completion; just let it run far enough to call startMcpServer, assert,
    // then remove the signal handlers it installed so they don't leak.
    startMcpServerMock.mockReset();
    const registered: Array<[string | symbol, (...args: unknown[]) => void]> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
        registered.push([event, listener]);
        return process;
      });
    startMcpServerMock.mockResolvedValue({ close: vi.fn(async () => undefined) });

    void main(["mcp", "--config", "some/config.yaml"]);
    // initObservability() does a real dynamic import on first use (not just a
    // microtask), so poll with real timer ticks instead of flushing
    // microtasks, up to a generous bound.
    const deadline = Date.now() + 5000;
    while (startMcpServerMock.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(startMcpServerMock).toHaveBeenCalledWith({ configPath: "some/config.yaml" });
    for (const [event, listener] of registered) process.off(event, listener);
    onSpy.mockRestore();
  });
});
