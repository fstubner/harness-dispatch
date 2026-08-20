import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  BreakerStore,
  buildDispatchers,
  buildStatus,
  evaluateRoutePolicy,
  LeaderboardCache,
  loadConfig,
  QuotaCache,
  Router,
  VERSION,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_SAFETY = new Set(["workspace_edit", "full_auto"]);
const AGENT_HARNESSES = new Set([
  "claude_code",
  "codex",
  "cursor",
  "gemini_cli",
  "gemini",
  "antigravity_cli",
  "antigravity",
]);
const TASK_BRIEF_RELATIVE_PATH = path.join(".harness-dispatch", "agent-task.md");
const SMOKE_WORKSPACE_RELATIVE_ROOT = path.join(".harness-dispatch", "smoke-workspaces");

function parseArgs(argv) {
  const out = {
    allowPaid: false,
    allRoutes: false,
    config: undefined,
    keep: false,
    routes: [],
    safetyProfile: process.env.HARNESS_DISPATCH_AGENT_SMOKE_SAFETY ?? "workspace_edit",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-paid") out.allowPaid = true;
    else if (arg === "--all-routes") out.allRoutes = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--config") out.config = argv[++i];
    else if (arg === "--route") out.routes.push(argv[++i]);
    else if (arg === "--safety") out.safetyProfile = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!SUPPORTED_SAFETY.has(out.safetyProfile)) {
    throw new Error("--safety must be workspace_edit or full_auto");
  }
  return out;
}

function printUsage() {
  console.log(`harness-dispatch live agent smoke

Usage:
  HARNESS_DISPATCH_LIVE_AGENT_SMOKE=1 npm run smoke:agents -- [options]

Options:
  --config <path>       Config file to load.
  --allow-paid          Temporarily allow paid or unknown-paid routes for this run.
  --safety <profile>    workspace_edit or full_auto. Default: workspace_edit.
  --route <id>          Test one route. Repeat to test several route ids.
  --all-routes          Test every eligible route instead of one route per harness.
  --keep                Keep temp workspaces for inspection.

Environment:
  HARNESS_DISPATCH_AGENT_SMOKE_ROOT  Override the repo-local smoke workspace root.

PowerShell:
  $env:HARNESS_DISPATCH_LIVE_AGENT_SMOKE='1'; npm run smoke:agents -- --allow-paid
`);
}

function requireExplicitLiveOptIn() {
  if (process.env.HARNESS_DISPATCH_LIVE_AGENT_SMOKE === "1") return;
  console.error(
    [
      "Refusing to run live agent smoke without explicit opt-in.",
      "This command can consume provider quota or product-plan usage.",
      "Set HARNESS_DISPATCH_LIVE_AGENT_SMOKE=1 and rerun.",
    ].join("\n"),
  );
  process.exit(1);
}

export function smokeWorkspaceRoot(cwd = process.cwd()) {
  const override = process.env.HARNESS_DISPATCH_AGENT_SMOKE_ROOT;
  return path.resolve(override ?? path.join(cwd, SMOKE_WORKSPACE_RELATIVE_ROOT));
}

