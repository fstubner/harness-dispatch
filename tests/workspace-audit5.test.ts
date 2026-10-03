/**
 * Workspace fixes from the fifth audit: the stat-based second pass, the two
 * change detectors agreeing, and the Low defects left over from the fourth.
 *
 * Like workspace-matrix.test.ts these drive the real prepareWorkspace/finish
 * path and assert on what is on disk, not on what the tool reports.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyWorkspace, persistWorkspacePatch, workspaceDiff } from "../src/workspace-resolve.js";
import { EXCLUDED_DIRS, fingerprintTree, prepareWorkspace } from "../src/workspaces.js";
import type { DispatchResult, WorkspaceRun } from "../src/types.js";

const execFile = promisify(execFileCb);
const git = async (args: string[], cwd: string) =>
  String((await execFile("git", args, { cwd, windowsHide: true })).stdout);

let root: string;
let wsHome: string;
let jobDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-a5-")));
  wsHome = path.join(root, "ws-home");
  jobDir = path.join(root, "job");
  await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
  for (const key of ["HARNESS_DISPATCH_WORKSPACES_DIR", "HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS"]) {
    saved[key] = process.env[key];
  }
  process.env["HARNESS_DISPATCH_WORKSPACES_DIR"] = wsHome;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const ok = (): DispatchResult => ({ output: "", service: "t", success: true });

async function makeRepo(files: Record<string, string>, name = "repo"): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@example.test"], repo);
  await git(["config", "user.name", "T"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), content, "utf8");
  }
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "initial"], repo);
  return repo;
}

describe("fingerprintTree second pass", () => {
  it("does not re-read a file whose size, mtime and ctime are unchanged", async () => {
    const dir = path.join(root, "tree");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "alpha\n");
    const before = await fingerprintTree(dir);
    // Forge the recorded hash: only a pass that did NOT read the file can
    // return it, so this observes the skipped read directly.
    before.get("a.txt")!.hash = "forged";
    const settledLongAgo = Date.now() + 60_000;
    const after = await fingerprintTree(dir, { reuse: { before, settledAt: settledLongAgo } });
    expect(after.get("a.txt")?.hash).toBe("forged");
    // A file stamped within the racy window of the snapshot is always re-read.
    const racy = await fingerprintTree(dir, { reuse: { before, settledAt: 0 } });
    expect(racy.get("a.txt")?.hash).not.toBe("forged");
  });

  it("still sees a same-size edit, however the agent stamps the file", async () => {
    const dir = path.join(root, "tree");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "b.txt"), "one\n");
    const before = await fingerprintTree(dir);
    await fs.writeFile(path.join(dir, "b.txt"), "two\n");
    // Put mtime back exactly where it was: the edit must still show, through
    // ctime, which utimes cannot restore.
    await fs.utimes(path.join(dir, "b.txt"), new Date(before.get("b.txt")!.mtimeMs!), new Date(before.get("b.txt")!.mtimeMs!));
    const after = await fingerprintTree(dir, { reuse: { before, settledAt: Date.now() + 60_000 } });
    expect(after.get("b.txt")?.hash).not.toBe(before.get("b.txt")?.hash);
  });
});

describe("copy workspace change detection", () => {
  it("reports an added, a same-size modified and a deleted file, and nothing else", async () => {
    const repo = await makeRepo({
      "keep.txt": "keep\n",
      "same-size.txt": "AAAA\n",
      "gone.txt": "gone\n",
      "sub/deep.txt": "deep\n",
    });
    const prepared = await prepareWorkspace({ routeName: "c", policy: "copy", workingDir: repo, files: [] });
    const dir = prepared.effectiveWorkingDir;
    await fs.writeFile(path.join(dir, "same-size.txt"), "BBBB\n");
    await fs.rm(path.join(dir, "gone.txt"));
    await fs.writeFile(path.join(dir, "sub", "new.txt"), "new\n");
    const finished = await prepared.finish(ok());
    const changes = finished.workspace?.changedFiles?.map((c) => `${c.kind}:${c.path}`);
    expect(changes).toEqual(["deleted:gone.txt", "modified:same-size.txt", "added:sub/new.txt"]);
  });
});

describe("git_worktree: changedFiles agrees with the patch (EXCLUDED_DIRS parity)", () => {
  it("reports edits to tracked files under every excluded directory name", async () => {
    const names = [...EXCLUDED_DIRS].filter((n) => n !== ".git");
    const files: Record<string, string> = { "src/app.txt": "app\n" };
    for (const n of names) files[`${n}/tracked.txt`] = `${n} original\n`;
    const repo = await makeRepo(files);
    const prepared = await prepareWorkspace({ routeName: "w", policy: "git_worktree", workingDir: repo, files: [] });
    for (const n of names) {
      await fs.writeFile(path.join(prepared.effectiveWorkingDir, n, "tracked.txt"), `${n} EDITED\n`);
    }
    await fs.writeFile(path.join(prepared.effectiveWorkingDir, "src", "app.txt"), "APP\n");
    const finished = await prepared.finish(ok());
    const run = finished.workspace!;
    await git(["add", "-A", "-N"], run.effectiveWorkingDir);
    const inPatch = (await git(["diff", "--name-only", run.baseCommit!], run.effectiveWorkingDir))
      .split("\n")
      .filter(Boolean)
      .sort();
    const reported = (run.changedFiles ?? []).map((c) => c.path).sort();
    expect(inPatch.length).toBe(names.length + 1);
    expect(reported).toEqual(inPatch);
  });

  it("still leaves out an excluded directory the agent creates (an install, a build)", async () => {
    const repo = await makeRepo({ "src/app.txt": "app\n" });
    const prepared = await prepareWorkspace({ routeName: "w", policy: "git_worktree", workingDir: repo, files: [] });
    await fs.mkdir(path.join(prepared.effectiveWorkingDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(prepared.effectiveWorkingDir, "node_modules", "pkg", "i.js"), "x");
    const finished = await prepared.finish(ok());
    expect(finished.workspace?.changedFiles).toEqual([]);
  });
});

describe("git_worktree from a directory HEAD does not have (A3-2)", () => {
  it("refuses in plain words and leaves no worktree registered", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    const fresh = path.join(repo, "newpkg");
    await fs.mkdir(fresh);
    await fs.writeFile(path.join(fresh, "x.txt"), "uncommitted\n");
    await expect(
      prepareWorkspace({ routeName: "w", policy: "git_worktree", workingDir: fresh, files: [] }),
    ).rejects.toThrow(/not in it/);
    const listed = (await git(["worktree", "list", "--porcelain"], repo)).split("\n").filter((l) => l.startsWith("worktree "));
    expect(listed).toHaveLength(1);
  });
});

describe("git_worktree in a monorepo (A3-5)", () => {
  it("does not call a sibling package's file an escape from isolation", async () => {
    const repo = await makeRepo({ "pkgA/a.txt": "a\n", "pkgB/b.txt": "b\n" });
    const prepared = await prepareWorkspace({
      routeName: "w",
      policy: "git_worktree",
      workingDir: path.join(repo, "pkgA"),
      files: [path.join(repo, "pkgB", "b.txt")],
    });
    const finished = await prepared.finish(ok());
    expect(JSON.stringify(finished.workspace?.notes)).not.toContain("ISOLATION WIDENED");
  });

  it("still warns about a file outside the repository", async () => {
    const repo = await makeRepo({ "pkgA/a.txt": "a\n" });
    const outside = path.join(root, "elsewhere.txt");
    await fs.writeFile(outside, "x");
    const prepared = await prepareWorkspace({
      routeName: "w",
      policy: "git_worktree",
      workingDir: path.join(repo, "pkgA"),
      files: [outside],
    });
    const finished = await prepared.finish(ok());
    expect(JSON.stringify(finished.workspace?.notes)).toContain("ISOLATION WIDENED");
  });
});

describe("applied work, workspace gone (A3-3, A3-4)", () => {
  for (const policy of ["copy", "git_worktree"] as const) {
    it(`${policy}: a diff after apply keeps the saved patch, and re-applying landed work says so`, async () => {
      const repo = await makeRepo({ "edit-me.txt": "original\n", "other.txt": "other\n" });
      const prepared = await prepareWorkspace({ routeName: "r", policy, workingDir: repo, files: [] });
      await fs.writeFile(path.join(prepared.effectiveWorkingDir, "edit-me.txt"), "AGENT EDITED\n");
      const finished = await prepared.finish(ok());
      const run: WorkspaceRun = finished.workspace!;
      await persistWorkspacePatch(jobDir, run);
      const patchPath = path.join(jobDir, "output", "workspace.patch");
      const saved = (await fs.stat(patchPath)).size;
      expect(saved).toBeGreaterThan(0);

      const first = await applyWorkspace("job", jobDir, run);
      expect(first.applied, first.message).toBe(true);
      await workspaceDiff("job", jobDir, run);
      expect((await fs.stat(patchPath)).size, "the saved patch was truncated by a diff after apply").toBe(saved);

      // The user commits it, and the workspace goes away.
      await git(["add", "-A"], repo);
      await git(["commit", "-qm", "landed"], repo);
      if (policy === "git_worktree") {
        await git(["worktree", "remove", "--force", path.join(run.workspaceRoot!, "worktree")], repo);
      }
      await fs.rm(run.workspaceRoot!, { recursive: true, force: true });
      expect(existsSync(run.workspaceRoot!)).toBe(false);

      const again = await applyWorkspace("job", jobDir, run);
      expect(again.message).toContain("Already applied");
      // git's eol settings may land the file as CRLF; the content is what counts.
      const landed = await fs.readFile(path.join(repo, "edit-me.txt"), "utf8");
      expect(landed.replace(/\r\n/g, "\n")).toBe("AGENT EDITED\n");
    }, 60_000);
  }
});

describe("retention and a live run (A3-6)", () => {
  it("does not delete a run that is still going, however old its directory is", async () => {
    process.env["HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS"] = "1500";
    const repo = await makeRepo({ "a.txt": "a\n" });
    const live = await prepareWorkspace({ routeName: "live", policy: "copy", workingDir: repo, files: [] });
    await fs.writeFile(path.join(live.effectiveWorkingDir, "a.txt"), "being edited\n");
    // Longer than the max age: the directory's own mtime is now past it.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    await fs.writeFile(path.join(live.effectiveWorkingDir, "a.txt"), "still being edited\n");
    // A second dispatch in the same project runs the prune.
    const other = await prepareWorkspace({ routeName: "other", policy: "copy", workingDir: repo, files: [] });
    expect(existsSync(live.workspaceRoot!), "a live workspace was reclaimed").toBe(true);
    const finished = await live.finish(ok());
    expect(finished.workspace?.changedFiles?.map((c) => c.path)).toEqual(["a.txt"]);
    await other.finish(ok());
  }, 30_000);

  it("a finished run ages out from its end, and leaves no heartbeat behind", async () => {
    process.env["HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS"] = "1500";
    const repo = await makeRepo({ "a.txt": "a\n" });
    const done = await prepareWorkspace({ routeName: "done", policy: "copy", workingDir: repo, files: [] });
    await done.finish(ok());
    expect(existsSync(path.join(done.workspaceRoot!, ".alive"))).toBe(false);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(done.workspaceRoot!, old, old);
    const next = await prepareWorkspace({ routeName: "next", policy: "copy", workingDir: repo, files: [] });
    expect(existsSync(done.workspaceRoot!), "a finished, aged run was kept").toBe(false);
    await next.finish(ok());
  }, 30_000);
});
