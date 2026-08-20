/**
 * What happens to isolated work AFTER the agent finishes.
 *
 * `copy` and `git_worktree` gave you a workspace path, a changed-file list and
 * a `cleanupHint` — a string telling you to run `git worktree remove`
 * yourself. Isolation worked and nothing was ever applied automatically, but
 * there was no way to see the actual change, no way to keep it, and no way to
 * clean up but by hand. Isolated dispatches were effectively write-only: you
 * could look at a summary and then abandon the result.
 *
 * This module is the missing half — inspect, then keep or throw away.
 *
 * THE DANGEROUS PART IS `apply`, and it is dangerous in one specific way:
 * applying a patch into a directory that has moved on since the agent started
 * can conflict with, or silently overwrite, work the user did in the meantime.
 * So apply refuses when the target has uncommitted changes unless the caller
 * explicitly overrides, and it always writes the patch to disk first so there
 * is a manual path (`git apply`) even when the automatic one declines.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceRun } from "./types.js";
import { EXCLUDED_DIRS } from "./workspaces.js";

const execFile = promisify(execFileCb);

/** Patches are read into memory and returned over MCP, so they are bounded. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** How much of a patch is returned inline before it is truncated for display. */
export const MAX_PATCH_CHARS = 60_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: MAX_PATCH_BYTES,
  });
  return String(stdout);
}

/** `git diff` exits 1 when there ARE differences; that is success, not failure. */
async function gitDiff(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
    throw err;
  }
}

/** The directory the agent actually worked in, for each isolation policy. */
function isolatedRoot(run: WorkspaceRun): string {
  if (run.policy === "git_worktree") return path.join(run.workspaceRoot ?? "", "worktree");
  return run.effectiveWorkingDir;
}

export function isResolvable(run: WorkspaceRun | undefined): run is WorkspaceRun {
  return run !== undefined && run.isolated && run.workspaceRoot !== undefined;
}

/**
 * Produce a unified patch of what the agent changed, relative to the project
 * root, so it applies with `git apply -p1` from `originalWorkingDir`.
 *
 * The two policies need different bases and getting this wrong is destructive:
 *
 *   git_worktree — diff against the COMMIT the worktree was created from.
 *     A worktree starts at HEAD, not at the caller's working tree, so diffing
 *     it against the original directory of a dirty project would report the
 *     user's own uncommitted work as deletions.
 *   copy — diff against the original directory, which is exactly what the
 *     copy was made from, so the difference is the agent's work and nothing
 *     else.
 */
export async function buildWorkspacePatch(run: WorkspaceRun): Promise<string> {
  const root = isolatedRoot(run);
  if (!existsSync(root)) {
    throw new Error(
      `The isolated workspace for this job is gone (${root}). Workspaces are pruned ` +
        `once they age out, so inspect and resolve a job before that happens.`,
    );
  }

  if (run.policy === "git_worktree") {
    if (!run.baseCommit) {
      throw new Error(
        "This worktree job predates base-commit recording, so a safe patch cannot be " +
          "produced — diffing it against a dirty project could report your own " +
          "uncommitted work as deletions. Inspect it by hand at " +
          `${root}, or re-run the dispatch.`,
      );
    }
    // `add -A -N` registers untracked files as intent-to-add so they appear in
    // the diff as additions. It touches only the throwaway worktree's index.
    await git(["add", "-A", "-N"], root).catch(() => undefined);
    return gitDiff(["diff", "--binary", run.baseCommit, "--"], root);
  }

  // --no-index works outside a repository and handles added/deleted files.
  //
  // The paths are handed to git in POSIX form deliberately. Given a Windows
  // path, git quotes the whole filename and escapes the separators as `\\`,
  // so the emitted header reads `"a/C:\\Users\\..."` — and any attempt to
  // normalise that afterwards has to understand C-string escaping. Passing
  // forward slashes means git emits a plain unquoted path that simple prefix
  // stripping can handle.
  const origPosix = toPosix(run.originalWorkingDir);
  const isoPosix = toPosix(root);
  const raw = await gitDiff(
    ["diff", "--no-index", "--binary", "--", origPosix, isoPosix],
    path.dirname(run.originalWorkingDir),
  );
  return dropExcludedSections(normaliseNoIndexPaths(raw, origPosix, isoPosix));
}

