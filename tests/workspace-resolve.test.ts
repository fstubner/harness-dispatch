/**
 * Inspecting, keeping and discarding isolated work.
 *
 * Isolation existed; the lifecycle around it did not. A `copy` or
 * `git_worktree` dispatch produced a workspace, a changed-file list, and a
 * `cleanupHint` string telling the caller to run `git worktree remove`
 * themselves. There was no way to see the real change, no way to keep it, and
 * no cleanup but by hand — so isolated dispatches were write-only.
 *
 * The test that matters most here is the DIRTY-PROJECT one. A worktree starts
 * at HEAD, not at the caller's working tree, so a naive "diff the worktree
 * against the project directory" reports the user's own uncommitted work as
 * deletions — and applying that patch would delete it. Everything else in this
 * file is bookkeeping; that one is about not destroying someone's work.
 */

import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyWorkspace,
  buildWorkspacePatch,
  discardWorkspace,
  workspaceDiff,
} from "../src/workspace-resolve.js";
import type { WorkspaceRun } from "../src/types.js";

const execFile = promisify(execFileCb);
const git = (args: string[], cwd: string) => execFile("git", args, { cwd, windowsHide: true });

/**
 * Read a file with line endings normalised.
 *
 * `git apply` honours the repo's autocrlf setting, so applied content arrives
 * CRLF on Windows. That is git behaving correctly rather than the patch being
 * wrong, so these assertions compare content, not line-ending policy.
 */
async function readNorm(file: string): Promise<string> {
  const text = await fs.readFile(file, "utf8");
  return text.split("\r\n").join("\n");
}

let dir: string;
let jobDir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-wsres-")));
  jobDir = path.join(dir, "job");
  await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A real git project with one committed file. */
async function makeRepo(name: string): Promise<string> {
  const repo = path.join(dir, name);
  await fs.mkdir(repo, { recursive: true });
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@example.test"], repo);
  await git(["config", "user.name", "Test"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  await fs.writeFile(path.join(repo, "app.js"), "const a = 1;\n", "utf8");
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "initial"], repo);
  return repo;
}

describe("copy workspaces", () => {
  async function copyRun(): Promise<WorkspaceRun> {
    const repo = await makeRepo("proj");
    const wsRoot = path.join(dir, "ws");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    // The agent's work: edit one file, add another.
    await fs.writeFile(path.join(copy, "app.js"), "const a = 2;\n", "utf8");
    await fs.writeFile(path.join(copy, "added.js"), "export const b = 3;\n", "utf8");
    return {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };
  }

  it("produces a patch of what the agent changed, with project-relative paths", async () => {
    const run = await copyRun();
    const patch = await buildWorkspacePatch(run);

    expect(patch).toContain("app.js");
    expect(patch).toContain("added.js");
    expect(patch).toContain("+const a = 2;");
    // Absolute paths would make the patch apply nowhere but this machine.
    expect(patch).not.toContain(run.originalWorkingDir.replace(/\\/g, "/"));
  });

  it("applies the agent's work into the original project", async () => {
    const run = await copyRun();
    const out = await applyWorkspace("job-1700000000001-aaaaaaaa", jobDir, run);

    expect(out.applied, out.message).toBe(true);
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe(
      "const a = 2;\n",
    );
    expect(await readNorm(path.join(run.originalWorkingDir, "added.js"))).toBe(
      "export const b = 3;\n",
    );
  });

  it("writes the patch to the job directory even so, for a manual path", async () => {
    const run = await copyRun();
    const out = await workspaceDiff("job-1700000000002-bbbbbbbb", jobDir, run);
    expect(out.patchPath).toContain("workspace.patch");
    expect((await fs.readFile(out.patchPath, "utf8")).length).toBeGreaterThan(0);
  });

  it("discard removes the workspace and never touches the project", async () => {
    const run = await copyRun();
    const out = await discardWorkspace("job-1700000000003-cccccccc", run);

    expect(out.discarded).toBe(true);
    expect(await fs.stat(run.workspaceRoot!).then(() => true).catch(() => false)).toBe(false);
    // The original is exactly as it was.
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe(
      "const a = 1;\n",
    );
  });
});

