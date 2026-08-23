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
import { existsSync, promises as fs } from "node:fs";
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

  it("never reports a failed apply while leaving the project rewritten", async () => {
    // --3way is NOT atomic: on conflict it writes `<<<<<<< ours` markers INTO
    // the target and then exits non-zero. It used to be tried FIRST, and the
    // failure was reported as "git apply failed … resolve by hand" — which
    // reads as "nothing happened", while the user's file had already been
    // rewritten with conflict markers. They had neither their change nor any
    // idea their file had moved.
    //
    // Plain apply goes first now (it applies everything or nothing), and if an
    // attempt does mutate the tree the message has to say so.
    const run = await worktreeRun();
    const appFile = path.join(run.originalWorkingDir, "app.js");
    // Diverge the project on the same line, and COMMIT, so the project is
    // clean — the dirty-project refusal must not be what stops us here.
    await fs.writeFile(appFile, "const a = 4321; // HUMAN\n", "utf8");
    await git(["add", "-A"], run.originalWorkingDir);
    await git(["commit", "-qm", "human edit"], run.originalWorkingDir);

    const out = await applyWorkspace("job-1700000000023-aabbccdd", jobDir, run);
    const after = await readNorm(appFile);
    const projectChanged = after !== "const a = 4321; // HUMAN\n";

    if (out.applied) {
      // A successful three-way merge is a fine outcome.
      expect(projectChanged).toBe(true);
    } else if (projectChanged) {
      // The outcome this test exists for: mutated despite reporting failure.
      expect(
        out.message,
        `project was rewritten but the message did not say so:\n${after}`,
      ).toMatch(/YOUR PROJECT WAS MODIFIED ANYWAY/);
      expect(out.message).toContain("app.js");
    } else {
      expect(out.message).toMatch(/project was not modified/i);
    }
  });

  it("applies, and then discards, when the dispatch ran in a SUBDIRECTORY of the repo", async () => {
    // Two defects met here, both invisible to a repo-root dispatch:
    //
    //   apply ran git from the workingDir, but git apply resolves patch paths
    //   at the REPO root regardless of cwd — so from `sub/` it looked for
    //   `sub/a.txt` at the root, printed `Skipped patch`, exited 0, and we
    //   reported "Applied N bytes" having changed nothing.
    //
    //   discard then refused forever: a worktree's changedFiles are relative
    //   to the repo root, and the check joined them onto originalWorkingDir,
    //   looking for `<repo>/sub/sub/a.txt`. A guard that fires after a
    //   verified successful apply is a guard that cries wolf.
    const repo = await makeRepo("subdir-proj");
    const sub = path.join(repo, "sub");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, "a.txt"), "original\n", "utf8");
    await git(["add", "-A"], repo);
    await git(["commit", "-qm", "add sub"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const wsRoot = path.join(dir, "subws");
    const worktree = path.join(wsRoot, "worktree");
    await fs.mkdir(wsRoot, { recursive: true });
    await git(["worktree", "add", "--detach", "-q", worktree, base], repo);
    await fs.writeFile(path.join(worktree, "sub", "a.txt"), "AGENT line\n", "utf8");

    const run: WorkspaceRun = {
      policy: "git_worktree",
      originalWorkingDir: sub, // the dispatch's workingDir, BELOW the repo root
      effectiveWorkingDir: path.join(worktree, "sub"),
      workspaceRoot: wsRoot,
      baseCommit: base,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "sub/a.txt", kind: "modified" }],
    };

    const applied = await applyWorkspace("job-1700000000024-aabbccdd", jobDir, run);
    expect(applied.applied, applied.message).toBe(true);
    // The assertion that catches "Skipped patch, exit 0, reported success".
    expect(await readNorm(path.join(sub, "a.txt"))).toBe("AGENT line\n");

    const out = await discardWorkspace("job-1700000000024-aabbccdd", run);
    expect(out.discarded, out.message).toBe(true);
  });

  it("discard removes the worktree through git, not just the directory", async () => {
    const run = await worktreeRun();
    const discarded = await discardWorkspace("job-1700000000006-ffffffff", run);
    // discard speaks only for ITSELF. "The original project was never
    // modified" was printed unconditionally, including immediately after an
    // apply that had just modified it.
    expect(discarded.message).not.toMatch(/never modified/i);

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

  it("never rewrites file CONTENT that contains the project path", async () => {
    // The patch text had the project root stripped from EVERY line, content
    // included. A delegate wrote `const dataDir = "<project>/data"` and the
    // project received `const dataDir = "data"` — wrong content, applied,
    // reported as a clean success. Env files, tsconfig paths, docker volumes
    // and fixtures all routinely name their own absolute path.
    const repo = await makeRepo("content-path");
    const wsRoot = path.join(dir, "cp-ws");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    const posixRepo = repo.replace(/\\/g, "/");
    await fs.writeFile(
      path.join(copy, "conf.js"),
      `export const dataDir = "${posixRepo}/data";\n`,
      "utf8",
    );
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    const patch = await buildWorkspacePatch(run);
    expect(patch, `content line was rewritten:\n${patch}`).toContain(`"${posixRepo}/data"`);
    // Headers must still be repo-relative, or the patch applies nowhere.
    expect(patch).toContain("+++ b/conf.js");
    expect(patch).not.toContain(`+++ b/${posixRepo}`);
  });

  it("reports a git failure instead of returning it as an empty patch", async () => {
    // git diff exits 1 for "there are differences" AND for real errors, and
    // the two were indistinguishable. Live on Windows, a copy workspace whose
    // paths crossed MAX_PATH made git exit 1 with EMPTY stdout and
    // `error: Could not open directory <259 chars>` on stderr — read as "the
    // agent changed nothing". The feature could not deliver and the user was
    // told to file a bug report instead of the actual cause.
    //
    // Simulated by pointing the workspace at a path that does not exist, which
    // is the same shape (git errors, stdout empty) without needing a 260-char
    // path that the test runner itself could not create.
    const repo = await makeRepo("git-failure");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: path.join(repo, "no-such-directory-here"),
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    await expect(buildWorkspacePatch(run)).rejects.toThrow(/could not produce a patch/i);
  });

  it("does not mistake git's line-ending warnings for a failure", async () => {
    // The discriminator is `error:`/`fatal:` on stderr, NOT any stderr at all.
    // git emits `warning: in the working copy of ..., LF will be replaced by
    // CRLF` routinely, and treating that as failure would break every diff on
    // a CRLF checkout — which is most of them on Windows.
    const run = await nestedCopyRun();
    const patch = await buildWorkspacePatch(run);
    expect(patch).toContain("+const a = 5;");
  });

  it("says 'already applied' on a second apply, instead of crying data loss", async () => {
    // The 0.6.3 guard fired on the one benign case with the same shape.
    // changedFiles is frozen at dispatch and the patch is recomputed live, so
    // after a successful apply the project matches the workspace and the empty
    // patch is CORRECT — but the user was told their work had been silently
    // dropped and to report a bug, a second after it landed fine.
    const repo = await makeRepo("apply-twice");
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
      changedFiles: [{ path: "notes.txt", kind: "added" }],
    };

    const first = await applyWorkspace("job-1700000000013-aabbccdd", jobDir, run);
    expect(first.applied, first.message).toBe(true);

    const second = await applyWorkspace("job-1700000000013-aabbccdd", jobDir, run);
    expect(second.applied).toBe(false);
    expect(second.message).toMatch(/already matches/i);
    expect(second.message).not.toMatch(/silently drop|Please report/);
  });

  it("refuses to discard work the project does not have", async () => {
    // apply can end with "Do NOT discard this job — the workspace still holds
    // the files at …", and discard then deleted them anyway and answered "The
    // original project was never modified." The reassuring sentence arrived at
    // the exact moment the only copy was destroyed. Discard is the one
    // irreversible action here, so it owes the same check apply makes.
    const repo = await makeRepo("discard-guard");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "notes.txt"), "only-copy-of-this\n", "utf8");
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "notes.txt", kind: "added" }],
    };

    const refused = await discardWorkspace("job-1700000000020-aabbccdd", run);
    expect(refused.discarded).toBe(false);
    expect(refused.message).toContain("notes.txt");
    expect(refused.message).toMatch(/only copy/i);
    // The workspace is still there — a refusal that deleted anyway is no refusal.
    expect(existsSync(copy)).toBe(true);

    // force is the documented way through.
    const forced = await discardWorkspace("job-1700000000020-aabbccdd", run, { force: true });
    expect(forced.discarded).toBe(true);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it("discards without complaint once the work is in the project", async () => {
    // The guard must not turn discard into a permanent refusal: after apply,
    // the workspace is redundant and cleaning it up is the whole point.
    const repo = await makeRepo("discard-after-apply");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.copyFile(path.join(repo, "app.js"), path.join(copy, "app.js"));
    await fs.writeFile(path.join(copy, "notes.txt"), "landed\n", "utf8");
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "notes.txt", kind: "added" }],
    };

    const applied = await applyWorkspace("job-1700000000021-aabbccdd", jobDir, run);
    expect(applied.applied, applied.message).toBe(true);

    const out = await discardWorkspace("job-1700000000021-aabbccdd", run);
    expect(out.discarded, out.message).toBe(true);
  });

  it("names what force ran over instead of reporting a plain success", async () => {
    // force waives the uncommitted-changes refusal. It was answered with the
    // same cheerful line as a clean apply, so a human edit the patch replaced
    // left no trace in the response at all. The waiver covers doing it; it
    // does not cover being quiet about it.
    const repo = await makeRepo("force-overwrite");
    const wsRoot = path.join(repo, ".harness-dispatch", "workspaces", "run-1");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, "app.js"), "const a = 5;\n", "utf8");
    // The human edits the same file after the agent started.
    await fs.writeFile(path.join(repo, "app.js"), "const a = 999; // HUMAN\n", "utf8");
    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };

    const out = await applyWorkspace("job-1700000000022-aabbccdd", jobDir, run, { force: true });
    if (out.applied) {
      expect(out.message).toMatch(/FORCED over/);
      expect(out.message).toContain("app.js");
    } else {
      // A conflict is an acceptable outcome too — but then it must say the
      // project was or was not modified, never leave it unstated.
      expect(out.message).toMatch(/project was (not )?modified/i);
    }
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
    expect(out.message).toContain("notes.txt");
    expect(out.message).toContain("Do NOT discard");
    expect(out.message).not.toContain("changed nothing");
    // And not the benign "already applied" answer: the file is in neither the
    // project nor the workspace, so nothing landed.
    expect(out.message).not.toMatch(/already matches/i);
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
