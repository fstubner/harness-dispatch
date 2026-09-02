import { execFile } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// `npm install -g` puts the command on PATH as a link to dist/bin.js whose
// name is `harness-dispatch`, not `bin.js`. Node passes that link path as
// argv[1] unresolved, and a guard that only checked the filename ran nothing
// and exited 0 — every documented command was a silent no-op on Linux and
// macOS through 0.8.0. These spawn the BUILT file through a link, the way npm
// does, so they need `npm run build` first (CI builds before it tests).
//
// The hardlink case runs everywhere: Windows refuses file symlinks without a
// privilege, but a hardlink to a file on the same volume is fine, and it
// exercises the same defect — argv[1] no longer ends in bin.js. The symlink
// case is the exact npm shape and runs where symlinks are allowed.

const run = promisify(execFile);
const dist = path.resolve(__dirname, "..", "dist");
const bin = path.join(dist, "bin.js");
const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function expectHelpVia(link: string): Promise<void> {
  const { stdout } = await run(process.execPath, [link, "--help"]);
  expect(stdout).toContain("Usage:");
}

describe("the built command runs when invoked through a link (as npm installs it)", () => {
  it.skipIf(!existsSync(bin))("hardlink named without .js, beside its imports", async () => {
    // Must live in dist/ itself: a hardlink is the file, so its relative
    // imports resolve from wherever the link sits.
    const link = path.join(dist, `harness-dispatch-entrypoint-${process.pid}`);
    cleanup.push(link);
    linkSync(bin, link);
    await expectHelpVia(link);
  });

  it.skipIf(!existsSync(bin) || process.platform === "win32")(
    "symlink from another directory, the npm bin shape",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "hd-entrypoint-"));
      cleanup.push(dir);
      const link = path.join(dir, "harness-dispatch");
      symlinkSync(bin, link);
      await expectHelpVia(link);
    },
  );
});
