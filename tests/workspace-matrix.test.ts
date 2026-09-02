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

import { execFileSync } from "node:child_process";
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

/**
 * What the PROJECT must look like afterwards, as [relative path, content], with
 * `null` meaning the file must NOT exist.
 *
 * Every kind names both what must appear and what must be gone, so there is no
 * expectation that can be satisfied by doing nothing.
 */
function expectedAfterApply(kind: Kind, label: "ROOT" | "PKG"): Array<[string, string | null]> {
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
        ["renamed.txt", `${label} to be renamed\n`], // content carried by the rename
      ];
  }
}

/** The filenames a patch for this kind must mention. */
function touchedBy(kind: Kind): string[] {
  switch (kind) {
    case "modified":
      return ["edit-me.txt"];
    case "created":
      return ["brand-new.txt"];
    case "deleted":
      return ["remove-me.txt"];
    case "renamed":
      return ["rename-me.txt", "renamed.txt"];
  }
}

/**
 * Assert the project matches, absences included.
 *
 * Shared by the post-apply and post-discard checks precisely so the two cannot
 * drift: the post-discard version once skipped every expectation whose value
 * was `null`, which silently excused the DELETED and RENAMED rows from being
 * checked at all.
 */
async function assertProjectMatches(
  workingDir: string,
  kind: Kind,
  label: "ROOT" | "PKG",
  when: string,
): Promise<void> {
  for (const [rel, content] of expectedAfterApply(kind, label)) {
    const actual = await readNorm(path.join(workingDir, rel));
    if (content === null) {
      expect(actual, `${when}: ${rel} should not exist`).toBeNull();
    } else {
      expect(actual, `${when}: ${rel} has the wrong content`).toBe(content);
    }
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
    const hereLabel = location === "repo root" ? ("ROOT" as const) : ("PKG" as const);

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

    // 2. DIFF is non-empty AND names the file the agent touched.
    //
    // `bytes > 0` alone was the whole assertion here once, under a comment
    // claiming this much — which is the failure this file exists to prevent,
    // committed in the file itself. A patch of the wrong file is non-empty.
    const diff = await workspaceDiff("job-1700000000060-aabbccdd", jobDir, run);
    expect(diff.bytes, `empty patch for a ${kind} under ${policy}:\n${diff.patch}`).toBeGreaterThan(
      0,
    );
    for (const named of touchedBy(kind)) {
      expect(diff.patch, `patch does not mention ${named}:\n${diff.patch}`).toContain(named);
    }

    // 3. APPLY lands it.
    const applied = await applyWorkspace("job-1700000000060-aabbccdd", jobDir, run);
    expect(applied.applied, applied.message).toBe(true);

    // 4. The PROJECT on disk is what it should be — at the right level.
    await assertProjectMatches(workingDir, kind, hereLabel, "after apply");

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
    //
    // Every expectation is re-checked, INCLUDING the ones whose expected state
    // is absence. `if (content === null) continue;` used to skip exactly those,
    // so the DELETED and RENAMED rows verified nothing after discard at all —
    // a discard that resurrected a deleted file passed. The rows that assert a
    // file is GONE are the ones a resurrection bug would show up in, so
    // skipping them removed the only cases that could catch it.
    const discarded = await discardWorkspace("job-1700000000060-aabbccdd", run);
    expect(discarded.discarded, discarded.message).toBe(true);
    expect(existsSync(run.workspaceRoot!)).toBe(false);
    await assertProjectMatches(workingDir, kind, hereLabel, "after discard");
    // A worktree must be gone from git's registry too, not just from disk.
    if (policy === "git_worktree") {
      const { stdout } = await git(["worktree", "list"], repo);
      expect(String(stdout)).not.toContain("worktree");
    }
  }, 60_000);
});

