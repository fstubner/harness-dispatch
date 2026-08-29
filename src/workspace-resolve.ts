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
import { eolDigest, EXCLUDED_DIRS, GIT_ENV } from "./workspaces.js";

const execFile = promisify(execFileCb);

/** Patches are read into memory and returned over MCP, so they are bounded. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** How much of a patch is returned inline before it is truncated for display. */
export const MAX_PATCH_CHARS = 60_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    windowsHide: true,
    env: GIT_ENV,
    maxBuffer: MAX_PATCH_BYTES,
  });
  return String(stdout);
}

/**
 * `git diff` exits 1 when there ARE differences; that is success, not failure.
 *
 * But exit 1 is NOT exclusively "differences found" — git also uses it for
 * real errors, and the two were indistinguishable here. Observed live on
 * Windows: a copy workspace whose paths crossed MAX_PATH made git exit 1 with
 * an EMPTY stdout and `error: Could not open directory <259-char path>` on
 * stderr. Returning stdout meant an empty patch, which every caller reads as
 * "the agent changed nothing" — the feature could not deliver, and the user
 * was told to file a bug report rather than the actual cause. git's own
 * explanation was discarded at this line and never reached anyone.
 *
 * `error:`/`fatal:` on stderr is the discriminator. Plain `warning:` lines do
 * not count: git emits those routinely for line-ending conversion, and
 * treating them as failure would break every diff on a CRLF checkout.
 */
async function gitDiff(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const failure = stderr
      .split("\n")
      .find((line) => /^\s*(error|fatal):/.test(line))
      ?.trim();
    if (e.code === 1 && typeof e.stdout === "string" && failure === undefined) {
      return e.stdout;
    }
    if (failure !== undefined) {
      // `Could not access` is git's wording when it stats a FILE it cannot
      // reach; `Could not open directory` is the same fault hit while scanning
      // a directory. The first version of this hint pinned only the string
      // that had been observed, so the file variant — which is what an
      // over-long path usually produces — got a bare error with no cause and
      // no remedy, for exactly the case the hint exists to explain.
      const hint =
        /could not open directory|could not access|filename too long|name too long|No such file or directory/i.test(
          failure,
        )
        ? " This is usually a path too long for the platform — on Windows, `git config " +
          "--global core.longpaths true`, or run the dispatch from a shorter directory."
        : "";
      throw new Error(`git could not produce a patch for this workspace: ${failure}.${hint}`);
    }
    throw err;
  }
}

/**
 * stdout AND stderr together. `git apply` writes "Skipped patch 'x'." to
 * stderr while exiting 0, so a stdout-only read cannot see the one line that
 * says it did nothing.
 */
async function gitBoth(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    windowsHide: true,
    env: GIT_ENV,
    maxBuffer: MAX_PATCH_BYTES,
  });
  return `${String(stdout)}\n${String(stderr)}`;
}

