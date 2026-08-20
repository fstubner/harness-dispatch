/**
 * A working directory is LIVE while it is being copied.
 *
 * copyTree lists a directory and then reads each entry, and anything can
 * happen in between: an editor saving over a temp file, a build watcher
 * cleaning output, another fanout arm writing into the same tree. Write-
 * capable fanout REQUIRES `copy`, so several concurrent copies of one
 * directory is the documented configuration rather than an exotic one.
 *
 * Before this, a single incidental file blinking out failed the whole
 * dispatch with a raw ENOENT — the caller losing real work over a file they
 * never cared about.
 *
 * The race is made DETERMINISTIC by mocking the copy itself. Reproducing it
 * with real timing would mean a test that fails once in fifty runs, which is
 * the thing this repo treats as worse than no test at all.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realFsp = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

/** Files whose copy should fail as if they had just been deleted. */
const vanish = new Set<string>();
/** A copy failure that is NOT a disappearance, to prove it still propagates. */
const denied = new Set<string>();
/** The `mode` argument each copyFile call received, for the reflink check. */
const copyModes: Array<number | undefined> = [];

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    copyFile: async (src: string, dest: string, mode?: number) => {
      copyModes.push(mode);
      const base = path.basename(String(src));
      if (vanish.has(base)) {
        const err = new Error(`ENOENT: no such file or directory, copyfile '${src}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (denied.has(base)) {
        const err = new Error(`EACCES: permission denied, copyfile '${src}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.copyFile(src, dest, mode);
    },
  };
});

const { prepareWorkspace } = await import("../src/workspaces.js");

let dir: string;

beforeEach(async () => {
  vanish.clear();
  denied.clear();
  copyModes.length = 0;
  dir = await realFsp.mkdtemp(path.join(os.tmpdir(), "hr-copyrace-"));
  await realFsp.writeFile(path.join(dir, "keep.js"), "export const a = 1;\n", "utf8");
  await realFsp.writeFile(path.join(dir, "doomed.js"), "export const b = 2;\n", "utf8");
});

afterEach(async () => {
  await realFsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("copying a directory that is being written to", () => {
  it("completes when a file disappears mid-copy, and says which", async () => {
    vanish.add("doomed.js");

    const prepared = await prepareWorkspace({
      policy: "copy",
      routeName: "probe",
      workingDir: dir,
      files: [],
    });
    const run = await prepared.finish({ output: "", service: "probe", success: true });

    // The dispatch survived, and the file that stayed put was copied.
    const copied = await realFsp.readFile(
      path.join(prepared.effectiveWorkingDir, "keep.js"),
      "utf8",
    );
    expect(copied).toContain("export const a = 1;");

    // And the caller is told the copy is not a faithful snapshot — silence
    // here would be a workspace quietly missing a file.
    const notes = (run.workspace?.notes ?? []).join(" ");
    expect(notes).toMatch(/disappeared while the workspace was being copied/);
    expect(notes).toContain("doomed.js");
  });

  it("still fails loudly when the copy is refused rather than absent", async () => {
    // A permission error means the copy is not the snapshot it claims to be,
    // for a reason that will not have fixed itself. Swallowing everything
    // would turn this fix into a way to lose files silently.
    denied.add("doomed.js");

    await expect(
      prepareWorkspace({ policy: "copy", routeName: "probe", workingDir: dir, files: [] }),
    ).rejects.toThrow(/EACCES/);
  });
});

describe("workspace copies ask for a reflink", () => {
  /**
   * `copy` duplicates a whole project per dispatch, and fanout does it per
   * arm, so the copy is the setup cost that matters. COPYFILE_FICLONE asks
   * the filesystem to share blocks instead of duplicating them — instant and
   * allocation-free on APFS, Btrfs/XFS and ReFS/Dev Drive.
   *
   * FICLONE and not FICLONE_FORCE is the load-bearing detail: the plain flag
   * degrades to an ordinary copy where reflinks are unsupported (plain NTFS,
   * ext4, cross-device), while FORCE would turn a working copy into an error
   * on most machines. This asserts the weaker, safe flag specifically.
   */
  it("passes COPYFILE_FICLONE, not FICLONE_FORCE", async () => {
    const { constants } = await import("node:fs");
    await prepareWorkspace({ policy: "copy", routeName: "probe", workingDir: dir, files: [] });

    expect(copyModes.length).toBeGreaterThan(0);
    for (const mode of copyModes) {
      expect(mode).toBe(constants.COPYFILE_FICLONE);
      expect(mode).not.toBe(constants.COPYFILE_FICLONE_FORCE);
    }
  });
});
