#!/usr/bin/env node
/**
 * Print one version's CHANGELOG section as GitHub release notes.
 *
 * WHY NOT THE SECTION AS-IS. CHANGELOG.md is hard-wrapped at 80 columns, and a
 * markdown FILE treats a single newline as a space. A GitHub release body does
 * not: it renders every newline as a line break, so the notes came out broken
 * mid-sentence, line after line (v0.11.0 and the v0.12.0 draft). So each
 * paragraph and list item is joined back onto one line here. Blank lines, list
 * markers, headings, tables and fenced code keep their own lines.
 *
 * Usage: node scripts/release-notes.mjs <version>   (e.g. 0.12.0)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8").split(/\r?\n/);

const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
if (end === -1) end = lines.length;

/** A line that must start a new line in the output rather than continue the last. */
const startsBlock = (line) =>
  line.trim() === "" ||
  /^\s*([-*+]|\d+\.)\s/.test(line) ||
  /^\s*(#|\||>|```)/.test(line);

const out = [];
let inFence = false;
for (const line of lines.slice(start + 1, end)) {
  if (/^\s*```/.test(line)) {
    inFence = !inFence;
    out.push(line);
    continue;
  }
  const prev = out.length > 0 ? out[out.length - 1] : "";
  if (inFence || startsBlock(line) || prev.trim() === "" || /^\s*(#|\||```)/.test(prev)) {
    out.push(line);
  } else {
    out[out.length - 1] = `${prev} ${line.trim()}`;
  }
}

process.stdout.write(`${out.join("\n").trim()}\n`);
