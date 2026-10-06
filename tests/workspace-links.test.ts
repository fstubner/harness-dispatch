/**
 * Removing a workspace never reaches through a link inside it.
 *
 * On Windows `git worktree remove --force` treats a directory junction as an
 * ordinary directory: it walks INTO it and deletes the target's contents
 * before removing the junction itself (measured, Git 2.45.1.windows.1: a
 * folder outside the workspace went from one file to none). A junction needs
 * no privilege to create, so a delegate that only writes files inside its
 * worktree could empty any folder the user can write. The fingerprint that
 * guards discard skips links, so it saw no change and did not object.
 *
 * Elsewhere the fixture plants a directory symlink instead, the nearest
 * equivalent; the failure was measured on Windows only.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, promises as fs, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discardWorkspace } from "../src/workspace-resolve.js";
import { prepareWorkspace } from "../src/workspaces.js";
import type { DispatchResult } from "../src/types.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const execFile = promisify(execFileCb);
const git = async (args: string[], cwd: string) =>
  String((await execFile("git", args, { cwd, windowsHide: true })).stdout);

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-links-")));
  vi.stubEnv("HARNESS_DISPATCH_WORKSPACES_DIR", path.join(root, "ws-home"));
  // The folder a planted link points at: the user's, outside every workspace.
  outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "the user's file\n");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function makeRepo(): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@example.test"], repo);
  await git(["config", "user.name", "T"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  // Ignored, so the failed-attempt cleanup below sees nothing to keep.
  await fs.writeFile(path.join(repo, ".gitignore"), "linked\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "initial"], repo);
  return repo;
}

/** What a delegate can do with file writes alone: a junction needs no privilege on Windows. */
function plantLink(dir: string): void {
  symlinkSync(outside, path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
}

const result = (success: boolean): DispatchResult => ({ output: "", service: "t", success });

describe("removing a workspace leaves the target of a link inside it alone", () => {
  it("discard", async () => {
    const repo = await makeRepo();
    const ws = await prepareWorkspace({
      routeName: "d",
      policy: "git_worktree",
      workingDir: repo,
      files: [],
      jobId: "job-1700000000001-aaaaaaaa",
    });
    plantLink(ws.effectiveWorkingDir);
    const run = (await ws.finish(result(true))).workspace!;

    const discarded = await discardWorkspace("job-1700000000001-aaaaaaaa", run);

    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    expect(discarded.discarded).toBe(true);
    expect(existsSync(run.workspaceRoot!)).toBe(false);
  });

  it("retention prune", async () => {
    vi.stubEnv("HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS", "1500");
    const repo = await makeRepo();
    const old = await prepareWorkspace({ routeName: "old", policy: "git_worktree", workingDir: repo, files: [] });
    plantLink(old.effectiveWorkingDir);
    await old.finish(result(true));
    const aged = new Date(Date.now() - 10_000);
    await fs.utimes(old.workspaceRoot!, aged, aged);

    // The next dispatch in the same project prunes the aged run.
    const next = await prepareWorkspace({ routeName: "next", policy: "git_worktree", workingDir: repo, files: [] });

    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    expect(existsSync(old.workspaceRoot!), "the aged run was not pruned").toBe(false);
    await next.finish(result(true));
  });

  it("cleanup of a failed attempt that changed nothing", async () => {
    const repo = await makeRepo();
    const ws = await prepareWorkspace({ routeName: "f", policy: "git_worktree", workingDir: repo, files: [] });
    plantLink(ws.effectiveWorkingDir);

    const finished = await ws.finish(result(false));

    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    expect(finished.workspace?.notes?.join(" ")).toMatch(/unregistered and removed/);
    expect(existsSync(ws.workspaceRoot!)).toBe(false);
  });
});
