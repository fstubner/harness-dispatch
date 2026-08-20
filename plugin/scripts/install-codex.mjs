#!/usr/bin/env node
/**
 * Install harness-dispatch into Codex (CLI and desktop — both read ~/.codex).
 *
 *   node plugin/scripts/install-codex.mjs [--config <path>] [--dry-run]
 *
 * Does two things, both idempotent:
 *   1. Registers the MCP server: `codex mcp add harness-dispatch -- node
 *      <launcher>` (re-running replaces the existing entry). The launcher is
 *      this plugin's launch-mcp.mjs, so config resolution behaves identically
 *      to the Claude plugin (local repo build when run from a working copy,
 *      published package otherwise).
 *   2. Copies the delegating-work skill to ~/.codex/skills/harness-dispatch/
 *      (Codex uses the same SKILL.md format as Claude Code).
 *
 * --config, when given, is persisted into the `codex mcp add` env as
 * HARNESS_DISPATCH_CONFIG so the launcher picks it up without requiring a
 * global environment variable.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "launch-mcp.mjs");
const skillSource = path.resolve(here, "..", "skills", "delegating-work", "SKILL.md");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
function flagValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  // `--config --dry-run` used to persist the literal "--dry-run" as the config
  // path. Take a value only when it is one.
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} needs a value, e.g. ${flag} /path/to/config.yaml`);
    process.exit(1);
  }
  return value;
}
const rawConfigOverride = flagValue("--config");

/**
 * Resolved to an ABSOLUTE path and checked here, at install time.
 *
 * This value is persisted into Codex's MCP entry as HARNESS_DISPATCH_CONFIG
 * and read much later by launch-mcp.mjs, in a process whose working directory
 * is Codex's, not the one this installer ran in. A relative
 * `--config ./config.yaml` therefore resolved to nothing at launch and the
 * server quietly started on auto-detected defaults — none of the operator's
 * routes, safety floors or workspace policies in effect, no error anywhere.
 * Install time is also the only moment the person who typed the path is still
 * present to fix a typo.
 */
let configOverride;
if (rawConfigOverride !== undefined) {
  configOverride = path.resolve(rawConfigOverride);
  if (!existsSync(configOverride)) {
    console.error(`--config path does not exist: ${configOverride}`);
    process.exit(1);
  }
}

/** Quote one argument for cmd.exe, doubling any embedded quote. */
function quoteForCmd(arg) {
  const escaped = String(arg).replace(/"/g, '""');
  return /[\s&|<>^()"]/.test(String(arg)) ? `"${escaped}"` : escaped;
}

/** Exactly the string the win32 branch below executes, so --dry-run is honest. */
function windowsCommandLine(command, commandArgs) {
  return `${quoteForCmd(command)} ${commandArgs.map(quoteForCmd).join(" ")}`;
}

function run(command, commandArgs) {
  if (dryRun) {
    // Print what would ACTUALLY run. Previously this joined the raw args with
    // spaces while the real win32 path quoted them, so --dry-run showed a
    // different command than it would execute — which is precisely how a
    // quoting bug hides from the flag meant to reveal it.
    console.log(
      process.platform === "win32"
        ? `[dry-run] ${windowsCommandLine(command, commandArgs)}`
        : `[dry-run] ${command} ${commandArgs.join(" ")}`,
    );
    return { status: 0 };
  }
  if (process.platform === "win32") {
    // codex is a .cmd shim on Windows: needs shell resolution, and Node
    // deprecates args-array + shell:true, so quote into a single string.
    //
    // The metacharacter set below now includes " and (), which the previous
    // version omitted: an argument carrying an embedded quote closed the
    // quoting early and let a chained `&` command run — reproduced with
    // `--config 'x" & echo INJECTED & rem "'`. Embedded quotes are doubled,
    // cmd.exe's own escape, so the payload stays one argument. Reaching this
    // requires the user to pass themselves a hostile --config, so it is
    // hardening rather than a live hole, but it is the same class windows-cmd.ts
    // already fixed on the dispatch path and should not survive here.
    return spawnSync(windowsCommandLine(command, commandArgs), {
      stdio: "inherit",
      shell: true,
    });
  }
  return spawnSync(command, commandArgs, { stdio: "inherit" });
}

// 1. MCP server registration.
const envArgs = [];
if (configOverride) envArgs.push("--env", `HARNESS_DISPATCH_CONFIG=${configOverride}`);

// `codex mcp add` overwrites an existing entry of the same name, but remove
// first so stale env vars from a previous install can't survive.
run("codex", ["mcp", "remove", "harness-dispatch"]);
const added = run("codex", [
  "mcp",
  "add",
  "harness-dispatch",
  ...envArgs,
  "--",
  "node",
  launcher,
]);
if (added.status !== 0) {
  console.error("codex mcp add failed — is the Codex CLI installed and on PATH?");
  process.exit(1);
}

// 2. Skill installation (same SKILL.md works in both ecosystems).
const skillDir = path.join(homedir(), ".codex", "skills", "harness-dispatch");
if (!existsSync(skillSource)) {
  console.error(`skill source missing: ${skillSource}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`[dry-run] copy ${skillSource} -> ${path.join(skillDir, "SKILL.md")}`);
} else {
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(skillSource, path.join(skillDir, "SKILL.md"));
}

console.log("\nharness-dispatch installed for Codex:");
console.log("  - MCP server: codex mcp list   (look for harness-dispatch)");
console.log(`  - Skill:      ${path.join(skillDir, "SKILL.md")}`);
console.log("\nEndpoint API keys (GROQ_API_KEY, GEMINI_API_KEY, ...) must be present in");
console.log("the environment Codex runs in; CLI-based routes need no keys.");
