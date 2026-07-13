#!/usr/bin/env node
/**
 * Install harness-router into Codex (CLI and desktop — both read ~/.codex).
 *
 *   node plugin/scripts/install-codex.mjs [--config <path>] [--dry-run]
 *
 * Does two things, both idempotent:
 *   1. Registers the MCP server: `codex mcp add harness-router -- node
 *      <launcher>` (re-running replaces the existing entry). The launcher is
 *      this plugin's launch-mcp.mjs, so config resolution behaves identically
 *      to the Claude plugin (local repo build when run from a working copy,
 *      published package otherwise).
 *   2. Copies the delegating-work skill to ~/.codex/skills/harness-router/
 *      (Codex uses the same SKILL.md format as Claude Code).
 *
 * --config, when given, is persisted into the `codex mcp add` env as
 * HARNESS_ROUTER_CONFIG so the launcher picks it up without requiring a
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
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}
const configOverride = flagValue("--config");

function run(command, commandArgs) {
  if (dryRun) {
    console.log(`[dry-run] ${command} ${commandArgs.join(" ")}`);
    return { status: 0 };
  }
  if (process.platform === "win32") {
    // codex is a .cmd shim on Windows: needs shell resolution, and Node
    // deprecates args-array + shell:true, so quote into a single string.
    const quoted = commandArgs.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)).join(" ");
    return spawnSync(`${command} ${quoted}`, { stdio: "inherit", shell: true });
  }
  return spawnSync(command, commandArgs, { stdio: "inherit" });
}

// 1. MCP server registration.
const envArgs = [];
if (configOverride) envArgs.push("--env", `HARNESS_ROUTER_CONFIG=${configOverride}`);

// `codex mcp add` overwrites an existing entry of the same name, but remove
// first so stale env vars from a previous install can't survive.
run("codex", ["mcp", "remove", "harness-router"]);
const added = run("codex", [
  "mcp",
  "add",
  "harness-router",
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
const skillDir = path.join(homedir(), ".codex", "skills", "harness-router");
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

console.log("\nharness-router installed for Codex:");
console.log("  - MCP server: codex mcp list   (look for harness-router)");
console.log(`  - Skill:      ${path.join(skillDir, "SKILL.md")}`);
console.log("\nEndpoint API keys (GROQ_API_KEY, GEMINI_API_KEY, ...) must be present in");
console.log("the environment Codex runs in; CLI-based routes need no keys.");
