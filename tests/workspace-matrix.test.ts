/**
 * Every isolated dispatch shape, end to end, against the real product.
 *
 * WHY THIS FILE EXISTS. The workspace lifecycle produced a defect in eight
 * consecutive acceptance passes, and the same thing went wrong every time: a
 * change to patch generation or apply was tested against the ONE case it was
 * written for and shipped without the others.
 *
 *   0.7.0  applying from the repo root was right for git_worktree and wrong
 *          for copy — in a monorepo it edited and deleted same-named files at
 *          the root and reported success. Covered here by the SUBDIRECTORY
 *          column, which did not exist for copy.
 *   0.7.2  the per-file rewrite nulled both sides of a deleted file, so no
 *          copy patch ever carried a deletion. Covered here by the DELETED
 *          and RENAMED rows, which did not exist at all.
 *
 * Both were found by an outside reviewer building this matrix by hand, after
 * release. It belongs in the suite, where it runs on every change and cannot
 * be skipped by only testing what the author happened to be thinking about.
 *
 * TWO RULES THIS FILE FOLLOWS, both learned from the misses above:
 *
 * 1. It drives the REAL prepareWorkspace/finish path rather than hand-building
 *    a WorkspaceRun. Hand-built fixtures are where the coverage illusion came
 *    from — they cannot catch a bug in how changedFiles or its base digest is
 *    recorded, because the test writes those itself.
 * 2. It asserts on the USER'S PROJECT ON DISK, never on what the tool reports.
 *    Every one of these defects reported success.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyWorkspace, discardWorkspace, workspaceDiff } from "../src/workspace-resolve.js";
import { prepareWorkspace } from "../src/workspaces.js";
import type { DispatchResult, WorkspacePolicy, WorkspaceRun } from "../src/types.js";

const execFile = promisify(execFileCb);
const git = (args: string[], cwd: string) => execFile("git", args, { cwd, windowsHide: true });

let root: string;
let wsHome: string;
let jobDir: string;
let savedWorkspacesDir: string | undefined;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hr-matrix-")));
  wsHome = path.join(root, "ws-home");
  jobDir = path.join(root, "job");
  await fs.mkdir(path.join(jobDir, "output"), { recursive: true });
  // Pinned, so a test can never reach a real workspace on this machine.
  savedWorkspacesDir = process.env["HARNESS_DISPATCH_WORKSPACES_DIR"];
  process.env["HARNESS_DISPATCH_WORKSPACES_DIR"] = wsHome;
});

afterEach(async () => {
  if (savedWorkspacesDir === undefined) delete process.env["HARNESS_DISPATCH_WORKSPACES_DIR"];
  else process.env["HARNESS_DISPATCH_WORKSPACES_DIR"] = savedWorkspacesDir;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * A committed repo with the same three filenames at the root AND in `pkg/`.
 *
 * The duplicate names are the point. A patch applied at the wrong base still
 * finds a file to hit, so identical names at both levels are what turns "the
 * change landed somewhere" into "the change landed in the right place" — the
 * 0.7.0 regression passed every test that used distinct names.
 */
async function makeRepo(): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "pkg"), { recursive: true });
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@example.test"], repo);
  await git(["config", "user.name", "Matrix"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  for (const dir of [repo, path.join(repo, "pkg")]) {
    const where = dir === repo ? "ROOT" : "PKG";
    await fs.writeFile(path.join(dir, "edit-me.txt"), `${where} original\n`, "utf8");
    await fs.writeFile(path.join(dir, "remove-me.txt"), `${where} doomed\n`, "utf8");
    await fs.writeFile(path.join(dir, "rename-me.txt"), `${where} to be renamed\n`, "utf8");
  }
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "initial"], repo);
  return repo;
}

type Kind = "modified" | "created" | "deleted" | "renamed";

/** What an agent does inside its workspace, per change kind. */
async function actAsAgent(workDir: string, kind: Kind): Promise<void> {
  switch (kind) {
    case "modified":
      await fs.writeFile(path.join(workDir, "edit-me.txt"), "AGENT EDITED\n", "utf8");
      return;
    case "created":
      await fs.writeFile(path.join(workDir, "brand-new.txt"), "AGENT CREATED\n", "utf8");
      return;
    case "deleted":
      await fs.rm(path.join(workDir, "remove-me.txt"));
      return;
    case "renamed":
      await fs.rename(path.join(workDir, "rename-me.txt"), path.join(workDir, "renamed.txt"));
      return;
  }
}

/** What the PROJECT must look like afterwards, as [relative path, content|null]. */
function expectedAfterApply(kind: Kind): Array<[string, string | null]> {
  switch (kind) {
    case "modified":
      return [["edit-me.txt", "AGENT EDITED\n"]];
    case "created":
      return [["brand-new.txt", "AGENT CREATED\n"]];
    case "deleted":
      return [["remove-me.txt", null]];
    case "renamed":
      return [
        ["rename-me.txt", null],
        ["renamed.txt", null], // content asserted loosely: only presence matters
      ];
  }
}

