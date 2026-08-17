#!/usr/bin/env node
/**
 * MCP launcher for the harness-dispatch plugin.
 *
 * Plugin installs are cached copies, so this launcher (not a hardcoded path
 * in .mcp.json) decides what actually runs, in priority order:
 *
 *   1. ../../dist/bin.js relative to this script — present when the plugin
 *      directory is inside a built harness-dispatch working copy rather than a
 *      plugin cache (i.e. developers running from the repo).
 *   2. `npx -y harness-dispatch` — the published npm package.
 *
 * Config resolution (passed as --config):
 *   1. HARNESS_DISPATCH_CONFIG — absolute path to a config.yaml.
 *   2. ~/.harness-dispatch/config.yaml — conventional user config location.
 *   3. none — the server auto-detects installed CLIs with built-in defaults.
 *
 * API keys for endpoint routes (GROQ_API_KEY, GEMINI_API_KEY, ...) are read
 * from the inherited environment by config.yaml's ${VAR} interpolation; the
 * launcher does not handle them.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveBin() {
  const repoBin = path.resolve(here, "..", "..", "dist", "bin.js");
  if (existsSync(repoBin)) {
    return { command: process.execPath, args: [repoBin] };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command: npx, args: ["-y", "harness-dispatch"] };
}

function resolveConfigArgs() {
  const fromEnv = process.env.HARNESS_DISPATCH_CONFIG;
  if (fromEnv && existsSync(fromEnv)) return ["--config", fromEnv];
  const userConfig = path.join(homedir(), ".harness-dispatch", "config.yaml");
  if (existsSync(userConfig)) return ["--config", userConfig];
  return [];
}

/**
 * Quote one argument for cmd.exe.
 *
 * Only used on the Windows shell path below. Wrapping in double quotes is
 * enough here because a Windows path cannot itself contain `"` — it is an
 * illegal filename character — so there is no quote to escape out of.
 */
function quoteForCmd(arg) {
  return /[\s&|<>^()"]/.test(arg) ? `"${arg}"` : arg;
}

const bin = resolveBin();
const argv = [...bin.args, "mcp", ...resolveConfigArgs()];
const needsShell = process.platform === "win32" && bin.command.endsWith(".cmd");

// npx.cmd on Windows needs shell resolution, but `shell: true` PLUS an args
// array is deprecated (DEP0190) and, worse, silently mis-splits: a --config
// path containing a space arrived as two arguments, so any Windows user whose
// home directory has a space in it could not pass a config through the plugin
// launcher at all. With a shell, Node wants one pre-quoted command string.
const child = needsShell
  ? spawn([bin.command, ...argv].map(quoteForCmd).join(" "), {
      stdio: "inherit",
      shell: true,
    })
  : spawn(bin.command, argv, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  process.stderr.write(`harness-dispatch plugin launcher failed: ${err.message}\n`);
  process.exit(1);
});