describe("git_worktree workspaces", () => {
  async function worktreeRun(): Promise<WorkspaceRun> {
    const repo = await makeRepo("gproj");
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    const wsRoot = path.join(dir, "gws");
    const worktree = path.join(wsRoot, "worktree");
    await fs.mkdir(wsRoot, { recursive: true });
    await git(["worktree", "add", "--detach", "-q", worktree, base], repo);
    await fs.writeFile(path.join(worktree, "app.js"), "const a = 99;\n", "utf8");
    await fs.writeFile(path.join(worktree, "new.js"), "export const c = 1;\n", "utf8");
    return {
      policy: "git_worktree",
      originalWorkingDir: repo,
      effectiveWorkingDir: worktree,
      workspaceRoot: wsRoot,
      baseCommit: base,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };
  }

  it("diffs against the base commit, including untracked additions", async () => {
    const run = await worktreeRun();
    const patch = await buildWorkspacePatch(run);
    expect(patch).toContain("+const a = 99;");
    expect(patch).toContain("new.js");
  });

  it("does NOT report the caller's uncommitted work as deletions", async () => {
    // The destructive case. A worktree starts at HEAD, so if the patch were
    // built by diffing the worktree against the project DIRECTORY, a file the
    // user created but never committed would look like something the agent
    // deleted — and applying that would delete it for real.
    const run = await worktreeRun();
    await fs.writeFile(path.join(run.originalWorkingDir, "my-wip.js"), "// mine\n", "utf8");

    const patch = await buildWorkspacePatch(run);

    expect(patch).not.toContain("my-wip.js");
  });

  it("refuses to apply into a dirty project unless forced", async () => {
    const run = await worktreeRun();
    await fs.writeFile(path.join(run.originalWorkingDir, "app.js"), "const a = 1234;\n", "utf8");

    const out = await applyWorkspace("job-1700000000004-dddddddd", jobDir, run);

    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/uncommitted/);
    // A refusal must still leave a way forward.
    expect(out.message).toMatch(/git apply/);
    expect((await fs.readFile(out.patchPath, "utf8")).length).toBeGreaterThan(0);
    // And it must not have half-applied anything.
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe(
      "const a = 1234;\n",
    );
  });

  it("applies into a clean project", async () => {
    const run = await worktreeRun();
    const out = await applyWorkspace("job-1700000000005-eeeeeeee", jobDir, run);
    expect(out.applied, out.message).toBe(true);
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe(
      "const a = 99;\n",
    );
  });

  it("discard removes the worktree through git, not just the directory", async () => {
    const run = await worktreeRun();
    await discardWorkspace("job-1700000000006-ffffffff", run);

    // rm -rf alone would leave git believing the worktree still exists.
    const list = (await git(["worktree", "list"], run.originalWorkingDir)).stdout;
    expect(list).not.toContain("worktree");
    expect(await fs.stat(run.workspaceRoot!).then(() => true).catch(() => false)).toBe(false);
  });
});

describe("jobs without an isolated workspace", () => {
  it("explains that a shared run has nothing to resolve", async () => {
    const { resolveJobWorkspace } = await import("../src/jobs.js");
    // No such job at all — the message must still be the friendly one.
    await expect(resolveJobWorkspace("job-1700000000007-99999999", "diff")).rejects.toThrow(
      /No such job/,
    );
  });
});

