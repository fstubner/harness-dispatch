#!/usr/bin/env node
/**
 * Prose that names a file or a config key has to be right about it.
 *
 * WHY THIS EXISTS. Comments, CHANGELOG entries and schema descriptions are
 * shipped artifacts — the schema descriptions literally more so than the code,
 * since an agent reads them to decide what to send. They are also the only
 * part of this repo nothing verifies. Five defects in one release were false
 * statements in prose:
 *
 *   - a schema description telling callers to pass `hints.service`, a key
 *     publicHintsSchema is .strict() against, so following the documentation
 *     earned an "unrecognized key" error
 *   - three site/ files citing a spec path as the authority for numbered rules
 *     they enforce, after that spec was deleted
 *
 * Both were free to catch and both shipped.
 *
 * WHAT IT DOES AND DOES NOT PROVE. Two rules, both mechanical:
 *
 *   1. A repo-relative path written in prose names a file that exists.
 *   2. A `hints.X` or `routing.X` written in prose names a real key.
 *
 * It does NOT check whether a claim is TRUE — only whether the things it names
 * exist. "the tail limit matches the rate-limit scanner's" was false and no
 * grep can tell; "rejected at the boundary", true on one surface and false on
 * the other, reads as fine here. Of the five prose defects above it catches
 * two. The other three, and every layer-mismatch defect, are out of reach.
 *
 * That gap is the point of saying so: this is the cheap third of the problem,
 * and claiming more would make it the same kind of reassuring-but-wrong signal
 * it exists to prevent.
 *
 * Usage: node scripts/check-claims.mjs
 *   Requires dist/ (npm run build) to read the live schema shape.
 *
 * (This file's own doc blocks name example keys and paths that do not exist,
 * so they carry the opt-out. It found itself the moment it was committed —
 * having passed locally only because the file was still untracked, so
 * `git ls-files` never handed it to itself. claims-check-ignore)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Only paths under a real top-level directory are checked. */
const REPO_DIRS = ["src", "tests", "scripts", "site", "plugin", "docs", "acceptance", "data"];

const SCANNED_EXTENSIONS = new Set([".ts", ".mjs", ".js", ".astro", ".css", ".md"]);

/**
 * A path-shaped token: <dir>/<something>.<ext>, optionally with a `:123` line
 * suffix. Anchored to the directory list so import specifiers (`./tools.js`),
 * package names (`@modelcontextprotocol/sdk`) and URLs never match — those
 * resolve differently or not against disk at all, and checking them here would
 * produce noise that gets the whole check switched off.
 */
const PATH_RE = new RegExp(`\\b(?:${REPO_DIRS.join("|")})/[A-Za-z0-9._/-]+\\.[A-Za-z0-9]+`, "g");

/** `hints.foo` / `routing.foo` as written in prose. claims-check-ignore */
const HINTS_RE = /\bhints\.([a-zA-Z][a-zA-Z0-9_]*)/g;
const ROUTING_RE = /\brouting\.([a-zA-Z][a-zA-Z0-9_]*)/g;

/**
 * Prose may opt out, for text that deliberately names something gone — a
 * provenance note about a ported file, a CHANGELOG entry about a removed key.
 * Deliberate history, not a stale reference.
 *
 * Scoped to the whole contiguous prose block, not the single line. A same-line
 * marker forces it into the middle of a sentence ("...utils.py, which
 * claims-check-ignore no longer exists"), so the tool would be damaging the
 * writing it exists to protect. The block is the unit a human reads anyway.
 */
const OPT_OUT = "claims-check-ignore";

/**
 * PROSE ONLY — comment lines in code, every line in markdown.
 *
 * The first version scanned whole lines and produced 235 findings, nearly all
 * false: `import { x } from "../src/auth.js"` matched the path rule (an ESM
 * specifier resolves to auth.ts, not auth.js), and a fixture string naming
 * `docs/sla.md` matched it too. A checker that cries wolf gets switched off,
 * which is worse than not having one — so the scan is narrowed to the thing
 * this is actually about: sentences a human wrote for another human to read.
 *
 * The exception is the user-facing files, where prose lives in STRING
 * LITERALS — `.describe()` on a zod field, SERVER_INSTRUCTIONS. Those strings
 * are the shipped documentation an agent reads to decide what to send, so they
 * are more load-bearing than any comment. Restricting the scan to comment
 * lines removed exactly the coverage this was built for: with the phantom
 * `hints.service` reintroduced inside a `.describe()`, the checker printed a
 * confident pass. Caught by sabotage, which is the only reason it is not still
 * doing that. claims-check-ignore
 */
function isProse(line, ext, userFacing) {
  if (ext === ".md") return true;
  if (userFacing) return true;
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

/**
 * User-facing text, where `hints.X` must name a key the PUBLIC schema accepts.
 *
 * Elsewhere — router internals, tests — prose may legitimately discuss
 * `hints.service`, a real RouteHints field that simply is not part of the
 * public surface. That distinction is exactly what shipped wrong: `service` is
 * real internally and was advertised externally, where it is refused.
 * claims-check-ignore
 */
// Files whose PROSE reaches a user or an agent, and is therefore scanned in
// full rather than comments-only.
//
// `src/mcp/tools.ts` was the gap. It holds every `registerTool({description})`
// string — the text an orchestrating agent actually reads before choosing what
// to send — and it was neither listed here nor covered by the comments-only
// rule, so those descriptions were invisible to both. An acceptance pass found
// the `usage` description telling agents that `service` and `models` are
// unvalidated when both throw, while this checker exited 0 over it. The same
// wrong sentence was corrected in the plugin skill in the very commit that
// left it standing here.
const USER_FACING = new Set([
  "src/mcp/tool-schemas.ts",
  "src/mcp/tools.ts",
  "src/mcp/server.ts",
  "README.md",
  "CHANGELOG.md",
  "OPERATIONS.md",
  "PRODUCT.md",
]);

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => SCANNED_EXTENSIONS.has(path.extname(f)));
}