async function readNorm(file: string): Promise<string | null> {
  const text = await fs.readFile(file, "utf8").catch(() => null);
  return text === null ? null : text.split("\r\n").join("\n");
}

const ok = (): DispatchResult => ({ output: "done", service: "matrix", success: true });

const POLICIES: WorkspacePolicy[] = ["copy", "git_worktree"];
const LOCATIONS = ["repo root", "subdirectory"] as const;
const KINDS: Kind[] = ["modified", "created", "deleted", "renamed"];

const cases = POLICIES.flatMap((policy) =>
  LOCATIONS.flatMap((location) => KINDS.map((kind) => ({ policy, location, kind }))),
);

describe("isolated workspace lifecycle — every policy x location x change kind", () => {
  it.each(cases)("$policy, $location, $kind", async ({ policy, location, kind }) => {
    const repo = await makeRepo();
    const workingDir = location === "repo root" ? repo : path.join(repo, "pkg");
    // The level the change must NOT touch.
    const otherDir = location === "repo root" ? path.join(repo, "pkg") : repo;

    const prepared = await prepareWorkspace({ routeName: "matrix", policy, workingDir, files: [] });
    expect(prepared.isolated, `${policy} did not isolate`).toBe(true);
    await actAsAgent(prepared.effectiveWorkingDir, kind);

    const finished = await prepared.finish(ok());
    const run = finished.workspace as WorkspaceRun;
    expect(run, "finish() attached no workspace record").toBeDefined();

    // 1. ISOLATION: the project has not moved yet, whatever the agent did.
    expect(await readNorm(path.join(workingDir, "edit-me.txt"))).toBe(
      `${location === "repo root" ? "ROOT" : "PKG"} original\n`,
    );
    expect(existsSync(path.join(workingDir, "remove-me.txt"))).toBe(true);
    expect(existsSync(path.join(workingDir, "brand-new.txt"))).toBe(false);

    // 2. DIFF is non-empty and names the file the agent touched.
    const diff = await workspaceDiff("job-1700000000060-aabbccdd", jobDir, run);
    expect(diff.bytes, `empty patch for a ${kind} under ${policy}:\n${diff.patch}`).toBeGreaterThan(
      0,
    );

    // 3. APPLY lands it.
    const applied = await applyWorkspace("job-1700000000060-aabbccdd", jobDir, run);
    expect(applied.applied, applied.message).toBe(true);

    // 4. The PROJECT on disk is what it should be — at the right level.
    for (const [rel, content] of expectedAfterApply(kind)) {
      const actual = await readNorm(path.join(workingDir, rel));
      if (content === null && rel.startsWith("rename")) {
        // rename-me.txt must be gone; renamed.txt must exist.
        if (rel === "rename-me.txt") expect(actual, "the rename left the old name").toBeNull();
        else expect(actual, "the rename did not produce the new name").not.toBeNull();
        continue;
      }
      if (content === null) expect(actual, `${rel} should be gone`).toBeNull();
      else expect(actual, `${rel} did not land`).toBe(content);
    }

    // 5. THE OTHER LEVEL IS UNTOUCHED. This is the assertion the 0.7.0
    //    regression needed and no test had: a patch applied at the wrong base
    //    edits and deletes the same-named files one directory up.
    const otherLabel = location === "repo root" ? "PKG" : "ROOT";
    expect(
      await readNorm(path.join(otherDir, "edit-me.txt")),
      "a file outside the dispatch's working directory was modified",
    ).toBe(`${otherLabel} original\n`);
    expect(
      existsSync(path.join(otherDir, "remove-me.txt")),
      "a file outside the dispatch's working directory was deleted",
    ).toBe(true);
    expect(
      existsSync(path.join(otherDir, "rename-me.txt")),
      "a file outside the dispatch's working directory was renamed away",
    ).toBe(true);
    expect(
      existsSync(path.join(otherDir, "brand-new.txt")),
      "a file was created outside the dispatch's working directory",
    ).toBe(false);

    // 6. DISCARD cleans up and leaves the applied work in place.
    const discarded = await discardWorkspace("job-1700000000060-aabbccdd", run);
    expect(discarded.discarded, discarded.message).toBe(true);
    expect(existsSync(run.workspaceRoot!)).toBe(false);
    for (const [rel, content] of expectedAfterApply(kind)) {
      if (content === null) continue;
      expect(await readNorm(path.join(workingDir, rel)), `${rel} was undone by discard`).toBe(
        content,
      );
    }
    // A worktree must be gone from git's registry too, not just from disk.
    if (policy === "git_worktree") {
      const { stdout } = await git(["worktree", "list"], repo);
      expect(String(stdout)).not.toContain("worktree");
    }
  }, 60_000);
});