describe("the copy patch must never touch what the copy excluded", () => {
  /**
   * The most destructive bug this feature could have shipped.
   *
   * copyTree skips .git (and node_modules, and friends), so diffing the
   * original directory against the copy reports EVERY file in those
   * directories as deleted. Applying that patch would delete the user's git
   * repository — losing their entire history to a feature whose selling point
   * is that it never touches the original project.
   *
   * Caught by a test fixture failing with "invalid path '.git/COMMIT_EDITMSG'"
   * rather than by review.
   */
  it("excludes .git from the patch entirely", async () => {
    const repo = await makeRepo("excl");
    const wsRoot = path.join(dir, "excl-ws");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    // A copy as copyTree makes one: source files, no .git.
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "app.js"), "const a = 7;\n", "utf8");

    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    const patch = await buildWorkspacePatch(run);
    expect(patch).not.toContain(".git/");
    expect(patch).toContain("app.js");

    // And end to end: applying it leaves the repository intact.
    const out = await applyWorkspace("job-1700000000008-88888888", jobDir, run);
    expect(out.applied, out.message).toBe(true);
    expect(await fs.stat(path.join(repo, ".git")).then(() => true).catch(() => false)).toBe(true);
    expect(await readNorm(path.join(repo, "app.js"))).toBe("const a = 7;\n");
  });
});

describe("patch path normalisation across platforms", () => {
  /**
   * The bug CI found and a Windows machine cannot: on POSIX an absolute root
   * already starts with "/", so git emits `a//tmp/proj/app.js`. Stripping
   * "/tmp/proj/" from that ate the `a/` prefix and produced `aapp.js` —
   * "git diff header lacks filename information". A Windows root starts with
   * a drive letter, so the same code was fine locally and broken on both
   * Linux legs and macOS.
   *
   * Fed as strings so it pins both shapes wherever the suite runs.
   */
  it("rewrites POSIX roots without eating the a/ and b/ prefixes", async () => {
    const { normaliseNoIndexPaths } = await import("../src/workspace-resolve.js");
    const patch = [
      "diff --git a//tmp/run/proj/app.js b//tmp/run/ws/workspace/app.js",
      "--- a//tmp/run/proj/app.js",
      "+++ b//tmp/run/ws/workspace/app.js",
    ].join("\n");

    const out = normaliseNoIndexPaths(patch, "/tmp/run/proj", "/tmp/run/ws/workspace");

    expect(out).toBe(
      ["diff --git a/app.js b/app.js", "--- a/app.js", "+++ b/app.js"].join("\n"),
    );
  });

  it("rewrites Windows roots the same way", async () => {
    const { normaliseNoIndexPaths } = await import("../src/workspace-resolve.js");
    const patch = [
      "diff --git a/C:/run/proj/app.js b/C:/run/ws/workspace/app.js",
      "--- a/C:/run/proj/app.js",
      "+++ b/C:/run/ws/workspace/app.js",
    ].join("\n");

    const out = normaliseNoIndexPaths(patch, "C:/run/proj", "C:/run/ws/workspace");

    expect(out).toBe(
      ["diff --git a/app.js b/app.js", "--- a/app.js", "+++ b/app.js"].join("\n"),
    );
  });
});

