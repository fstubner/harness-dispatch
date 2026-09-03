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
  MAX_PATCH_BYTES,
  discardWorkspace,
  workspaceDiff,
} from "../src/workspace-resolve.js";
import { eolDigest } from "../src/workspaces.js";
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
      // What a real dispatch records, and has since 2026-07-13. The patch is
      // built from this list, so it can only ever describe files the agent
      // touched — which is why the whole-directory `git diff --no-index`
      // fallback, and the ~170 lines of filtering that made its output safe,
      // could be deleted.
      changedFiles: [
        { path: "app.js", kind: "modified", baseHash: eolDigest(Buffer.from("const a = 1;\n")) },
        { path: "added.js", kind: "added" },
      ],
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

  it("discard refuses while the workspace holds the only copy, and force overrides", async () => {
    // This used to assert a plain success, because the fixture recorded no
    // `changedFiles` — a shape a real dispatch has not produced since
    // 2026-07-13. With the field present, the guard that exists to stop
    // discard destroying unapplied work finally runs, and refusing IS the
    // documented behaviour: `apply` can end with "Do NOT discard this job".
    const run = await copyRun();
    const refused = await discardWorkspace("job-1700000000003-cccccccc", run);

    expect(refused.discarded, refused.message).toBe(false);
    expect(refused.message).toMatch(/only copy/i);
    expect(await fs.stat(run.workspaceRoot!).then(() => true).catch(() => false)).toBe(true);

    const forced = await discardWorkspace("job-1700000000003-cccccccc", run, { force: true });
    expect(forced.discarded, forced.message).toBe(true);
    expect(await fs.stat(run.workspaceRoot!).then(() => true).catch(() => false)).toBe(false);
    // Either way the original is exactly as it was.
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe(
      "const a = 1;\n",
    );
  });

  it("discard is a plain success once the work is already applied", async () => {
    const run = await copyRun();
    const applied = await applyWorkspace("job-1700000000004-dddddddd", jobDir, run);
    expect(applied.applied, applied.message).toBe(true);

    const out = await discardWorkspace("job-1700000000004-dddddddd", run);
    expect(out.discarded, out.message).toBe(true);
    expect(await fs.stat(run.workspaceRoot!).then(() => true).catch(() => false)).toBe(false);
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

  it("a SECOND apply says already applied, and does not call your own apply a conflict", async () => {
    // The "already applied" answer used to live only on the empty-patch path,
    // which git_worktree can never reach: its patch is `git diff <baseCommit>`
    // inside the worktree, so it does not change when the project changes and
    // is never empty. A `copy` patch is rebuilt against the project and does
    // empty out — which is why this was invisible there and live here.
    //
    // So a second apply fell through to the conflict check, which saw the file
    // differ from its recorded base — the difference the FIRST apply had just
    // made — and told the user their own successful apply was someone else's
    // newer work, pointing them at force: true. `ux-walkthrough.md` Flow 6
    // step 6 says both policies answer "already applied"; only one did.
    const run = await worktreeRun();
    const withChanges: WorkspaceRun = {
      ...run,
      changedFiles: [
        { path: "app.js", kind: "modified", baseHash: eolDigest(Buffer.from("const a = 1;\n")) },
        { path: "new.js", kind: "added" },
      ],
    };

    const first = await applyWorkspace("job-1700000000071-eeeeeeee", jobDir, withChanges);
    expect(first.applied, first.message).toBe(true);

    const second = await applyWorkspace("job-1700000000071-eeeeeeee", jobDir, withChanges);
    expect(second.applied).toBe(false);
    expect(second.message).toContain("Already applied");
    expect(second.message).not.toMatch(/changed since dispatch/);
    // And the file is still the agent's version, not reverted or duplicated.
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe("const a = 99;\n");
  });

  it("a REAL collision under git_worktree is still refused", async () => {
    // The already-applied check must not swallow a genuine conflict. It fires
    // only when the project matches THIS job's workspace for every recorded
    // change; a file someone else changed does not match, so it still refuses.
    const run = await worktreeRun();
    const withChanges: WorkspaceRun = {
      ...run,
      changedFiles: [
        { path: "app.js", kind: "modified", baseHash: eolDigest(Buffer.from("const a = 1;\n")) },
      ],
    };
    await fs.writeFile(path.join(run.originalWorkingDir, "app.js"), "SOMEONE ELSE\n", "utf8");
    await git(["add", "-A"], run.originalWorkingDir);
    await git(["commit", "-qm", "theirs"], run.originalWorkingDir);

    const out = await applyWorkspace("job-1700000000072-eeeeeeee", jobDir, withChanges);
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/changed since dispatch/);
    expect(await readNorm(path.join(run.originalWorkingDir, "app.js"))).toBe("SOMEONE ELSE\n");
  });

  it("the refusal does not claim a worktree patch has no common commit", async () => {
    // That clause was emitted on EVERY refusal, including while handling a
    // worktree patch — which does have a common commit. It describes the copy
    // policy, and now only appears there.
    const run = await worktreeRun();
    const withChanges: WorkspaceRun = {
      ...run,
      changedFiles: [
        { path: "app.js", kind: "modified", baseHash: eolDigest(Buffer.from("const a = 1;\n")) },
      ],
    };
    await fs.writeFile(path.join(run.originalWorkingDir, "app.js"), "SOMEONE ELSE\n", "utf8");
    await git(["add", "-A"], run.originalWorkingDir);
    await git(["commit", "-qm", "theirs"], run.originalWorkingDir);

    const out = await applyWorkspace("job-1700000000073-eeeeeeee", jobDir, withChanges);
    expect(out.message).not.toContain("no common commit");
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

describe("a copy job recorded before changed-file tracking", () => {
  // The field has been written since 2026-07-13 and an isolated workspace is
  // pruned after a day, so this run shape can no longer arrive. It used to
  // fall back to `git diff --no-index` across the whole directory pair, with
  // ~170 lines of path normalisation and section filtering to make that
  // output safe to apply. All of it was unreachable, and its own comment
  // still described the copy as living inside the project — untrue since
  // 0.7.0. Deleted; this pins that what replaced it is a refusal, not a
  // crash and not a patch built by some other route.
  it("is refused, naming the workspace so the work can still be recovered by hand", async () => {
    const repo = await makeRepo("legacy");
    const wsRoot = path.join(dir, "legacy-ws");
    const copy = path.join(wsRoot, "workspace");
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, "app.js"), "const a = 9;\n", "utf8");

    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: copy,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      // changedFiles deliberately absent.
    };

    await expect(buildWorkspacePatch(run)).rejects.toThrow(/predates changed-file recording/);
    await expect(buildWorkspacePatch(run)).rejects.toThrow(/legacy-ws/);
    // And the work is still there to be copied out by hand.
    expect(await readNorm(path.join(copy, "app.js"))).toBe("const a = 9;\n");
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
   *
   * The whole-directory comparison that could emit those deletions is gone —
   * the patch is now built from the recorded `changedFiles` alone, so a file
   * the agent never touched cannot appear in it. This keeps the guarantee
   * pinned against the code that runs today rather than the deleted fallback:
   * a project full of excluded directories still yields a patch about one
   * file, and applying it leaves `.git` intact.
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
      changedFiles: [
        { path: "app.js", kind: "modified", baseHash: eolDigest(Buffer.from("const a = 1;\n")) },
      ],
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

describe("a gitignored file the agent wrote", () => {
  /**
   * `git add -A -N` obeys .gitignore; `changedFiles` comes from a filesystem
   * fingerprint and does not. So a worktree job that wrote a gitignored file
   * REPORTED it as applied while the patch never carried it — an acceptance
   * pass measured `applied: true` naming two files with one in the diff.
   *
   * It compounds: the "already applied" guard needs every recorded change
   * present, so it never fires, and the next apply refuses with "changed
   * since dispatch" — blaming the caller for the first apply's own writes.
   */
  async function ignoredRun(): Promise<WorkspaceRun> {
    const repo = await makeRepo("iproj");
    await fs.writeFile(path.join(repo, ".gitignore"), "secret.env\n", "utf8");
    await git(["add", "-A"], repo);
    await git(["commit", "-qm", "ignore"], repo);
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    const wsRoot = path.join(dir, "iws");
    const worktree = path.join(wsRoot, "worktree");
    await fs.mkdir(wsRoot, { recursive: true });
    await git(["worktree", "add", "--detach", "-q", worktree, base], repo);

    await fs.writeFile(path.join(worktree, "app.js"), "const a = 7;\n", "utf8");
    await fs.writeFile(path.join(worktree, "secret.env"), "TOKEN=abc\n", "utf8");

    return {
      policy: "git_worktree",
      originalWorkingDir: repo,
      effectiveWorkingDir: worktree,
      workspaceRoot: wsRoot,
      baseCommit: base,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [
        { path: "app.js", kind: "modified" },
        { path: "secret.env", kind: "added" },
      ],
    } as WorkspaceRun;
  }

  it("appears in the patch rather than being dropped", async () => {
    const patch = await buildWorkspacePatch(await ignoredRun());
    expect(patch).toContain("secret.env");
    expect(patch).toContain("TOKEN=abc");
  });

  it("actually lands when apply reports it applied", async () => {
    const run = await ignoredRun();
    const result = await applyWorkspace("job-1700000000801-aaaaaaaa", jobDir, run);
    expect(result.applied, result.message).toBe(true);
    // The whole point: the file named in the result exists in the project.
    expect(existsSync(path.join(run.originalWorkingDir, "secret.env"))).toBe(true);
  });

  it("recognises its own work on a second apply instead of blaming the caller", async () => {
    const run = await ignoredRun();
    await applyWorkspace("job-1700000000802-bbbbbbbb", jobDir, run);
    const second = await applyWorkspace("job-1700000000802-bbbbbbbb", jobDir, run);
    expect(second.message).toContain("Already applied");
    expect(second.message).not.toContain("changed since dispatch");
  });
});

describe("discarding a workspace that is already gone", () => {
  /**
   * `discardWorkspace` early-returned "Already gone" when the root had
   * vanished — skipping the block that removes the worktree THROUGH GIT. So a
   * workspace pruned by retention, or deleted by hand, left
   * `.git/worktrees/<name>` registered in the user's repo permanently. The
   * function's own docblock says worktrees are removed through git for
   * exactly this reason.
   *
   * Reproduced: `git worktree list` still showing the path, marked
   * `prunable`, after discard answered `discarded: true`.
   */
  it("still clears the registration git is holding", async () => {
    const repo = await makeRepo("pproj");
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    const wsRoot = path.join(dir, "pws");
    const worktree = path.join(wsRoot, "worktree");
    await fs.mkdir(wsRoot, { recursive: true });
    await git(["worktree", "add", "--detach", "-q", worktree, base], repo);

    // Retention pruned the workspace, or a user deleted it.
    await fs.rm(wsRoot, { recursive: true, force: true });

    const run: WorkspaceRun = {
      policy: "git_worktree",
      originalWorkingDir: repo,
      effectiveWorkingDir: worktree,
      workspaceRoot: wsRoot,
      baseCommit: base,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    };
    const res = await discardWorkspace("job-1700000000031-aaaaaaaa", run);
    expect(res.discarded).toBe(true);

    const list = (await git(["worktree", "list"], repo)).stdout;
    expect(list).not.toContain("prunable");
    expect(existsSync(path.join(repo, ".git", "worktrees", "worktree"))).toBe(false);
  });

  it("does not fail the discard when the project is not a git repo", async () => {
    // Best-effort: a missing repo or git binary must not turn a successful
    // discard into a failure.
    const plain = path.join(dir, "plainproj");
    await fs.mkdir(plain, { recursive: true });
    const wsRoot = path.join(dir, "gone-ws");
    const res = await discardWorkspace("job-1700000000032-bbbbbbbb", {
      policy: "git_worktree",
      originalWorkingDir: plain,
      effectiveWorkingDir: path.join(wsRoot, "worktree"),
      workspaceRoot: wsRoot,
      baseCommit: "deadbeef",
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
    } as WorkspaceRun);
    expect(res.discarded).toBe(true);
  });
});

describe("a patch too large to return", () => {
  /**
   * MAX_PATCH_BYTES documents itself as bounding patches because they are
   * "read into memory and returned over MCP". Two different limits turned out
   * to be involved, and the first version of this test proved the wrong one:
   *
   *   PER FILE — the copy path diffs each file with execFile's maxBuffer set
   *     to MAX_PATCH_BYTES, so one enormous file was already refused. That
   *     refusal surfaced as `stdout maxBuffer length exceeded`, which says
   *     nothing about patches or limits, and now carries a real message.
   *   IN TOTAL — the per-file sections are concatenated with no bound at all,
   *     so MANY files each comfortably under the limit still built an
   *     unbounded patch. That is the gap, and it needs several medium files
   *     to reach: a single huge one trips the per-file buffer first and never
   *     gets here. Sabotaging the accumulation check with a one-big-file
   *     fixture left every test passing.
   */
  it("refuses when many files together exceed the limit, not just one huge one", async () => {
    const repo = await makeRepo("bigproj");
    const wsRoot = path.join(dir, "bigws");
    const workspace = path.join(wsRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.cp(repo, workspace, { recursive: true });

    // Six files at ~500KB: each far under MAX_PATCH_BYTES, together over it.
    const chunk = "x".repeat(500 * 1024);
    const changed = [];
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(workspace, `part-${i}.txt`), chunk, "utf8");
      changed.push({ path: `part-${i}.txt`, kind: "added" as const });
    }

    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: workspace,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: changed,
    };

    await expect(buildWorkspacePatch(run)).rejects.toThrow(/patch limit/);
    // The reassurance matters as much as the refusal: nothing was applied,
    // nothing was deleted, and the work is still retrievable by hand.
    await expect(buildWorkspacePatch(run)).rejects.toThrow(/still in/);
  }, 60_000);

  it("builds a normal patch when the total is under the limit", async () => {
    // Guards the bound against firing on ordinary work.
    const repo = await makeRepo("smallproj");
    const wsRoot = path.join(dir, "smallws");
    const workspace = path.join(wsRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.cp(repo, workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "app.js"), "const a = 5;" + String.fromCharCode(10), "utf8");

    const patch = await buildWorkspacePatch({
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: workspace,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "app.js", kind: "modified" }],
    } as WorkspaceRun);
    expect(patch).toContain("app.js");
  }, 30_000);
});