/** Live keys of publicHintsSchema, read from the build rather than parsed. */
async function hintsKeys() {
  const distSchema = path.join(repoRoot, "dist", "mcp", "tool-schemas.js");
  if (!existsSync(distSchema)) {
    process.stderr.write("claims: dist/ is missing — run `npm run build` first.\n");
    process.exit(2);
  }
  const mod = await import(`file://${distSchema.replace(/\\/g, "/")}`);
  const shape = mod.publicHintsSchema?.shape;
  if (!shape) {
    process.stderr.write("claims: could not read publicHintsSchema.shape from dist.\n");
    process.exit(2);
  }
  return new Set(Object.keys(shape));
}

/** Every field RouteHints carries, public or not — parsed from the type. */
function internalHintKeys() {
  const source = readFileSync(path.join(repoRoot, "src", "types.ts"), "utf8");
  const block = /export interface RouteHints \{([\s\S]*?)\n\}/.exec(source);
  if (!block?.[1]) {
    process.stderr.write("claims: could not find RouteHints in src/types.ts.\n");
    process.exit(2);
  }
  const keys = new Set();
  for (const m of block[1].matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*)\??:/gm)) {
    if (m[1]) keys.add(m[1]);
  }
  return keys;
}

/**
 * Keys of RouteResponse["routing"], parsed from the interface. Not runtime
 * inspectable — it is a TypeScript type, erased before dist exists.
 */
function routingKeys() {
  const source = readFileSync(path.join(repoRoot, "src", "mcp", "tools.ts"), "utf8");
  const block = /routing\?:\s*\{([\s\S]*?)\n  \};/.exec(source);
  if (!block?.[1]) {
    process.stderr.write("claims: could not find the routing block in src/mcp/tools.ts.\n");
    process.exit(2);
  }
  const keys = new Set();
  for (const m of block[1].matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9_]*)\??:/gm)) {
    if (m[1]) keys.add(m[1]);
  }
  return keys;
}

const findings = [];

function record(file, lineNo, message) {
  findings.push({ file, lineNo, message });
}

const publicHints = await hintsKeys();
const allHints = internalHintKeys();
const validRouting = routingKeys();

for (const file of trackedFiles()) {
  const full = path.join(repoRoot, file);
  const ext = path.extname(file);
  const fileDir = path.dirname(full);
  const userFacing = USER_FACING.has(file.replace(/\\/g, "/"));
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);

  // Which contiguous prose runs carry the opt-out marker anywhere in them.
  const exempt = new Set();
  let blockStart = -1;
  let blockHasMarker = false;
  const closeBlock = (endExclusive) => {
    if (blockStart >= 0 && blockHasMarker) {
      for (let n = blockStart; n < endExclusive; n += 1) exempt.add(n);
    }
    blockStart = -1;
    blockHasMarker = false;
  };
  lines.forEach((line, i) => {
    if (isProse(line, ext, userFacing) && line.trim() !== "") {
      if (blockStart < 0) blockStart = i;
      if (line.includes(OPT_OUT)) blockHasMarker = true;
    } else {
      closeBlock(i);
    }
  });
  closeBlock(lines.length);

  lines.forEach((line, i) => {
    if (exempt.has(i)) return;
    if (!isProse(line, ext, userFacing)) return;
    const lineNo = i + 1;

    for (const match of line.matchAll(PATH_RE)) {
      const raw = match[0].replace(/[.,;:)]+$/, "");
      // Repo-root OR relative to the file that names it — plugin/README.md
      // names a sibling script, not a repo-root one. claims-check-ignore
      if (existsSync(path.join(repoRoot, raw)) || existsSync(path.join(fileDir, raw))) continue;
      record(file, lineNo, `names a path that does not exist: ${raw}`);
    }

    for (const match of line.matchAll(HINTS_RE)) {
      const key = match[1];
      if (!key) continue;
      const valid = userFacing ? publicHints : allHints;
      if (valid.has(key)) continue;
      record(
        file,
        lineNo,
        userFacing && allHints.has(key)
          ? `advertises hints.${key} to callers, but publicHintsSchema is .strict() ` +
            `and refuses it — it is internal-only`
          : `names hints.${key}, which is not a RouteHints field ` +
            `(valid: ${[...valid].sort().join(", ")})`,
      );
    }

    for (const match of line.matchAll(ROUTING_RE)) {
      const key = match[1];
      if (key && !validRouting.has(key)) {
        record(
          file,
          lineNo,
          `names routing.${key}, which the routing response does not carry ` +
            `(valid: ${[...validRouting].sort().join(", ")})`,
        );
      }
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(`claims: ${findings.length} prose claim(s) name something that is not there\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.lineNo}\n    ${f.message}\n`);
  }
  process.stderr.write(
    `\n  Fix the prose, or append \`${OPT_OUT}\` to the line if it deliberately\n` +
      `  names something removed (a CHANGELOG entry about a deleted key, say).\n`,
  );
  process.exit(1);
}

process.stdout.write("claims: every path and hint key named in prose exists\n");