describe("a copy workspace that lives INSIDE the project", () => {
  /**
   * Both bugs in this block were invisible to the other tests in this file
   * because their fixtures put the copy in a sibling directory. The product
   * puts it at <project>/.harness-dispatch/workspaces/..., inside the project
   * it is isolating from — and that changes two behaviours. Found by running
   * the tool against a real harness, not by review.
   */
  async function nestedCopyRun(): Promise<WorkspaceRun> {
    const repo = await makeRepo("nested");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    // copyTree omits .harness-dispatch, so the copy holds source files only.
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "app.js"), "const a = 5;\n", "utf8");
    return {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };
  }

  it("does not emit a spurious deletion of the file it is editing", async () => {
    // git diff --no-index walks into the copy while scanning the project, so
    // the copy's own app.js is reported as a project file with no counterpart
    // — a deletion. After path normalisation it collapsed onto the SAME name
    // as the real change, giving a patch with two conflicting sections:
    // "delete app.js" followed by "modify app.js". Applying that deleted the
    // file it was supposed to update.
    const run = await nestedCopyRun();
    const patch = await buildWorkspacePatch(run);

    const deletions = patch.split("\n").filter((l) => l.startsWith("+++ /dev/null"));
    expect(deletions, `patch contained a deletion:\n${patch}`).toEqual([]);
    expect(patch).toContain("+const a = 5;");
  });

  it("returns a file the agent CREATED, not just one it modified", async () => {
    // The gap this file left open twice over. The added-file cases above use a
    // SIBLING workspace; this block used the nested layout but only ever
    // MODIFIED a file. Nothing combined the two, and the combination is the
    // one that loses work.
    //
    // What happened: git pairs the two directory trees by relative path, and
    // the copy's own `notes.txt` (at .harness-dispatch/.../workspace/notes.txt
    // while scanning the project) has identical content to the addition (at
    // notes.txt inside the copy). Rename detection matched them and emitted
    // NOTHING — no deletion, no addition. dropSectionsUnder was already
    // written to keep additions under the workspace root; there was simply no
    // addition to keep. `diff` returned 0 bytes and `apply` said "the agent
    // changed nothing" while the same response listed the file as added, and
    // then `discard` deleted the only copy.
    const repo = await makeRepo("nested-added");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "notes.txt"), "hello-from-delegate\n", "utf8");
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    const patch = await buildWorkspacePatch(run);
    expect(patch, "the created file is missing from the patch entirely").toContain("notes.txt");
    expect(patch).toContain("hello-from-delegate");
    // And it must arrive as an addition against nothing, at the project-
    // relative path — not carrying the workspace directory in its name.
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/notes.txt");
    expect(patch).not.toContain(".harness-dispatch");

    // The unmodified file must not appear at all.
    expect(patch).not.toContain("app.js");
  });

  it("applies a created file into the project", async () => {
    // The end a user actually cares about: the work survives the round trip.
    const repo = await makeRepo("nested-added-apply");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "notes.txt"), "hello-from-delegate\n", "utf8");
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    const out = await applyWorkspace("job-1700000000011-aabbccdd", jobDir, run);
    expect(out.applied, out.message).toBe(true);
    expect(await readNorm(path.join(repo, "notes.txt"))).toBe("hello-from-delegate\n");
  });

  it("refuses rather than claiming nothing changed when changedFiles disagrees", async () => {
    // The guard behind the fix above. An empty patch beside a non-empty
    // changedFiles means the patch lost something, and the message a user acts
    // on must not be the reassuring one — they discard on the strength of it,
    // and the workspace is the only copy.
    const repo = await makeRepo("mismatch");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      // Nothing actually differs on disk, so the patch is legitimately empty;
      // this asserts a change anyway, standing in for a patch that lost one.
      changedFiles: [{ path: "notes.txt", kind: "added" }],
    };

    const out = await applyWorkspace("job-1700000000012-aabbccdd", jobDir, run);
    expect(out.applied).toBe(false);
    expect(out.message).toContain("notes.txt added");
    expect(out.message).toContain("Do NOT discard");
    expect(out.message).not.toContain("changed nothing");
  });

  it("does not count its own workspace directory as the user's uncommitted work", async () => {
    // The workspace is created inside the project, so `git status` is never
    // empty once a copy dispatch has run — and apply refused every time with
    // "1 uncommitted change": the feature blocked by its own scratch space.
    const run = await nestedCopyRun();
    const out = await applyWorkspace("job-1700000000010-aabbccdd", jobDir, run);

    expect(out.applied, out.message).toBe(true);
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe("const a = 5;\n");
  });

  it("still refuses when the user really does have uncommitted work", async () => {
    // The fix must not have turned the safety check off.
    const run = await nestedCopyRun();
    await fs.writeFile(path.join(run.originalWorkingDir, "mine.js"), "// mine\n", "utf8");

    const out = await applyWorkspace("job-1700000000011-bbccddee", jobDir, run);

    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/uncommitted/);
  });
});
