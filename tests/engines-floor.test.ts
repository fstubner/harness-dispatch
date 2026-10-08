/**
 * Every runtime dependency accepts every Node version this package claims to.
 *
 * `which@7.0.0` requires `^22.22.2 || ^24.15.0 || >=26`, while package.json
 * says `>=22.22.2`. A first install on Node 24.14.1 — inside our own range —
 * opened with an EBADENGINE warning for a dependency, the first thing a new
 * user saw. The lockfile records each package's engines, so the mismatch is
 * checkable without installing anything.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// semver is in the dev tree (lockfile top level); no types are installed for it.
const semver = createRequire(import.meta.url)("semver") as {
  subset: (sub: string, dom: string) => boolean;
};

interface LockEntry {
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
  devOptional?: boolean;
  engines?: { node?: string } | string[];
}

describe("the engines field", () => {
  it("is no wider than any runtime dependency's", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, LockEntry>;
    };
    const narrower: string[] = [];
    for (const [name, entry] of Object.entries(lock.packages)) {
      // "" is this package. Dev, optional and peer entries are not installed
      // for a user (telemetry is an optional peer).
      if (name === "" || entry.dev || entry.optional || entry.peer || entry.devOptional) continue;
      const range = Array.isArray(entry.engines) ? undefined : entry.engines?.node;
      if (range === undefined) continue;
      if (!semver.subset(pkg.engines.node, range)) narrower.push(`${name} requires ${range}`);
    }
    expect(narrower, `package.json allows node ${pkg.engines.node}`).toEqual([]);
  });
});