/** The repository root containing `dir`, or undefined when it is not a repo. */
async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"], dir);
    const root = out.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
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

  // A copy patch is built FILE BY FILE, from the list of what the agent
  // actually changed — not by comparing the two trees.
  //
  // A tree comparison has no BASE. It diffs the workspace against the project
  // as the project is RIGHT NOW, at apply time, so everything that changed in
  // the project since the copy was taken is proposed for reversal. Reproduced
  // through the documented tool surface: dispatch two isolated jobs, apply the
  // first, COMMIT it, apply the second — and the second silently deleted the
  // first's committed file and reverted its committed line, reporting
  // `applied: true` and a changedFiles list one entry shorter than the patch it
  // had just applied. That is the parallel-delegation case this product is
  // built around, and the refusal on uncommitted changes is not a mitigation:
  // it tells you to commit first, and committing is what walks you into it.
  //
  // The git_worktree branch above never had this, because it diffs against a
  // recorded baseCommit — and its own error text spells the hazard out
  // ("diffing it against a dirty project could report your own uncommitted
  // work as deletions"). The danger was documented for one policy and
  // unguarded in the other.
  //
  // changedFiles is exactly the missing base: fingerprints of the workspace
  // taken at dispatch, compared with fingerprints taken when the agent
  // finished. A file the agent never touched cannot appear in the patch at
  // all now, whatever the project has done since — and the patch and the
  // reported changedFiles are derived from one list, so they cannot disagree.
  if (run.changedFiles !== undefined) {
    return buildCopyPatchFromChanges(run, root, run.changedFiles);
  }

  // Fallback for a job recorded before changedFiles existed. Kept rather than
  // refusing so an upgrade cannot strand an in-flight job; those records age
  // out with the workspace inside a day.
  //
  // The paths are handed to git in POSIX form deliberately. Given a Windows
  // path, git quotes the whole filename and escapes the separators as `\\`,
  // so the emitted header reads `"a/C:\\Users\\..."` — and any attempt to
  // normalise that afterwards has to understand C-string escaping. Passing
  // forward slashes means git emits a plain unquoted path that simple prefix
  // stripping can handle.
  const origPosix = toPosix(run.originalWorkingDir);
  const isoPosix = toPosix(root);
  // --no-renames, and it is load-bearing rather than cosmetic.
  //
  // The copy lives INSIDE the project, so a file the agent CREATED appears on
  // both sides of the comparison with identical content: once as
  // `.harness-dispatch/.../workspace/notes.txt` while git scans the project,
  // and once as `notes.txt` inside the copy. Rename detection paired the two
  // and emitted NOTHING AT ALL for that file — no deletion, no addition — so
  // the patch came back empty, `apply` reported "the agent changed nothing"
  // beside its own list saying the file was added, and `discard` then deleted
  // the only copy of the work. A MODIFIED file was unaffected, which is why
  // this survived three releases of the feature.
  //
  // Disabling rename detection emits the deletion and the addition separately;
  // dropSectionsUnder was already written to strip the former and keep the
  // latter. Nothing else here wants renames: a patch that says "rename" only
  // applies cleanly if the source path is where the patch thinks it is, and on
  // this comparison it never is.
  const raw = await gitDiff(
    ["diff", "--no-index", "--no-renames", "--binary", "--", origPosix, isoPosix],
    path.dirname(run.originalWorkingDir),
  );
  // Order matters: the workspace itself is filtered out on ABSOLUTE paths,
  // before normalisation collapses them.
  const withoutWorkspace = dropSectionsUnder(raw, toPosix(run.workspaceRoot ?? ""));
  return dropExcludedSections(normaliseNoIndexPaths(withoutWorkspace, origPosix, isoPosix));
}

/** git's own name for "this side does not exist", accepted on Windows too. */
const NULL_PATH = "/dev/null";

/**
 * One patch section per recorded change, with headers rewritten to the
 * project-relative path.
 *
 * The headers are REBUILT from the path we already know rather than derived by
 * stripping roots out of git's output. That is what makes it impossible for
 * this step to touch file content: nothing is searched for and replaced, the
 * three header lines are simply replaced with correct ones and every other
 * line — hunks, `index`, mode lines, the content itself — passes through
 * untouched.
 */