/**
 * Remove patch sections for paths the COPY never contained.
 *
 * copyTree skips .git, node_modules and friends, so a plain directory diff
 * reports every one of those files as deleted — and applying that patch would
 * delete the user's repository. The exclusion set is imported from
 * workspaces.ts rather than restated here: two lists would drift, and the
 * failure mode of drifting is destroying a .git directory.
 *
 * Only the `copy` policy needs this. A worktree diff is bounded by a real
 * commit, so it never sees these paths at all.
 */
function dropExcludedSections(patch: string): string {
  if (!patch) return patch;
  const out: string[] = [];
  let skipping = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rel = /^diff --git a\/(\S+)/.exec(line)?.[1] ?? "";
      const top = rel.split("/")[0] ?? "";
      skipping = EXCLUDED_DIRS.has(top);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Rewrite `git diff --no-index` headers so the patch is repo-relative.
 *
 * --no-index emits the absolute paths it was given (`--- a/C:/long/path/...`),
 * which applies nowhere but this machine. Rewriting them to a/<rel> and
 * b/<rel> makes the patch portable and applicable with -p1, which is what
 * every other git patch in the world expects.
 */
function normaliseNoIndexPaths(patch: string, origRoot: string, isoRoot: string): string {
  if (!patch) return patch;
  // Longest first: when one root is a prefix of the other, stripping the
  // shorter one first would leave a fragment of the longer behind.
  const roots = [origRoot, isoRoot].sort((a, b) => b.length - a.length);
  return patch
    .split("\n")
    .map((line) => {
      let out = line;
      for (const r of roots) out = out.split(`${r}/`).join("");
      return out;
    })
    .join("\n");
}

export interface PatchResult {
  jobId: string;
  policy: WorkspaceRun["policy"];
  /** Where the full patch was written, always, so there is a manual path. */
  patchPath: string;
  bytes: number;
  /** Possibly truncated for display; patchPath always holds the whole thing. */
  patch: string;
  truncated: boolean;
  changedFiles?: WorkspaceRun["changedFiles"];
}

/** Build the patch, cache it next to the job, and return it (bounded). */
export async function workspaceDiff(
  jobId: string,
  jobDir: string,
  run: WorkspaceRun,
): Promise<PatchResult> {
  const patch = await buildWorkspacePatch(run);
  const patchPath = path.join(jobDir, "output", "workspace.patch");
  await mkdir(path.dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600 });
  const truncated = patch.length > MAX_PATCH_CHARS;
  return {
    jobId,
    policy: run.policy,
    patchPath,
    bytes: Buffer.byteLength(patch, "utf8"),
    patch: truncated
      ? `${patch.slice(0, MAX_PATCH_CHARS)}\n[... truncated, full patch at ${patchPath}]`
      : patch,
    truncated,
    ...(run.changedFiles !== undefined ? { changedFiles: run.changedFiles } : {}),
  };
}

