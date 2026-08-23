#!/usr/bin/env node
/**
 * Refuse to publish a version no independent review has looked at.
 *
 * WHY THIS EXISTS. Every regression this project has shipped was caught by an
 * independent acceptance pass — 0.7.0's wrong apply base, 0.7.2's dropped
 * deletions, 0.7.3's path base, 0.7.6's two miscalibrated guards, 0.7.7's
 * under-counted escaping. Not one of them was missed. Every one of them was
 * already on npm when the pass ran, because publishing happened first.
 *
 * The review was never the problem; the ORDERING was. This makes the ordering
 * mechanical: `npm publish` cannot run for a version with no acceptance record
 * naming it.
 *
 * WHAT IT DOES AND DOES NOT PROVE. It proves a pass ran against this exact
 * version and someone wrote down what it concluded. It cannot judge whether
 * the pass was thorough, and a CONDITIONAL verdict deliberately passes — most
 * of this project's passes are CONDITIONAL and shipping on one is a real
 * decision, not a rubber stamp. What it stops is publishing a version nobody
 * reviewed at all, which is the failure that actually happened, six times.
 *
 * Usage: node scripts/check-acceptance.mjs [version]
 *   version defaults to the one in package.json.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`acceptance gate: ${message}\n`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = process.argv[2] ?? pkg.version;
const recordPath = path.join(repoRoot, "acceptance", `${version}.md`);

let body;
try {
  body = readFileSync(recordPath, "utf8");
} catch {
  fail(
    `no acceptance record for ${version}. Expected acceptance/${version}.md.\n` +
      `  Run an independent acceptance pass against this build first, then record\n` +
      `  its verdict there. See acceptance/README.md for the format.`,
  );
}

/** `- key: value` lines at the top of the record. */
const field = (name) => {
  const m = new RegExp(`^-\\s*${name}:\\s*(.+)$`, "im").exec(body);
  return m?.[1]?.trim();
};

const recordedVersion = field("version");
if (recordedVersion !== version) {
  fail(
    `acceptance/${version}.md records version "${recordedVersion ?? "(missing)"}", not ` +
      `"${version}". A record copied from a previous release proves nothing about this one.`,
  );
}

const verdict = (field("verdict") ?? "").toUpperCase();
if (!["SHIP", "CONDITIONAL", "BLOCK"].includes(verdict)) {
  fail(`acceptance/${version}.md has no usable verdict (found "${verdict || "(missing)"}").`);
}
if (verdict === "BLOCK") {
  fail(`acceptance/${version}.md records a BLOCK. Fix the findings and re-run the pass.`);
}

if (!field("date")) fail(`acceptance/${version}.md has no date.`);
if (!field("reviewer")) {
  fail(
    `acceptance/${version}.md has no reviewer line. Say who or what ran the pass and ` +
      `whether it was independent of the build.`,
  );
}

process.stdout.write(`acceptance gate: ${version} reviewed — ${verdict}\n`);