describe("git_worktree cleanup on a failed attempt", () => {
  it("unregisters a worktree when the attempt failed and changed nothing", async () => {
    // A worktree is a registration inside the USER's repository, and retention
    // deliberately never removes one (unregistering needs git, and only the
    // owning repo can do it). So a failed attempt leaves one behind forever —
    // and a failed FALLBACK arm is not named in the response at all, so its
    // worktree has no cleanup hint anywhere. An acceptance pass measured one
    // HTTP request leaving two entries in `git worktree list`.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hd-wt-fail-"));
    await execFile("git", ["init", "-q"], { cwd: repo });
    await execFile("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execFile("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "one\n", "utf8");
    await execFile("git", ["add", "-A"], { cwd: repo });
    await execFile("git", ["commit", "-qm", "initial"], { cwd: repo });

    const wsHome = await fs.mkdtemp(path.join(os.tmpdir(), "hd-wt-home-"));
    const prevDir = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = wsHome;
    try {
      const prepared = await prepareWorkspace({
        routeName: "alpha",
        policy: "git_worktree",
        workingDir: repo,
        files: [],
      });

      const listed = async (): Promise<string> =>
        (await execFile("git", ["worktree", "list"], { cwd: repo })).stdout;
      expect(await listed(), "worktree was not registered").toContain("worktree");

      // The attempt fails without touching a file — the fallback-arm case.
      await prepared.finish({ output: "", service: "alpha", success: false, error: "boom" });

      const after = await listed();
      expect(
        after.split("\n").filter((l) => l.trim() !== "").length,
        `a failed attempt left a worktree registered:\n${after}`,
      ).toBe(1);
      expect(existsSync(prepared.workspaceRoot!)).toBe(false);
    } finally {
      if (prevDir === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = prevDir;
      await fs.rm(wsHome, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);
});

describe("git_worktree cleanup when git refuses", () => {
  it("keeps the directory and does not claim it was unregistered", async () => {
    // The first version swallowed a failed `git worktree remove`, deleted the
    // directory anyway, and reported "unregistered and removed" either way —
    // stranding .git/worktrees/<name> inside the user's repository, the exact
    // outcome the surrounding code says it refuses to cause, while telling
    // them it did not happen. An acceptance pass forced the failure with
    // `git worktree lock`, which makes a single --force insufficient.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hd-wt-lock-"));
    await execFile("git", ["init", "-q"], { cwd: repo });
    await execFile("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execFile("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "one\n", "utf8");
    await execFile("git", ["add", "-A"], { cwd: repo });
    await execFile("git", ["commit", "-qm", "initial"], { cwd: repo });

    const wsHome = await fs.mkdtemp(path.join(os.tmpdir(), "hd-wt-lockhome-"));
    const prevDir = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR = wsHome;
    try {
      const prepared = await prepareWorkspace({
        routeName: "alpha",
        policy: "git_worktree",
        workingDir: repo,
        files: [],
      });
      const worktreeRoot = path.join(prepared.workspaceRoot!, "worktree");
      await execFile("git", ["worktree", "lock", worktreeRoot], { cwd: repo });

      const finished = await prepared.finish({
        output: "",
        service: "alpha",
        success: false,
        error: "boom",
      });

      // Kept, because git still owns it.
      expect(existsSync(prepared.workspaceRoot!), "directory deleted while git still owned it").toBe(
        true,
      );
      const notes = JSON.stringify(finished.workspace?.notes ?? []);
      expect(notes, "claimed removal that did not happen").not.toContain("unregistered and removed");
      expect(finished.workspace?.workspaceRoot, "no path to clean up by hand").toBeDefined();

      await execFile("git", ["worktree", "unlock", worktreeRoot], { cwd: repo }).catch(
        () => undefined,
      );
    } finally {
      if (prevDir === undefined) delete process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
      else process.env.HARNESS_DISPATCH_WORKSPACES_DIR = prevDir;
      await fs.rm(wsHome, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);

  it("a copy workspace SAYS which directories it left out", async () => {
    // EXCLUDED_DIRS drops bin, dist, build, target, obj and .venv, and said
    // nothing about it. Those are build output in most projects and real
    // SOURCE in some — an acceptance pass watched a delegate "edit" a
    // committed bin/tool.sh that was never in its workspace, then saw the run
    // report one changed file, the patch hold one file, and apply land one
    // file, with no surface mentioning the omission. The agent also reasons
    // from a tree it was never told was incomplete.
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "bin"), { recursive: true });
    await fs.writeFile(path.join(repo, "bin", "tool.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await git(["add", "-A"], repo);
    await git(["commit", "-qm", "add bin"], repo);

    const prepared = await prepareWorkspace({
      routeName: "excl",
      policy: "copy",
      workingDir: repo,
      files: [],
    });
    try {
      expect(existsSync(path.join(prepared.effectiveWorkingDir, "bin", "tool.sh"))).toBe(false);
      const finished = await prepared.finish(ok());
      const notes = JSON.stringify(finished.workspace?.notes ?? []);
      expect(notes, "the omission was silent").toContain("bin");
      expect(notes).toContain("NOT copied into the workspace");
    } finally {
      await fs.rm(prepared.workspaceRoot!, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);

  it("says nothing about exclusions when there were none", async () => {
    // The note must not appear on an ordinary project with no excluded
    // directories present — a warning on every run is a warning nobody reads,
    // and `.git` is excluded on every single copy.
    const repo = await makeRepo();
    const prepared = await prepareWorkspace({
      routeName: "excl-none",
      policy: "copy",
      workingDir: repo,
      files: [],
    });
    try {
      const finished = await prepared.finish(ok());
      const notes = JSON.stringify(finished.workspace?.notes ?? []);
      expect(notes).not.toContain("NOT copied into the workspace");
    } finally {
      await fs.rm(prepared.workspaceRoot!, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);
});

describe("an isolated workspace is not world-readable", () => {
  /**
   * A `copy` workspace holds a full copy of the user's source, and the default
   * base is in the SHARED os.tmpdir() — so on a multi-user POSIX machine it
   * was readable by everyone, while the job directory holding the same
   * project's prompt was 0700 and its files 0600. This module was the only one
   * in the family with no mode set at all.
   *
   * Asserted on the PER-PROJECT root, which is the directory the fix creates.
   * The run directory beneath it is made by copyTree's recursive mkdir and
   * keeps the default mode — which is fine, and deliberately not changed: a
   * 0700 ancestor already stops another user traversing in, so tightening
   * every copied directory would be belt-and-braces on a throwaway tree.
   * Asserting on the run directory instead would have pinned something the
   * fix does not do.
   *
   * POSIX only: Windows ignores mode, which is why this could not be verified
   * on the maintainer's machine and runs in CI instead.
   */
  it.skipIf(process.platform === "win32")(
    "creates its root 0700, like the job and state directories",
    async () => {
      const { prepareWorkspace, workspaceRootFor } = await import("../src/workspaces.js");
      const project = path.join(root, "permproj");
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, "a.txt"), "secret source" + String.fromCharCode(10), "utf8");

      await prepareWorkspace({
        policy: "copy",
        workingDir: project,
        files: [],
        routeName: "r",
      });

      const projectWsRoot = workspaceRootFor(project);
      const mode = (await fs.stat(projectWsRoot)).mode & 0o777;
      expect(mode & 0o077, `workspace root is ${mode.toString(8)}`).toBe(0);
    },
  );
});

describe("an existing workspace root is brought up to 0700", () => {
  /**
   * The `mode:` option on `mkdir` applies only to directories it CREATES; it
   * never chmods one that already exists. So the fix that shipped with it did
   * nothing for anyone who had used `copy` before — they kept a 0755 root
   * forever — and its CHANGELOG entry said otherwise. Measured on real Linux:
   * a pre-existing 0755 directory was still 0755 after
   * `mkdir(recursive, 0o700)`.
   *
   * This is the case the original test could not catch, because it only ever
   * exercised a fresh root.
   *
   * POSIX only: Windows ignores mode and `os.tmpdir()` is per-user there.
   */
  it.skipIf(process.platform === "win32")(
    "chmods a root that was created before the fix",
    async () => {
      const { prepareWorkspace, workspaceRootFor } = await import("../src/workspaces.js");
      const project = path.join(root, "oldproj");
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, "a.txt"), "secret source", "utf8");

      // Exactly what a pre-fix run left behind.
      const projectWsRoot = workspaceRootFor(project);
      await fs.mkdir(projectWsRoot, { recursive: true, mode: 0o755 });
      expect((await fs.stat(projectWsRoot)).mode & 0o777).toBe(0o755);

      await prepareWorkspace({
        policy: "copy",
        workingDir: project,
        files: [],
        routeName: "r",
      });

      const mode = (await fs.stat(projectWsRoot)).mode & 0o777;
      expect(mode & 0o077, `root left at ${mode.toString(8)}`).toBe(0);
    },
  );
});

describe("a workspace root that is a symlink", () => {
  /**
   * `secureProjectRoot` used `stat`, which FOLLOWS symlinks, so the uid it
   * compared was the target's rather than the link's. An attacker who owns
   * neither end plants a link at this predictable path pointing at a directory
   * the victim owns, and the ownership check passes against the victim's own
   * uid. Reproduced in a container: the guard did not fire, the victim's
   * directory was chmod'd to 0700, the project was copied into it, and the
   * retention sweep — which ran BEFORE the guard and had no ownership or name
   * check at all — deleted the victim's files.
   *
   * POSIX-only for the ownership half, but the symlink refusal itself is
   * checkable anywhere Node can make a link.
   */
  // BOTH policies. The first version of this test passed `policy: "copy"`
  // only, and the suite stayed green over a live vulnerability: the same
  // attack against `git_worktree` deleted a victim's directory, because the
  // guard ordering and the sweep's name check had been applied to one policy
  // and not the other.
  it.skipIf(process.platform === "win32").each(["copy", "git_worktree"] as const)(
    "is refused rather than followed (%s)",
    async (policy) => {
    const { prepareWorkspace, workspaceRootFor } = await import("../src/workspaces.js");
    const project = path.join(root, `linkproj-${policy}`);
    const elsewhere = path.join(root, `victim-data-${policy}`);
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "important"), { recursive: true });
    await fs.writeFile(path.join(elsewhere, "important", "thesis.txt"), "mine", "utf8");
    await fs.writeFile(path.join(project, "a.txt"), "code", "utf8");
    // git_worktree needs a repo with a commit, or it refuses for THAT reason
    // and never reaches the guard under test.
    if (policy === "git_worktree") {
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: project, stdio: "ignore" });
      run(["init", "-q"]);
      run(["config", "user.email", "t@t"]);
      run(["config", "user.name", "t"]);
      run(["add", "-A"]);
      run(["commit", "-qm", "init"]);
    }

    const projectWsRoot = workspaceRootFor(project);
    await fs.mkdir(path.dirname(projectWsRoot), { recursive: true });
    await fs.symlink(elsewhere, projectWsRoot, "dir");

    await expect(
      prepareWorkspace({ policy, workingDir: project, files: [], routeName: "r" }),
    ).rejects.toThrow(/symbolic link/i);

    // And nothing was written into, or removed from, what it pointed at.
    expect(await fs.readdir(elsewhere)).toEqual(["important"]);
    },
  );

  // WHAT THE ANCHOR RULE ACTUALLY IS, pinned in both directions.
  //
  // A link AT or ABOVE the anchor is allowed when it lands somewhere this user
  // owns — that is not a concession, it is required: `os.tmpdir()` is a
  // symlink on macOS (`/var` -> `/private/var`), so refusing links there
  // refuses every legitimate macOS run. What must be refused is a link
  // landing on a directory owned by SOMEONE ELSE, and a link anywhere BELOW
  // the anchor, which is territory this tool creates and can insist on.
  //
  // The cross-user half needs two real uids and lives in the container
  // verification recorded in acceptance/0.8.0.md; a single-user test cannot
  // express it. This pins the half that is expressible, and pins it in the
  // direction that used to be wrong: an earlier version of this test asserted
  // that ANY link at the base was refused, which would have made the macOS
  // path shape a failure.
  it.skipIf(process.platform === "win32")(
    "allows an anchor reached through a link to a directory we own",
    async () => {
      const { prepareWorkspace, workspacesBase } = await import("../src/workspaces.js");
      const project = path.join(root, "baseproj");
      const realBase = path.join(root, "real-base");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(realBase, { recursive: true });
      await fs.writeFile(path.join(project, "a.txt"), "code", "utf8");

      const base = workspacesBase();
      await fs.rm(base, { recursive: true, force: true });
      await fs.mkdir(path.dirname(base), { recursive: true });
      await fs.symlink(realBase, base, "dir");

      const prepared = await prepareWorkspace({
        policy: "copy",
        workingDir: project,
        files: [],
        routeName: "r",
      });
      expect(existsSync(path.join(prepared.effectiveWorkingDir, "a.txt"))).toBe(true);
      // And it landed through the link, in the directory we own.
      expect(await fs.realpath(prepared.effectiveWorkingDir)).toContain(
        await fs.realpath(realBase),
      );
    },
  );
});
