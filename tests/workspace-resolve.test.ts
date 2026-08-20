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