describe("the worktree path explains its own limit", () => {
  /**
   * The worktree patch is one `git diff`, bounded by execFile's maxBuffer.
   * Hitting it produced `stdout maxBuffer length exceeded` — no mention of
   * patches, limits, or the work still being safe on disk, for a user whose
   * agent simply wrote a lot. Sabotaging this message left every other test
   * passing, which is why it gets one of its own.
   */
  it("says what the limit is and where the work still is", async () => {
    const repo = await makeRepo("wtbig");
    const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    const wsRoot = path.join(dir, "wtbigws");
    const worktree = path.join(wsRoot, "worktree");
    await fs.mkdir(wsRoot, { recursive: true });
    await git(["worktree", "add", "--detach", "-q", worktree, base], repo);

    // One file past the whole-diff budget.
    await fs.writeFile(
      path.join(worktree, "huge.txt"),
      "y".repeat(MAX_PATCH_BYTES + 64 * 1024),
      "utf8",
    );

    const run: WorkspaceRun = {
      policy: "git_worktree",
      originalWorkingDir: repo,
      effectiveWorkingDir: worktree,
      workspaceRoot: wsRoot,
      baseCommit: base,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "huge.txt", kind: "added" }],
    };

    await expect(buildWorkspacePatch(run)).rejects.toThrow(/patch limit/);
    await expect(buildWorkspacePatch(run)).rejects.toThrow(/still in/);
    await expect(buildWorkspacePatch(run)).rejects.not.toThrow(/maxBuffer/);
  }, 60_000);
});

