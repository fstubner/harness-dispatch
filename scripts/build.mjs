// Build dist/ without ever leaving it missing.
//
// `rm -rf dist && tsc` left a window with no dist/ at all, and the stdio MCP
// server for a checkout runs from dist/bin.js while detached job runners are
// spawned from dist/job-runner.js: a build (or `npm test`) in another session
// made both fail to find their file. This compiles into dist.tmp/ first and
// swaps it in with two renames, so dist/ is whole before and after.
//
//   node scripts/build.mjs               always build
//   node scripts/build.mjs --if-stale    build only if dist/ is missing or
//                                        older than src/ (used by the test run)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const tmp = path.join(root, "dist.tmp");
const old = path.join(root, "dist.old");

/** Every file under `dir` whose name passes `keep`, with its mtime. */
function mtimes(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mtimes(full, keep));
    else if (keep(entry.name)) out.push(statSync(full).mtimeMs);
  }
  return out;
}

function isStale() {
  if (!existsSync(path.join(dist, "bin.js"))) return true;
  const sources = [...mtimes(path.join(root, "src"), (n) => n.endsWith(".ts")), statSync(path.join(root, "tsconfig.json")).mtimeMs];
  const built = mtimes(dist, (n) => n.endsWith(".js"));
  return Math.max(...sources) > Math.min(...built);
}

if (process.argv.includes("--if-stale") && !isStale()) process.exit(0);

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
rmSync(tmp, { recursive: true, force: true });
try {
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", tmp], { cwd: root, stdio: "inherit" });
} catch {
  rmSync(tmp, { recursive: true, force: true });
  console.error("build failed; dist/ is untouched");
  process.exit(1);
}

// Swap. If the first rename fails (something holds dist/ open, e.g. a shell
// whose cwd is inside it) nothing has changed; if the second does, put the old
// one back.
rmSync(old, { recursive: true, force: true });
if (existsSync(dist)) renameSync(dist, old);
try {
  renameSync(tmp, dist);
} catch (err) {
  if (existsSync(old)) renameSync(old, dist);
  throw err;
}
rmSync(old, { recursive: true, force: true });