async function buildCopyPatchFromChanges(
  run: WorkspaceRun,
  workspace: string,
  changes: ReadonlyArray<{ path: string; kind: string }>,
): Promise<string> {
  const sections: string[] = [];
  for (const change of changes) {
    const rel = change.path.split(path.sep).join("/");
    const projectFile = path.join(run.originalWorkingDir, change.path);
    const workspaceFile = path.join(workspace, change.path);
    const projectHas = existsSync(projectFile);
    const workspaceHas = existsSync(workspaceFile);

    // The LEFT side is what the project has right now, whatever the recorded
    // kind says — an "added" file the project already has is a modification,
    // and after a successful apply it is no change at all. Trusting the kind
    // blindly re-proposed a file the project already held as a fresh addition,
    // so a second apply always found work to do.
    //
    // The RIGHT side is the workspace, EXCEPT for a deletion, where the whole
    // point is that the workspace no longer has it. Nulling both sides for a
    // deletion — which the first version of this did — made the guard below
    // fire every time, so no copy patch ever carried a deletion: a delegate
    // that removed a file had `applied: true` reported over a project where
    // the file was still there, and a delete-only job produced an empty patch
    // that apply refused and discard then refused to clean up. A rename is a
    // delete plus an add, so renames did not land either.
    const left = projectHas ? toPosix(projectFile) : NULL_PATH;
    const right = change.kind === "deleted" || !workspaceHas ? NULL_PATH : toPosix(workspaceFile);

    // Nothing on either side: cannot be diffed. Skipping leaves the patch
    // shorter than changedFiles, which is precisely the state applyWorkspace's
    // guard refuses on — so nothing is lost quietly. For a deletion this is
    // the already-gone case, which is genuinely nothing to do.
    if (left === NULL_PATH && right === NULL_PATH) continue;

    // Already in the project, modulo line endings: emit nothing. `git apply`
    // writes through the repository's eol settings, so an applied file lands
    // as CRLF against an LF workspace copy and a byte comparison would call
    // that a difference forever — a second apply would keep finding work to
    // do. Same rule as the already-applied check, deliberately, so the two
    // cannot disagree about what "landed" means.
    if (left !== NULL_PATH && right !== NULL_PATH) {
      const [a, b] = await Promise.all([
        readFile(projectFile).catch(() => null),
        readFile(workspaceFile).catch(() => null),
      ]);
      if (a !== null && b !== null && (a.equals(b) || normaliseEol(a) === normaliseEol(b))) continue;
    }

    let raw: string;
    try {
      raw = await gitDiff(
        ["diff", "--no-index", "--no-renames", "--binary", "--", left, right],
        path.dirname(run.originalWorkingDir),
      );
    } catch (err) {
      // An unreadable file must not silently shrink the patch — that is the
      // failure mode this whole area keeps producing.
      throw new Error(
        `could not diff ${rel} for this workspace: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw.trim() === "") continue;
    sections.push(rewriteSectionHeaders(raw, rel));
  }
  return sections.join("");
}

/**
 * Replace a section's path headers with the project-relative ones.
 *
 * Only before the first `@@`. Prefix alone is not safe: a REMOVED line whose
 * own text begins `-- ` (an SQL comment, a signature delimiter) arrives as
 * `--- `, and an added line beginning `++ ` arrives as `+++ `. Rewriting those
 * would corrupt content — the same defect this file has already shipped once,
 * from the other direction.
 */
function rewriteSectionHeaders(section: string, rel: string): string {
  let inHunk = false;
  const out = section
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) inHunk = true;
      if (inHunk) return line;
      if (line.startsWith("diff --git ")) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith("--- ")) return line.trim() === `--- ${NULL_PATH}` ? line : `--- a/${rel}`;
      if (line.startsWith("+++ ")) return line.trim() === `+++ ${NULL_PATH}` ? line : `+++ b/${rel}`;
      return line;
    })
    .join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * The directory `changedFiles` paths are relative to, on the PROJECT side.
 *
 * Not always originalWorkingDir, and getting it wrong is silent: a
 * git_worktree's changed files are fingerprinted from the worktree root, which
 * mirrors the REPO root, so a dispatch whose workingDir was `pkg/` records
 * `pkg/edit-me.txt`. Joining that onto `<repo>/pkg` looks for
 * `<repo>/pkg/pkg/edit-me.txt`, finds nothing, and concludes the file is
 * missing. A copy is fingerprinted from the copied directory itself, so there
 * the two coincide.
 *
 * ONE function because this has now been got wrong twice in this file, in two
 * different checks, with the same symptom each time — a guard refusing every
 * apply or discard for a monorepo dispatch. Two callers computing the same
 * base separately is what allowed the second one.
 */
async function projectBaseFor(run: WorkspaceRun): Promise<string> {
  if (run.policy !== "git_worktree") return run.originalWorkingDir;
  return (await repoRoot(run.originalWorkingDir)) ?? run.originalWorkingDir;
}

/**
 * Files the PROJECT has changed since the dispatch started.
 *
 * The conflict detection a `copy` patch cannot get from git. A worktree patch
 * is anchored to a real commit, so `git apply --3way` can see that the target
 * has moved and refuse or merge. A copy patch is generated against the project
 * as it stands at apply time, which means its context always matches — git
 * applies it cleanly and the divergent version is simply overwritten. Two
 * concurrent dispatches touching one file ended with the second silently
 * reverting the first's COMMITTED work, reporting `applied: true`.
 *
 * baseHash is that file as it was when the dispatch started. If the project's
 * copy no longer matches, someone else has been here.
 *
 * Line endings are normalised on both sides: a checkout whose eol settings
 * rewrote the file on the way in has not diverged in any sense the user cares
 * about, and calling that a conflict would refuse every apply on Windows.
 */
async function projectMovedSince(
  run: WorkspaceRun,
  changed: ReadonlyArray<{ path: string; kind: string; baseHash?: string }>,
): Promise<string[]> {
  const base = await projectBaseFor(run);
  const moved: string[] = [];
  for (const change of changed) {
    if (change.baseHash === undefined) continue; // added: no base to compare
    const inProject = path.join(base, change.path);
    const current = await readFile(inProject).catch(() => null);
    if (current === null) {
      // Gone from the project. For a deletion that is the outcome we wanted;
      // for anything else the file the patch edits is no longer there.
      if (change.kind !== "deleted") moved.push(`${change.path} (deleted since dispatch)`);
      continue;
    }
    if (eolDigest(current) !== change.baseHash) moved.push(`${change.path} (changed since dispatch)`);
  }
  return moved;
}

/**
 * Which recorded changes are NOT yet reflected in the user's project.
 *
 * Uniform rule: for an added or modified file the project copy must match the
 * workspace copy; for a deleted one the project copy must be gone. Anything
 * that fails is work the project does not have.
 *
 * A file that cannot be read on either side counts as missing — the whole
 * point is to be sure before telling someone their work is safe.
 */
/**
 * Content with CRLF collapsed to LF, for comparing a file that has been
 * through `git apply` against the copy it came from. A file whose ONLY
 * difference is its line endings reads as landed, which is the right answer
 * here: the question is whether the user's work is in their project, not
 * whether the two bytestreams are identical.
 */
function normaliseEol(buf: Buffer): string {
  return buf.toString("utf8").replace(/\r\n/g, "\n");
}

async function changesNotInProject(
  run: WorkspaceRun,
  changed: ReadonlyArray<{ path: string; kind: string }>,
): Promise<string[]> {
  const workspace = isolatedRoot(run);
  const projectBase = await projectBaseFor(run);
  const missing: string[] = [];
  for (const change of changed) {
    const inProject = path.join(projectBase, change.path);
    if (change.kind === "deleted") {
      if (existsSync(inProject)) missing.push(`${change.path} (still present)`);
      continue;
    }
    try {
      const [a, b] = await Promise.all([
        readFile(inProject),
        readFile(path.join(workspace, change.path)),
      ]);
      // Bytes first, then line endings. `git apply` writes through the
      // repository's eol/autocrlf settings, so on Windows an applied text file
      // routinely lands as CRLF while the workspace copy is LF. A raw byte
      // comparison called every one of those "differs" — which would have
      // raised the false data-loss alarm this check exists to remove, on the
      // platform it was reported from.
      if (!a.equals(b) && normaliseEol(a) !== normaliseEol(b)) {
        missing.push(`${change.path} (differs)`);
      }
    } catch {
      missing.push(`${change.path} (${change.kind})`);
    }
  }
  return missing;
}

/**
 * Drop patch sections for files inside the workspace directory itself.
 *
 * A `copy` workspace lives INSIDE the project (.harness-dispatch/workspaces/),
 * so `git diff --no-index <project> <copy>` walks into the copy while
 * scanning the project and reports the copy's own files as project files.
 * Normalisation then rewrites those paths — they contain the isolated root as
 * a substring — down to the same names as the real ones, producing a patch
 * with two conflicting sections per file: a spurious deletion of the copy's
 * version, and the genuine edit.
 *
 * Observed live: `app.js` appeared twice, once "deleted file mode" and once
 * modified. Applying that would have deleted the file it was meant to update.
 * It never showed up in unit tests because the fixtures put the copy outside
 * the project, which is not where the product puts it.
 */
function dropSectionsUnder(patch: string, absRoot: string): string {
  if (!patch || !absRoot) return patch;
  const lines = patch.split("\n");

  // Section-wise, because the leaked entries cannot be told from legitimate
  // ones by their header alone. A file the agent ADDED and a copy-of-the-copy
  // artefact both carry the isolated root on BOTH sides of `diff --git` — the
  // difference is direction. The artefacts are always deletions (the file
  // exists under the workspace while scanning the project, and has no
  // counterpart inside the copy, which excludes its own workspace directory),
  // and a real addition is always `--- /dev/null`. Filtering on the header
  // alone dropped every genuine change too, and produced an empty patch.
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current);

  const kept = sections.filter((section) => {
    const header = section[0] ?? "";
    if (!header.startsWith("diff --git ")) return true;
    const underWorkspace = header.includes(`${absRoot}/`);
    if (!underWorkspace) return true;
    const isDeletion = section.some((l) => l.startsWith("+++ /dev/null"));
    return !isDeletion;
  });
  return kept.map((s) => s.join("\n")).join("\n");
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
export function normaliseNoIndexPaths(patch: string, origRoot: string, isoRoot: string): string {
  if (!patch) return patch;
  // Longest first: when one root is a prefix of the other, stripping the
  // shorter one first would leave a fragment of the longer behind.
  const roots = [origRoot, isoRoot].sort((a, b) => b.length - a.length);
  // HEADER LINES ONLY, and "header" is decided by POSITION, not by prefix.
  //
  // This used to run over every line in the patch, including `+` and `-`
  // content, so a file that mentioned its own absolute path had that path
  // deleted from its text on the way through: a delegate wrote
  // `const dataDir = "C:/…/hd-acc/data"` and the project received
  // `const dataDir = "data"`, reported as a clean apply. Env files, tsconfig
  // paths, docker volumes and fixtures all routinely contain the project path.
  //
  // Matching on prefixes alone is not enough either: an ADDED line whose own
  // text starts with "++ " arrives as "+++ ", and a `git diff` of a patch file
  // is not a hypothetical in this repo. Everything from `@@` to the next
  // section is content, full stop.
  let inHunk = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) inHunk = false;
      else if (line.startsWith("@@")) inHunk = true;
      if (inHunk) return line;
      let out = line;
      for (const r of roots) {
        // The a/ and b/ prefixes are rebuilt explicitly rather than left to a
        // blanket strip, because a POSIX root already starts with "/": git
        // emits `a//tmp/proj/app.js`, and removing "/tmp/proj/" from that
        // leaves "aapp.js" — the prefix eaten, the patch unusable. A Windows
        // root starts with a drive letter, so the blanket version worked
        // there and this only failed on POSIX, in CI.
        out = out.split(`a${r}/`).join("a/").split(`b${r}/`).join("b/");
        out = out.split(`a/${r}/`).join("a/").split(`b/${r}/`).join("b/");
        // Anything left over (e.g. a bare path in a "similarity index" line).
        out = out.split(`${r}/`).join("");
      }
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

/**
 * Uncommitted changes in the target, or undefined when it is not a repo.
 *
 * The tool's OWN directory is not the user's work. Workspaces now live outside
 * the project entirely, but an install that ran an earlier version can still
 * have a `.harness-dispatch/` sitting there, and counting it made apply refuse
 * with "1 uncommitted change" — the feature blocking itself with its own
 * leftovers.
 *
 * Matched on ANY segment, not just the first. `git status --porcelain` reports
 * paths from the repo root, so a dispatch whose workingDir was a subdirectory
 * saw `sub/.harness-dispatch/` and the old first-segment test missed it —
 * which is how the self-blocking bug this comment describes came back for
 * every monorepo layout after it was supposedly fixed.
 */
async function dirtyPaths(dir: string): Promise<string[] | undefined> {
  try {
    const out = await git(["status", "--porcelain"], dir);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((line) => {
        // Porcelain lines are "XY path"; the path may be quoted.
        const p = line.slice(2).trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
        return !p.split("/").includes(".harness-dispatch");
      });
  } catch {
    return undefined;
  }
}

/**
 * Porcelain lines present after an attempt that were not there before, as bare
 * paths. `undefined` on either side means git could not be asked (not a repo),
 * in which case nothing can be claimed either way and the list is empty.
 */
function diffPathLists(before: string[] | undefined, after: string[] | undefined): string[] {
  if (before === undefined || after === undefined) return [];
  const seen = new Set(before);
  return after.filter((line) => !seen.has(line)).map((line) => line.slice(2).trim());
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
    // An empty patch is only honest when nothing changed. changedFiles is
    // computed separately, by comparing fingerprints, so the two disagreeing
    // means the patch lost something — which is exactly what happened when a
    // created file went missing: one response said `added: notes.txt` and
    // "the agent changed nothing" at the same time, and the user, reasonably,
    // believed the reassuring half and discarded the workspace.
    //
    // This is a guard, not a fix; the fix is in buildWorkspacePatch. It stays
    // because the failure is silent and destructive, and because the
    // workspace it describes is about to be deleted.
    const changed = run.changedFiles ?? [];
    if (changed.length > 0) {
      // changedFiles is frozen at dispatch; the patch is recomputed live. So
      // "recorded changes, empty patch" has TWO causes and they need opposite
      // answers:
      //
      //   already applied — the project now matches the workspace, so there is
      //     genuinely nothing left to do. Alarming here told a user their work
      //     had been dropped one second after it landed correctly.
      //   the patch lost something — the project does NOT match, and applying
      //     an empty patch would quietly abandon the difference.
      //
      // Asking the filesystem which one it is settles it, at the cost of
      // reading a handful of named files.
      const missing = await changesNotInProject(run, changed);
      if (missing.length === 0) {
        return {
          jobId,
          applied: false,
          patchPath: diff.patchPath,
          message:
            `Already applied: the project already matches the workspace for all ` +
            `${changed.length} changed file(s), so there is nothing left to apply. ` +
            `Use action: "discard" to clean up the workspace.`,
        };
      }
      return {
        jobId,
        applied: false,
        patchPath: diff.patchPath,
        message:
          `Refused: ${missing.length} recorded change(s) are missing from your project ` +
          `(${missing.join(", ")}) but the patch is empty, so applying it would silently ` +
          `drop that work. Do NOT discard this job — the workspace still holds the files ` +
          `at ${isolatedRoot(run)}. Please report this.`,
      };
    }
    return {
      jobId,
      applied: false,
      patchPath: diff.patchPath,
      message: "The agent changed nothing, so there is nothing to apply.",
    };
  }

  const target = run.originalWorkingDir;

  // Has the project moved under this patch? Checked BEFORE the dirty check,
  // because it catches the case the dirty check cannot: a change that has been
  // COMMITTED since the dispatch started leaves `git status` clean, and
  // committing is exactly what the dirty refusal tells you to do. Apply job A,
  // commit it, apply job B — and B silently reverted A's committed line, with
  // git apply unable to conflict because the patch's context was the current
  // file.
  if (opts.force !== true && run.changedFiles !== undefined) {
    const moved = await projectMovedSince(run, run.changedFiles);
    if (moved.length > 0) {
      return {
        jobId,
        applied: false,
        patchPath: diff.patchPath,
        message:
          `Refused: ${moved.length} file(s) this patch touches have changed in ${target} since ` +
          `the dispatch started (${moved.join(", ")}). The agent worked from the older version, ` +
          `so applying would overwrite that newer work rather than merge with it — and unlike a ` +
          `worktree patch there is no common commit for git to merge against. Review the patch ` +
          `at ${diff.patchPath}, re-run the task against the current tree with retry_job, or ` +
          `re-run with force: true to overwrite.`,
      };
    }
  }

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

  // --3way merges when context has moved instead of failing outright. It
  // needs the pre-image blobs to exist in the target repo, which holds for a
  // worktree patch (same repo, real commit) but NOT for a copy patch — `git
  // diff --no-index` writes index lines for blobs the repo has never seen, so
  // --3way fails with "could not build fake ancestor". Plain apply handles
  // that fine, so the strict-but-smarter mode is an attempt, not a requirement.
  //
  // PLAIN APPLY FIRST, --3way second. The order used to be the other way
  // round, and --3way is not atomic: on conflict it writes `<<<<<<< ours` /
  // `>>>>>>> theirs` markers INTO the target and then exits non-zero. The
  // failure was reported as "git apply failed … resolve by hand", which reads
  // as "nothing happened" — while the user's file had already been rewritten
  // with conflict markers. Plain apply either applies everything or nothing,
  // so trying it first means the common case never mutates on failure, and
  // --3way is still there for the case it exists to handle (context moved in a
  // worktree patch, where the pre-image blobs are in the repo).
  // Apply from the repo root — and for `copy`, tell git which subdirectory the
  // patch is relative to.
  //
  // The two policies produce patches with DIFFERENT bases, and conflating them
  // is destructive:
  //
  //   git_worktree — `git diff <baseCommit>` inside the worktree, so paths are
  //     REPO-relative. Applying from the repo root with no --directory is
  //     correct.
  //   copy — `git diff --no-index <workingDir> <copy>`, so paths are
  //     WORKINGDIR-relative. Applying those at the repo root resolves every
  //     path one or more levels too high: with a same-named file up there it
  //     silently edited and DELETED the wrong files and reported success, and
  //     without one it wrote conflict markers into a root file the delegate
  //     had never seen. --directory is git's own answer to exactly this.
  //
  // Running from the subdirectory instead does not work: `git apply` inside a
  // repo ignores paths that resolve outside the current directory, so it
  // matched nothing, printed `Skipped patch`, and exited 0 — the silent no-op
  // this whole area started with. Verified against real git, all three ways.
  const root = await repoRoot(target);
  const applyCwd = root ?? target;
  const applyPrefix =
    root !== undefined && run.policy !== "git_worktree"
      ? path.relative(root, target).split(path.sep).join("/")
      : "";
  const directoryArgs = applyPrefix !== "" ? [`--directory=${applyPrefix}`] : [];
  const beforeAttempt = await dirtyPaths(target);
  let applyError: string | undefined;
  for (const args of [
    ["apply", ...directoryArgs, "--whitespace=nowarn", diff.patchPath],
    ["apply", ...directoryArgs, "--3way", "--whitespace=nowarn", diff.patchPath],
  ]) {
    try {
      const out = await gitBoth(args, applyCwd);
      // `Skipped patch` is git telling us, on a zero exit, that it did
      // nothing. Treated as success it is indistinguishable from a real apply,
      // which is the whole defect above.
      if (/^Skipped patch /m.test(out)) {
        applyError = out.split("\n").find((l) => l.startsWith("Skipped patch")) ?? out;
        continue;
      }
      applyError = undefined;
      break;
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }
  }
  if (applyError !== undefined) {
    const firstLine = applyError.split("\n").find((l) => l.includes("error:")) ?? applyError.split("\n")[0];
    // Did the failed attempt leave the project changed anyway? --3way can.
    // Saying "failed" while the working tree has been rewritten is the worst
    // of both: the user neither has their change nor knows their file moved.
    const afterAttempt = await dirtyPaths(target);
    const touched = diffPathLists(beforeAttempt, afterAttempt);
    const mutated =
      touched.length > 0
        ? ` YOUR PROJECT WAS MODIFIED ANYWAY: ${touched.join(", ")} — a three-way merge ` +
          `wrote conflict markers before giving up. Check those file(s), and \`git checkout -- ` +
          `<file>\` to undo if you would rather start over.`
        : ` Your project was not modified.`;
    return {
      jobId,
      applied: false,
      patchPath: diff.patchPath,
      message:
        `git apply failed: ${firstLine}.${mutated} The patch is intact at ` +
        `${diff.patchPath} — resolve by hand, or inspect the workspace directly.`,
    };
  }

  // Name what force ran over. `force: true` is the caller waiving the
  // uncommitted-changes refusal, and it was answered with the same cheerful
  // line as a clean apply — so a human edit the patch replaced left no trace
  // in the response at all. The waiver covers doing it; it does not cover
  // being quiet about it.
  const overwritten =
    opts.force === true && dirty !== undefined && dirty.length > 0
      ? ` FORCED over ${dirty.length} uncommitted change(s): ` +
        `${dirty.map((l) => l.slice(2).trim()).join(", ")} — where the patch touched the same ` +
        `lines, your version was replaced, not merged.`
      : "";
  return {
    jobId,
    applied: true,
    patchPath: diff.patchPath,
    message:
      `Applied ${diff.bytes} bytes of changes to ${target}.${overwritten} ` +
      `Review with git diff before committing.`,
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
  opts: { force?: boolean } = {},
): Promise<DiscardResult> {
  const root = run.workspaceRoot;
  if (!root) {
    return { jobId, discarded: false, message: "This job has no isolated workspace to discard." };
  }
  if (!existsSync(root)) {
    return { jobId, discarded: true, message: `Already gone: ${root}` };
  }

  // Refuse to destroy the only copy of work the project does not have.
  //
  // `apply` can end with "Do NOT discard this job — the workspace still holds
  // the files at …", and discard then deleted them anyway and answered "The
  // original project was never modified." The reassuring sentence arrived at
  // the exact moment the work was destroyed. Discard is the one irreversible
  // action here, so it owes the same check apply makes.
  //
  // Deliberately not gated on whether apply was ever called: a caller who
  // never ran apply is in more danger, not less.
  const changed = run.changedFiles ?? [];
  if (opts.force !== true && changed.length > 0 && existsSync(isolatedRoot(run))) {
    const missing = await changesNotInProject(run, changed);
    if (missing.length > 0) {
      return {
        jobId,
        discarded: false,
        message:
          `Refused: ${missing.length} change(s) exist only in this workspace and are not in ` +
          `your project (${missing.join(", ")}). Discarding would destroy the only copy. Run ` +
          `action: "apply" first, copy them out of ${isolatedRoot(run)} by hand, or pass ` +
          `force: true if you genuinely want them thrown away.`,
      };
    }
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

  // maxRetries because the agent CLI has only just exited and Windows can
  // still be holding a handle on something it wrote — observed live as
  // `EBUSY: resource busy or locked, rmdir ...\workspace` on a discard issued
  // straight after a successful apply, where the same removal succeeded
  // moments later. Failing here strands the workspace inside the user's
  // project, which is the one place it must not be left.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // "The original project was never modified" was printed unconditionally,
  // including immediately after an apply that had just modified it. Discard
  // only ever speaks for ITSELF; whether the project was touched earlier is
  // not something this function knows.
  return {
    jobId,
    discarded: true,
    message: `Discarded the isolated workspace at ${root}. Discarding changes nothing in ${run.originalWorkingDir} — anything already applied from this job stays applied.`,
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
