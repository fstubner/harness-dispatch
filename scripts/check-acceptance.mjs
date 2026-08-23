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
 * WHAT IT DOES AND DOES NOT PROVE. It proves a file naming this version exists
 * and records a verdict. It does NOT prove a pass ran, that the pass was
 * thorough, or that the record describes the commit being tagged — the record
 * can be committed and further commits pushed before the tag. Four
 * `- key: value` lines satisfy it.
 *
 * That is deliberate: the checkable part is the ordering, and the ordering is
 * what failed. A CONDITIONAL verdict passes, because most of this project's
 * passes are CONDITIONAL and shipping on one is a real decision rather than a
 * rubber stamp. What this stops is publishing a version nobody reviewed at
 * all, which is the failure that actually happened, six times. Claiming more
 * than that would make this the same kind of reassuring-but-wrong signal it
 * exists to prevent.
 *
 * It is also not the only way to publish: `npm publish` run by hand bypasses
 * the workflow entirely, as 0.4.0 was.
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

/**
 * `- key: value` from the HEADER — the run of list lines before the first
 * blank-line-separated prose. Anchoring matters: an unanchored search takes
 * the first match anywhere, so a quoted template or an example block later in
 * the file would be parsed as the record itself.
 */
const header = body.split(/\r?\n\s*\r?\n/).find((block) => /^-\s*\w+:/m.test(block)) ?? "";
const field = (name) => {
  const m = new RegExp(`^-\\s*${name}:\\s*(.+)$`, "im").exec(header);
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