/** Uncommitted changes in the target, or undefined when it is not a repo. */
async function dirtyPaths(dir: string): Promise<string[] | undefined> {
  try {
    const out = await git(["status", "--porcelain"], dir);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
}

export interface ApplyResult {
  jobId: string;
  applied: boolean;
  patchPath: string;
  message: string;
  changedFiles?: WorkspaceRun["changedFiles"];
}

/**
 * Apply the agent's work into the real project.
 *
 * Refuses by default when the target has uncommitted changes: the patch was
 * built against a specific base, and applying it over work done since can
 * conflict or clobber. `force` overrides, and the patch file is written
 * either way so `git apply` by hand is always available.
 */
export async function applyWorkspace(
  jobId: string,
  jobDir: string,
  run: WorkspaceRun,
  opts: { force?: boolean } = {},
): Promise<ApplyResult> {
  const diff = await workspaceDiff(jobId, jobDir, run);
  if (diff.bytes === 0) {
    return {
      jobId,
      applied: false,
      patchPath: diff.patchPath,
      message: "The agent changed nothing, so there is nothing to apply.",
    };
  }

  const target = run.originalWorkingDir;
  const dirty = await dirtyPaths(target);
  if (dirty !== undefined && dirty.length > 0 && opts.force !== true) {
    return {
      jobId,
      applied: false,
      patchPath: diff.patchPath,
      message:
        `Refused: ${target} has ${dirty.length} uncommitted change(s), and this patch was ` +
        `built against a clean base — applying it could conflict with or overwrite work ` +
        `done since the dispatch started. Commit or stash first, re-run with force: true ` +
        `to apply anyway, or apply by hand: git apply "${diff.patchPath}"`,
    };
  }

  // --3way first: it merges when context has moved instead of failing
  // outright. It needs the pre-image blobs to exist in the target repo, which
  // holds for a worktree patch (same repo, real commit) but NOT for a copy
  // patch — `git diff --no-index` writes index lines for blobs the repo has
  // never seen, so --3way fails with "could not build fake ancestor". Plain
  // apply handles that fine, so the strict-but-smarter mode is an attempt,
  // not a requirement.
  let applyError: string | undefined;
  for (const args of [
    ["apply", "--3way", "--whitespace=nowarn", diff.patchPath],
    ["apply", "--whitespace=nowarn", diff.patchPath],
  ]) {
    try {
      await git(args, target);
      applyError = undefined;
      break;
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }
  }
  if (applyError !== undefined) {
    const firstLine = applyError.split("\n").find((l) => l.includes("error:")) ?? applyError.split("\n")[0];
    return {
      jobId,
      applied: false,
      patchPath: diff.patchPath,
      message:
        `git apply failed: ${firstLine}. The patch is intact at ` +
        `${diff.patchPath} — resolve by hand, or inspect the workspace directly.`,
    };
  }

  return {
    jobId,
    applied: true,
    patchPath: diff.patchPath,
    message: `Applied ${diff.bytes} bytes of changes to ${target}. Review with git diff before committing.`,
    ...(run.changedFiles !== undefined ? { changedFiles: run.changedFiles } : {}),
  };
}

export interface DiscardResult {
  jobId: string;
  discarded: boolean;
  message: string;
}

/**
 * Throw the isolated workspace away.
 *
 * A git worktree is not just a directory: `rm -rf` on it leaves the parent
 * repository's worktree metadata behind, and git then complains about a
 * missing worktree until someone runs `git worktree prune`. So worktrees are
 * removed through git, with a filesystem sweep afterwards for the wrapper
 * directory git does not own.
 */
export async function discardWorkspace(
  jobId: string,
  run: WorkspaceRun,
): Promise<DiscardResult> {
  const root = run.workspaceRoot;
  if (!root) {
    return { jobId, discarded: false, message: "This job has no isolated workspace to discard." };
  }
  if (!existsSync(root)) {
    return { jobId, discarded: true, message: `Already gone: ${root}` };
  }

  if (run.policy === "git_worktree") {
    const worktree = path.join(root, "worktree");
    try {
      await git(["worktree", "remove", "--force", worktree], run.originalWorkingDir);
    } catch {
      // Fall through to the filesystem sweep; prune fixes the metadata.
      await git(["worktree", "prune"], run.originalWorkingDir).catch(() => undefined);
    }
  }

  await rm(root, { recursive: true, force: true });
  return {
    jobId,
    discarded: true,
    message: `Discarded the isolated workspace at ${root}. The original project was never modified.`,
  };
}

/** Read a previously written patch, if one was cached. */
export async function cachedPatch(jobDir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(jobDir, "output", "workspace.patch"), "utf8");
  } catch {
    return undefined;
  }
}
