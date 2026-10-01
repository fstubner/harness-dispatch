#!/usr/bin/env node
// Pack the package, install the TARBALL into a throwaway prefix, and run what
// that install put on PATH: `--version`, `doctor`, and a stdio MCP handshake.
//
// `npm test` runs the checkout, and `npm pack --dry-run` only lists files. A
// wrong `files` entry, a missing runtime dependency or a broken bin shim passes
// both and surfaces on a user's machine. This runs the exact bytes that would
// be published, through the shim npm creates for each OS.
//
//   node scripts/verify-tarball.mjs [--out <dir>]
//
// The packed .tgz is left in <dir> (default: the scratch dir, removed on exit)
// so a publish job can ship the file that was verified.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const expected = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const outIdx = process.argv.indexOf("--out");
const scratch = mkdtempSync(path.join(tmpdir(), "hd-tarball-"));
const outDir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : scratch;
mkdirSync(outDir, { recursive: true });

// .cmd shims (npm itself, and the installed bin) need a shell on Windows. Every
// argument here is a fixed string or a path made of safe characters, quoted.
const q = (a) => (win ? `"${a}"` : a);
function run(cmd, args, opts = {}) {
  return win
    ? execFileSync([cmd, ...args.map(q)].join(" "), { shell: true, encoding: "utf8", ...opts })
    : execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function fail(message) {
  console.error(`verify-tarball: ${message}`);
  process.exitCode = 1;
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", outDir], { cwd: root, stdio: ["ignore", "pipe", "inherit"] }));
  const tarball = path.join(outDir, packed[0].filename);
  console.log(`packed ${tarball}`);

  // A project-local install in a scratch dir: npm links the bin the same way
  // as for `-g` (a symlink on POSIX, .cmd/.ps1 shims on Windows), without
  // needing a global prefix. The tarball is copied beside it so the install
  // only reads from its own working directory.
  const prefix = path.join(scratch, "prefix");
  mkdirSync(prefix);
  writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "verify-tarball", private: true }));
  copyFileSync(tarball, path.join(prefix, "pkg.tgz"));
  run("npm", ["install", "./pkg.tgz"], { cwd: prefix, stdio: ["ignore", "inherit", "inherit"] });

  const home = path.join(scratch, "home");
  const state = path.join(scratch, "state");
  mkdirSync(home);
  const config = path.join(scratch, "config.yaml");
  writeFileSync(
    config,
    [
      "clis:",
      "  - name: echo_node",
      "    harness: generic",
      "    command: node",
      "    billing_kind: local_compute",
      "    paid_usage_possible: false",
      "    protocol:",
      '      args: ["-e", "console.log(1)", "{{prompt}}"]',
      "      output: { mode: text }",
      "",
    ].join("\n"),
  );
  const binDir = path.join(prefix, "node_modules", ".bin");
  // Windows spells it `Path`; setting `PATH` beside it would leave two keys.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env = {
    ...process.env,
    [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    HARNESS_DISPATCH_STATE_DIR: state,
    HARNESS_DISPATCH_CONFIG: config,
  };

  const version = run("harness-dispatch", ["--version"], { env }).trim();
  if (version !== expected) fail(`--version printed "${version}", expected "${expected}"`);
  else console.log(`--version ok (${version})`);

  // doctor exits non-zero when a check fails, which throws here.
  run("harness-dispatch", ["doctor"], { env, stdio: ["ignore", "pipe", "inherit"] });
  console.log("doctor ok");

  await mcpHandshake(env);
  console.log("mcp initialize + tools/list ok");
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/** Spawn `harness-dispatch mcp`, initialize, list tools, then close stdin. */
async function mcpHandshake(env) {
  const child = win
    ? spawn(["harness-dispatch", "mcp"].join(" "), { shell: true, env, stdio: ["pipe", "pipe", "inherit"] })
    : spawn("harness-dispatch", ["mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
      } catch {
        // not a JSON-RPC line
      }
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 30 s`)), 30_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify-tarball", version: "0" },
    });
    if (init.result?.serverInfo?.name === undefined) throw new Error(`initialize returned ${JSON.stringify(init)}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await request(2, "tools/list", {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    if (!names.includes("dispatch")) throw new Error(`tools/list returned ${JSON.stringify(names)}`);
  } finally {
    child.stdin.end();
    const exited = await new Promise((resolve) => {
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    if (!exited) {
      if (win) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }
  }
}
