/**
 * Discard deletes only a workspace that provably belongs to the job asking.
 *
 * The workspace a discard deletes is named by the job's own record on disk.
 * A record edited to name ANOTHER job's run directory (by hand, or by a
 * delegated agent with shell access to the state directory) passed every
 * check discard made: the directory is inside the workspaces directory and is
 * one run, not a directory of runs. So `discard --force` on one job deleted
 * another job's unapplied work. The run directory now records the job that
 * created it, and discard compares that with the job it was asked about.
 *
 * Diff and apply read the same recorded root, so the same edited record made
 * `apply` land ANOTHER job's changes in this job's project. They refuse a
 * workspace owned by another job; unlike discard they allow one with no owner,
 * since refusing would strand pre-upgrade work and apply deletes nothing.
 *
 * Drives the real prepareWorkspace/finish path, as workspace-matrix does, so
 * the owner is recorded the way a dispatch records it.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyWorkspace, discardWorkspace, workspaceDiff } from "../src/workspace-resolve.js";
import { prepareWorkspace } from "../src/workspaces.js";
import type { WorkspacePolicy, WorkspaceRun } from "../src/types.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const execFile = promisify(execFileCb);
const git = (args: string[], cwd: string) => execFile("git", args, { cwd, windowsHide: true });

const OWNER = "job-1700000000100-aaaaaaaa";
const OTHER = "job-1700000000101-bbbbbbbb";

let root: string;
let repo: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hd-ws-owner-")));
  vi.stubEnv("HARNESS_DISPATCH_WORKSPACES_DIR", path.join(root, "ws-home"));
  repo = path.join(root, "proj");
  await fs.mkdir(repo);
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@example.test"], repo);
  await git(["config", "user.name", "Test"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  await fs.writeFile(path.join(repo, "app.js"), "const a = 1;\n", "utf8");
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "initial"], repo);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A finished run of `jobId`; `edit` makes it hold work the project does not have. */
async function finishedRun(policy: WorkspacePolicy, jobId: string, edit: boolean): Promise<WorkspaceRun> {
  const prepared = await prepareWorkspace({ routeName: "r", policy, workingDir: repo, files: [], jobId });
  if (edit) await fs.writeFile(path.join(prepared.effectiveWorkingDir, "app.js"), "const a = 2;\n", "utf8");
  const result = await prepared.finish({ output: "", service: "r", success: true });
  expect(result.workspace?.workspaceRoot).toBeDefined();
  return result.workspace!;
}

describe.each(["copy", "git_worktree"] as const)("%s: discard and the job that owns the workspace", (policy) => {
  it("refuses a record naming another job's workspace, with and without force", async () => {
    const theirs = await finishedRun(policy, OWNER, true);
    // OTHER's record, edited to name OWNER's run directory.
    const tampered: WorkspaceRun = { ...theirs };

    const plain = await discardWorkspace(OTHER, tampered);
    expect(plain.discarded, plain.message).toBe(false);
    const forced = await discardWorkspace(OTHER, tampered, { force: true });
    expect(forced.discarded, forced.message).toBe(false);
    expect(forced.message).toContain(OWNER);

    expect(existsSync(theirs.workspaceRoot!), "the other job's workspace was deleted").toBe(true);
    expect(await fs.readFile(path.join(theirs.effectiveWorkingDir, "app.js"), "utf8")).toBe("const a = 2;\n");
  });

  it("refuses a workspace that records no owner, even with force", async () => {
    // Created before owners were recorded (or by direct library use): it may
    // be any job's, so it is not provably this one's.
    const prepared = await prepareWorkspace({ routeName: "r", policy, workingDir: repo, files: [] });
    const unowned = (await prepared.finish({ output: "", service: "r", success: true })).workspace!;

    const out = await discardWorkspace(OWNER, unowned, { force: true });
    expect(out.discarded, out.message).toBe(false);
    expect(out.message).toMatch(/does not record which job created it/);
    expect(existsSync(unowned.workspaceRoot!)).toBe(true);
  });

  it("still discards the job's own workspace without force", async () => {
    const own = await finishedRun(policy, OWNER, false);
    const out = await discardWorkspace(OWNER, own);
    expect(out.discarded, out.message).toBe(true);
    expect(existsSync(own.workspaceRoot!)).toBe(false);
  });

  it("still discards the job's own unapplied work with force", async () => {
    const own = await finishedRun(policy, OWNER, true);
    const out = await discardWorkspace(OWNER, own, { force: true });
    expect(out.discarded, out.message).toBe(true);
    expect(existsSync(own.workspaceRoot!)).toBe(false);
  });
});

describe.each(["copy", "git_worktree"] as const)("%s: diff and apply and the job that owns the workspace", (policy) => {
  let jobDir: string;
  beforeEach(async () => {
    jobDir = path.join(root, "job-dir");
    await fs.mkdir(jobDir, { recursive: true });
  });

  const projectFile = async () => (await fs.readFile(path.join(repo, "app.js"), "utf8")).replace(/\r\n/g, "\n");

  it("refuses a record naming another job's workspace for diff and apply, with and without force", async () => {
    const theirs = await finishedRun(policy, OWNER, true);
    // OTHER's record, edited to name OWNER's run directory.
    const tampered: WorkspaceRun = { ...theirs };

    await expect(workspaceDiff(OTHER, jobDir, tampered)).rejects.toThrow(OWNER);
    await expect(applyWorkspace(OTHER, jobDir, tampered)).rejects.toThrow(OWNER);
    await expect(applyWorkspace(OTHER, jobDir, tampered, { force: true })).rejects.toThrow(OWNER);

    expect(await projectFile(), "the other job's changes landed in the project").toBe("const a = 1;\n");
  });

  it("applies the job's own workspace", async () => {
    const own = await finishedRun(policy, OWNER, true);
    const diff = await workspaceDiff(OWNER, jobDir, own);
    expect(diff.patch).toContain("app.js");
    const out = await applyWorkspace(OWNER, jobDir, own);
    expect(out.applied, out.message).toBe(true);
    expect(await projectFile()).toBe("const a = 2;\n");
  });

  it("still diffs and applies a workspace that records no owner", async () => {
    // Created before owners were recorded. Discard refuses these; apply must
    // not, or work from before the upgrade could never be landed.
    const prepared = await prepareWorkspace({ routeName: "r", policy, workingDir: repo, files: [] });
    await fs.writeFile(path.join(prepared.effectiveWorkingDir, "app.js"), "const a = 2;\n", "utf8");
    const unowned = (await prepared.finish({ output: "", service: "r", success: true })).workspace!;

    const diff = await workspaceDiff(OWNER, jobDir, unowned);
    expect(diff.patch).toContain("app.js");
    const out = await applyWorkspace(OWNER, jobDir, unowned);
    expect(out.applied, out.message).toBe(true);
    expect(await projectFile()).toBe("const a = 2;\n");
  });
});