async function createFixture(route, root = smokeWorkspaceRoot()) {
  await mkdir(root, { recursive: true });
  const safeRoute = route.replace(/[^a-z0-9_-]/gi, "_");
  const dir = await mkdtemp(path.join(root, `${safeRoute}-`));
  const files = {
    "package.json": JSON.stringify(
      {
        type: "module",
        scripts: { test: "node test.mjs" },
      },
      null,
      2,
    ),
    "AGENTS.md": [
      "# Live Smoke Workspace",
      "",
      "These instructions apply only inside this generated harness-dispatch smoke workspace.",
      "They supersede parent project instructions for this workspace.",
      "",
      "- Do not use MCP tools to complete this smoke task.",
      "- Do not use harness-dispatch recursively.",
      "- Work only with the local files in this smoke workspace.",
      "- Follow `.harness-dispatch/agent-task.md`.",
      "",
    ].join("\n"),
    "calc.mjs": [
      "export function add(a, b) {",
      "  return a - b;",
      "}",
      "",
    ].join("\n"),
    "test.mjs": [
      "import assert from 'node:assert/strict';",
      "import { add } from './calc.mjs';",
      "",
      "assert.equal(add(2, 3), 5);",
      "assert.equal(add(-1, 1), 0);",
      "console.log('agent workflow smoke ok');",
      "",
    ].join("\n"),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return { dir, files };
}

function absoluteFixtureFiles(dir) {
  return ["AGENTS.md", "package.json", "calc.mjs", "test.mjs"].map((name) =>
    path.join(dir, name),
  );
}

export function buildTaskBrief(routeName, dir) {
  return [
    `# Harness Router Live Agent Smoke`,
    "",
    `Route: ${routeName}`,
    `Working directory: ${dir}`,
    "",
    "## Task",
    "Fix the failing Node.js test by editing `calc.mjs` only.",
    "",
    "## Constraints",
    "- Do not modify `test.mjs`.",
    "- Do not modify `package.json`.",
    "- Do not modify `AGENTS.md`.",
    "- Do not modify this task brief.",
    "- Do not run shell commands; harness-dispatch will run `node test.mjs` after your edit.",
    "",
    "## Acceptance",
    "- `node test.mjs` passes after the edit.",
    "- The implementation change is the smallest clear fix.",
    "- Return a concise summary of the edit.",
    "",
  ].join("\n");
}

async function writeTaskBrief(routeName, dir) {
  const briefPath = path.join(dir, TASK_BRIEF_RELATIVE_PATH);
  await mkdir(path.dirname(briefPath), { recursive: true });
  const content = buildTaskBrief(routeName, dir);
  await writeFile(briefPath, content, "utf8");
  return { path: briefPath, content };
}

export function buildShortTaskPrompt(briefPath) {
  return [
    "Read the harness-dispatch live smoke task brief and complete it.",
    `Task brief: ${briefPath}`,
  ].join("\n");
}

function harnessId(routeName, svc) {
  return svc.harness ?? routeName;
}

function routeLabel(routeName, svc) {
  const model = svc.model ?? svc.leaderboardModel ?? "model";
  return `${routeName} (${harnessId(routeName, svc)} / ${model})`;
}

function selectRoutes(config, dispatchers, router, opts) {
  const explicit = new Set(opts.routes.filter(Boolean));
  const selected = [];
  const skipped = [];
  const seenHarnesses = new Set();

  for (const [routeName, svc] of Object.entries(config.services)) {
    const dispatcher = dispatchers[routeName];
    const harness = harnessId(routeName, svc);

    if (explicit.size > 0 && !explicit.has(routeName)) continue;
    if (svc.type !== "cli" || !AGENT_HARNESSES.has(harness)) {
      skipped.push({ route: routeName, code: "not_agent_harness", message: "not a CLI agent harness" });
      continue;
    }
    if (!opts.allRoutes && explicit.size === 0 && seenHarnesses.has(harness)) {
      skipped.push({
        route: routeName,
        code: "deduped_harness",
        message: `already selected a ${harness} route`,
      });
      continue;
    }

    const breaker = router.getBreaker(routeName);
    const policy = evaluateRoutePolicy(routeName, svc, {
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      circuitBroken: Boolean(breaker?.isTripped),
      requestedSafetyProfile: opts.safetyProfile,
    });
    if (policy.blocked) {
      skipped.push(policy.skipped);
      continue;
    }

    selected.push(routeName);
    seenHarnesses.add(harness);
  }

  return { selected, skipped };
}

async function runFixtureTest(dir) {
  await execFileAsync(process.execPath, ["test.mjs"], {
    cwd: dir,
    timeout: 30_000,
    windowsHide: true,
  });
}

async function rmWithRetry(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null ? error.code : undefined;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
      await delay(100 * (attempt + 1));
    }
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning: could not remove smoke workspace ${dir}: ${message}`);
  }
}

async function runRoute(routeName, runtime, opts) {
  const svc = runtime.config.services[routeName];
  const fixture = await createFixture(routeName);
  const taskBrief = await writeTaskBrief(routeName, fixture.dir);
  const files = [...absoluteFixtureFiles(fixture.dir), taskBrief.path];
  const agentsBefore = await readFile(path.join(fixture.dir, "AGENTS.md"), "utf8");
  const testBefore = await readFile(path.join(fixture.dir, "test.mjs"), "utf8");
  const packageBefore = await readFile(path.join(fixture.dir, "package.json"), "utf8");
  const taskBriefBefore = await readFile(taskBrief.path, "utf8");
  let result;
  try {
    const prompt = buildShortTaskPrompt(taskBrief.path);

    result = await runtime.router.routeTo(
      routeName,
      prompt,
      files,
      fixture.dir,
      { safetyProfile: opts.safetyProfile },
    );
    if (!result.result.success) {
      throw new Error(
        `harness dispatch failed: ${result.result.error || result.result.output || "unknown error"}`,
      );
    }

    const testAfter = await readFile(path.join(fixture.dir, "test.mjs"), "utf8");
    if (testAfter !== testBefore) {
      throw new Error("harness modified test.mjs; expected only calc.mjs to change");
    }
    const packageAfter = await readFile(path.join(fixture.dir, "package.json"), "utf8");
    if (packageAfter !== packageBefore) {
      throw new Error("harness modified package.json; expected only calc.mjs to change");
    }
    const agentsAfter = await readFile(path.join(fixture.dir, "AGENTS.md"), "utf8");
    if (agentsAfter !== agentsBefore) {
      throw new Error("harness modified AGENTS.md; expected only calc.mjs to change");
    }
    const taskBriefAfter = await readFile(taskBrief.path, "utf8");
    if (taskBriefAfter !== taskBriefBefore) {
      throw new Error("harness modified the task brief; expected only calc.mjs to change");
    }

    await runFixtureTest(fixture.dir);
    return {
      ok: true,
      route: routeName,
      harness: harnessId(routeName, svc),
      workspace: fixture.dir,
      output: result.result.output,
    };
  } catch (error) {
    return {
      ok: false,
      route: routeName,
      harness: harnessId(routeName, svc),
      workspace: fixture.dir,
      output: result?.result?.output ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!opts.keep) {
      await rmWithRetry(fixture.dir);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  requireExplicitLiveOptIn();
  const config = await loadConfig(opts.config);
  if (opts.allowPaid) {
    for (const svc of Object.values(config.services)) {
      svc.allowPaidUsage = true;
      svc.allowPaidOverage = true;
    }
  }
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-smoke:" });
  const leaderboard = new LeaderboardCache();
  // Breaker state is isolated for the same reason the quota counters above
  // are, and it was NOT: Router defaults to a BreakerStore pointed at the
  // user's real state directory, so a smoke run wrote real cooldowns. Observed
  // 2026-08-20 — a codex quota limit hit during a smoke run left codex_cli
  // circuit-broken in the actual install. Accurate that time, but a smoke
  // failure for any unrelated reason would block a healthy route for real
  // dispatches, and a test harness must not do that to the thing it tests.
  const breakerDir = await mkdtemp(path.join(tmpdir(), "harness-dispatch-smoke-breaker-"));
  const router = new Router(config, quota, dispatchers, leaderboard, new BreakerStore(breakerDir));
  const runtime = { config, dispatchers, quota, leaderboard, router };

  const status = await buildStatus(config, dispatchers, quota, router, leaderboard);
  const { selected, skipped } = selectRoutes(config, dispatchers, router, opts);

  console.log(`harness-dispatch ${VERSION} live agent smoke`);
  console.log(`configured routes: ${Object.keys(config.services).length}`);
  console.log(`ready before live smoke: ${status.ready.join(", ") || "none"}`);
  if (skipped.length > 0) {
    console.log("skipped routes:");
    for (const skip of skipped) {
      if (skip) console.log(`  - ${skip.route}: ${skip.code} - ${skip.message}`);
    }
  }
  if (selected.length === 0) {
    throw new Error("No eligible CLI agent harness routes found for live smoke");
  }

  console.log("selected routes:");
  for (const route of selected) {
    console.log(`  - ${routeLabel(route, config.services[route])}`);
  }

  const results = [];
  for (const route of selected) {
    console.log(`\n[${route}] starting live workflow smoke`);
    const result = await runRoute(route, runtime, opts);
    results.push(result);
    if (result.ok) {
      console.log(`[${route}] ok`);
    } else {
      console.log(`[${route}] fail: ${result.error}`);
      if (result.output) console.log(result.output);
      if (opts.keep) console.log(`[${route}] workspace kept at ${result.workspace}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log("\nsummary:");
  for (const result of results) {
    console.log(
      `  ${result.ok ? "ok" : "fail"} ${result.route} (${result.harness})${
        opts.keep ? ` workspace=${result.workspace}` : ""
      }`,
    );
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} live agent workflow smoke test(s) failed`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