describe("the size refusal names the right directory", () => {
  /**
   * The copy path's per-file refusal came from `git()`, which only knows the
   * cwd it was handed — the PARENT OF THE PROJECT on that path, not the
   * workspace. So it told the reader their work was somewhere it is not,
   * which is worse than saying nothing: the named directory exists.
   */
  it("points at the workspace, not the project's parent", async () => {
    const repo = await makeRepo("dirproj");
    const wsRoot = path.join(dir, "dirws");
    const workspace = path.join(wsRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.cp(repo, workspace, { recursive: true });
    // One file over the per-file execFile buffer, which is the branch that
    // used to interpolate the wrong cwd.
    await fs.writeFile(path.join(workspace, "huge.txt"), "z".repeat(MAX_PATCH_BYTES + 4096), "utf8");

    const run: WorkspaceRun = {
      policy: "copy",
      originalWorkingDir: repo,
      effectiveWorkingDir: workspace,
      workspaceRoot: wsRoot,
      isolated: true,
      securityBoundary: "project_state_and_process_cwd",
      changedFiles: [{ path: "huge.txt", kind: "added" }],
    };

    const err = await buildWorkspacePatch(run).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("patch limit");
    expect(message).toContain(workspace);
    expect(message, "named the project's parent instead").not.toContain(
      `still in ${path.dirname(repo)}\n`,
    );
  }, 60_000);
});
