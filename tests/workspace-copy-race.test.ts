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

import { existsSync, promises as fs } from "node:fs";
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

describe("a workspaces root inside the project", () => {
  /**
   * HARNESS_DISPATCH_WORKSPACES_DIR pointing inside the project is not an
   * exotic misconfiguration — it is what README and the 0.7.0 notes recommend
   * for keeping the copy on the project's own volume, where a reflink is
   * possible. Nothing validated it, and the exclusion list covered exactly one
   * hard-coded path, so the copy walked into the workspace it was writing:
   * measured at 201 levels of nesting and an 11,800-character path on a
   * six-file project before the run was killed.
   */
  it("does not copy the workspace area into itself", async () => {
    const inside = path.join(dir, "ws");
    const original = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = inside;
    try {
      // A sibling run's workspace, which must not be copied either.
      await realFsp.mkdir(path.join(inside, "older-run", "workspace"), { recursive: true });
      await realFsp.writeFile(path.join(inside, "older-run", "workspace", "old.js"), "//\n", "utf8");

      const prepared = await prepareWorkspace({
        policy: "copy",
        routeName: "probe",
        workingDir: dir,
        files: [],
      });
      const copyRoot = prepared.effectiveWorkingDir;

      // The project's real files came across...
      expect(existsSync(path.join(copyRoot, "keep.js"))).toBe(true);
      // ...and the workspace area did not, at any depth.
      expect(existsSync(path.join(copyRoot, "ws"))).toBe(false);

      // Nothing runaway: a self-copy shows up as depth long before it shows up
      // as a hang, and asserting on depth fails fast instead of timing out.
      const deepest = async (root: string, depth = 0): Promise<number> => {
        if (depth > 12) return depth;
        const entries = await realFsp.readdir(root, { withFileTypes: true }).catch(() => []);
        let max = depth;
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          max = Math.max(max, await deepest(path.join(root, e.name), depth + 1));
        }
        return max;
      };
      expect(await deepest(copyRoot)).toBeLessThanOrEqual(3);
    } finally {
      if (original === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = original;
    }
  }, 60_000);
});
