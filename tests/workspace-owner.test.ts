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
 * Drives the real prepareWorkspace/finish path, as workspace-matrix does, so
 * the owner is recorded the way a dispatch records it.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discardWorkspace } from "../src/workspace-resolve.js";
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
