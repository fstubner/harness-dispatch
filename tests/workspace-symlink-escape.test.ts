/**
 * Symlinks must not carry a caller out of an isolated workspace.
 *
 * copyTree recreated link targets verbatim with no containment check, so a
 * link to an absolute host path was rebuilt inside the "isolated" copy and
 * writing through it hit the real filesystem.
 *
 * PLATFORM SPLIT, and it matters for reading these results:
 *   - Linux/macOS: fs.symlink works unprivileged, so the escape reproduced
 *     directly. These cases are the real proof and run on the ubuntu-latest
 *     and macos-latest CI jobs.
 *   - Windows: unprivileged fs.symlink fails EPERM, which made the bug LOOK
 *     absent — the old code's bare `catch {}` swallowed the error. A
 *     directory JUNCTION needs no privileges and readdir reports it as a
 *     symlink, so it exercises the same branch and is used here instead.
 */

import { promises as fs } from "node:fs";
import { symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareWorkspace } from "../src/workspaces.js";

const isWindows = process.platform === "win32";

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hr-symesc-"));
  project = path.join(root, "project");
  outside = path.join(root, "OUTSIDE");
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "host-content", "utf8");
  await fs.writeFile(path.join(project, "README.md"), "x", "utf8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Create a link that escapes the workspace, using whatever the platform allows. */
function linkOutside(at: string): void {
  symlinkSync(outside, at, isWindows ? "junction" : "dir");
}

describe("isolated workspace copy — symlink containment", () => {
  it("does not recreate a link pointing outside the workspace", async () => {
    linkOutside(path.join(project, "src", "escape"));

    const ws = await prepareWorkspace({
      routeName: "probe",
      policy: "copy",
      workingDir: project,
      files: [],
    });

    const copied = path.join(ws.effectiveWorkingDir, "src", "escape");
    await expect(fs.lstat(copied)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a write through the copied path cannot reach the host file", async () => {
    // The assertion that actually describes the vulnerability: before the fix
    // (on a platform where symlink() succeeds) this overwrote the real file.
    linkOutside(path.join(project, "src", "escape"));

    const ws = await prepareWorkspace({
      routeName: "probe",
      policy: "copy",
      workingDir: project,
      files: [],
    });

    const target = path.join(ws.effectiveWorkingDir, "src", "escape", "secret.txt");
    await expect(fs.writeFile(target, "OVERWRITTEN", "utf8")).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("host-content");
  });

  it("reports what it dropped instead of silently changing the tree", async () => {
    linkOutside(path.join(project, "src", "escape"));

    const ws = await prepareWorkspace({
      routeName: "probe",
      policy: "copy",
      workingDir: project,
      files: [],
    });
    const result = await ws.finish({ output: "", success: true } as never);

    expect((result.workspace?.notes ?? []).join("\n")).toMatch(/Dropped 1 symlink/);
  });

  // Unprivileged Windows cannot create a FILE symlink at all, and a junction
  // only points at a directory — so the in-tree case has no Windows form.
  it.skipIf(isWindows)("still preserves a link that stays inside the workspace", async () => {
    await fs.writeFile(path.join(project, "src", "real.txt"), "in-tree", "utf8");
    symlinkSync("./real.txt", path.join(project, "src", "alias.txt"), "file");

    const ws = await prepareWorkspace({
      routeName: "probe",
      policy: "copy",
      workingDir: project,
      files: [],
    });

    const copied = path.join(ws.effectiveWorkingDir, "src", "alias.txt");
    expect((await fs.lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(copied, "utf8")).toBe("in-tree");
  });

  it.skipIf(isWindows)("drops a relative link that climbs out with ..", async () => {
    symlinkSync("../../OUTSIDE", path.join(project, "src", "climb"), "dir");

    const ws = await prepareWorkspace({
      routeName: "probe",
      policy: "copy",
      workingDir: project,
      files: [],
    });

    await expect(fs.lstat(path.join(ws.effectiveWorkingDir, "src", "climb"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
