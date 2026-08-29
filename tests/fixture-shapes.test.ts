/**
 * Every hand-written id in the test suite must be one the product could
 * actually produce.
 *
 * This is the mechanical half of a failure that has now bitten four times.
 * Tests named things the generators cannot generate — `job-stale-0000000-…`,
 * run directories with four-character suffixes where a real one has eight hex,
 * a project root that matched a name guard by coincidence — and each then
 * asserted something about an input that never occurs. Two passed while the
 * bug they claimed to cover was live, which is worse than having no test: a
 * green row said the case was handled.
 *
 * Reviewing for this by eye does not work; it was missed four times by people
 * looking directly at the lines. So it is checked.
 *
 * The rule is deliberately narrow — a string that LOOKS like one of our ids
 * must BE one. Anything that looks like nothing in particular is left alone,
 * because inventing rules for arbitrary strings would fail honest tests.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JOB_ID_RE } from "../src/jobs/store.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Anything shaped like a job id, valid or not, ANYWHERE inside a string
 * literal — not only where the id starts right after the quote.
 *
 * The first version anchored to the quote, so `"/tmp/jobs/job-stale-0000000-…"`
 * slipped through, and writing a fixture path with the id embedded is an
 * entirely ordinary thing to do. An acceptance pass found the hole by trying
 * it. A guard that only catches the tidy spelling of a mistake is a guard you
 * have to remember, which is the thing this replaces.
 */
// At least two hyphen-separated segments after `job-`, so this matches an
// ATTEMPT at an id and not the ordinary words `job-runner` or `job-id`.
const JOB_ID_LIKE = /(job-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+)/g;

/**
 * Anything shaped like a workspace run directory: an ISO-ish timestamp start.
 * A real one is `<ISO stamp>-<pid>-<route>-<8 hex>`. Also unanchored.
 */
const RUN_DIR_LIKE = /(\d{4}-\d{2}-\d{2}T[\dZ:.-]+-[A-Za-z0-9_.-]+)/g;
const REAL_RUN_DIR = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-.+-[0-9a-f]{8}$/;

async function testSources(): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ rel: path.relative(TESTS_DIR, full), text: await fs.readFile(full, "utf8") });
      }
    }
  };
  await walk(TESTS_DIR);
  return out;
}

/** Lines opted out by name, with the reason required next to them. */
function isExempt(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  // A test that deliberately feeds an INVALID id — boundary validation has to
  // be allowed to use invalid input, which is the whole point of it.
  return /fixture-shapes-ok/.test(line) || /\/\/|\*/.test(line.trimStart().slice(0, 2));
}

describe("test fixtures use shapes the product can produce", () => {
  it("every job-id-shaped literal is a valid job id", async () => {
    const bad: string[] = [];
    for (const { rel, text } of await testSources()) {
      if (rel === "fixture-shapes.test.ts") continue;
      for (const m of text.matchAll(JOB_ID_LIKE)) {
        const id = m[1]!;
        if (JOB_ID_RE.test(id)) continue;
        if (isExempt(text, m.index)) continue;
        bad.push(`${rel}: ${id}`);
      }
    }
    expect(
      bad,
      "these look like job ids but newJobId() cannot produce them, so any test using " +
        "them is asserting about an input that never occurs. Build ids with " +
        "tests/support/fixtures.ts, or add `fixture-shapes-ok` on the line with a " +
        "reason if the invalid value IS the point (boundary validation).",
    ).toEqual([]);
  });

  it("every run-directory-shaped literal is a valid run directory", async () => {
    const bad: string[] = [];
    for (const { rel, text } of await testSources()) {
      if (rel === "fixture-shapes.test.ts") continue;
      for (const m of text.matchAll(RUN_DIR_LIKE)) {
        const name = m[1]!;
        if (REAL_RUN_DIR.test(name)) continue;
        if (isExempt(text, m.index)) continue;
        bad.push(`${rel}: ${name}`);
      }
    }
    expect(
      bad,
      "these look like workspace run directories but workspaceRunId() cannot produce " +
        "them — a real one ends in 8 hex characters. Reclamation will not recognise " +
        "them, so a test about reclamation is measuring something else. Use " +
        "aRunDirName() from tests/support/fixtures.ts.",
    ).toEqual([]);
  });
});
