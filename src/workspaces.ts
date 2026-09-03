import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DispatchResult,
  SafetyProfile,
  ServiceConfig,
  WorkspaceFileChange,
  WorkspacePolicy,
  WorkspaceRun,
} from "./types.js";

const execFile = promisify(execFileCb);

export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__",
]);

interface FileFingerprint {
  hash: string;
  size: number;
  /**
   * Digest over content with CRLF collapsed to LF, kept ALONGSIDE the exact
   * hash rather than replacing it.
   *
   * `hash` decides whether the AGENT changed a file and must stay exact: an
   * edit that only rewrites line endings is a real edit. `eolHash` answers a
   * different question — has the USER's copy moved since the dispatch started
   * — where a checkout whose eol settings rewrote the file on the way in must
   * NOT read as a change. One value cannot serve both.
   */
  eolHash: string;
}

type FingerprintMap = Map<string, FileFingerprint>;

export interface PreparedWorkspace {
  policy: WorkspacePolicy;
  originalWorkingDir: string;
  effectiveWorkingDir: string;
  files: string[];
  isolated: boolean;
  workspaceRoot?: string;
  finish(result: DispatchResult): Promise<DispatchResult>;
}

export function workspacePolicyFor(
  svc: ServiceConfig,
  safetyProfile: SafetyProfile | undefined,
  requestedPolicy?: WorkspacePolicy,
): WorkspacePolicy {
  if (requestedPolicy) return requestedPolicy;
  if (svc.workspacePolicy) return svc.workspacePolicy;
  return safetyProfile === "read_only" ? "shared" : "shared_locked";
}

export function isIsolatedWorkspacePolicy(policy: WorkspacePolicy): boolean {
  return policy === "copy" || policy === "git_worktree";
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "route";
}

/**
 * Exported for tests, which must build run directories with the SAME function
 * that makes real ones rather than by hand.
 *
 * Three separate tests in this repo used a hand-written name the product
 * cannot generate — run directories with four-character suffixes where a real
 * one has eight hex — and each therefore asserted something about an input
 * that never occurs. Two of them passed while the bug they claimed to cover
 * was live. A fixture is only evidence if it is the thing.
 */
export function workspaceRunId(routeName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${safeName(routeName)}-${randomUUID().slice(0, 8)}`;
}

function resolveDir(workingDir: string): string {
  return path.resolve(workingDir || process.cwd());
}

/**
 * Isolated workspaces live OUTSIDE the project, for both policies.
 *
 * `copy` used to put its workspace at `<project>/.harness-dispatch/workspaces/`
 * — inside the very directory it was isolating from. That one decision
 * produced a defect in every acceptance pass of the 0.6 series, because
 * `git diff --no-index <project> <copy>` then walks into the copy while
 * scanning the project:
 *
 *   - a file the agent CREATED appeared on both sides with identical content,
 *     so rename detection paired them and emitted nothing at all (0.6.3);
 *   - SIBLING workspaces from other jobs, retained for 24h by design, leaked
 *     in as deletions — so applying one job's patch emptied another job's
 *     workspace, destroying the only copy of a second delegate's work, and
 *     then offered to delete the user's own files (0.6.6 acceptance, BLOCK);
 *   - the project root had to be stripped out of the patch text, which
 *     silently rewrote CONTENT lines that happened to contain that path.
 *
 * Each was fixed with a filter, and each filter turned out to have a gap. The
 * copy being nested is the shared cause, so it is the thing that changes here.
 * git_worktree already lived out of tree — which is exactly why none of the
 * above ever affected it — and both now use one root.
 *
 * The trade is copy-on-write: COPYFILE_FICLONE only reflinks within a
 * filesystem, so a temp dir on another volume falls back to a real copy. That
 * is a bounded, measurable cost; silently losing a delegate's work is not.
 * HARNESS_DISPATCH_WORKSPACES_DIR overrides it for anyone who wants the
 * workspaces on the project's volume.
 */
/**
 * The directory all per-project workspace roots hang off.
 *
 * Exported because the apply-time dirty check has to know it too: with the
 * override pointed inside the project — which README recommends, to keep the
 * copy on one volume for reflinks — the workspaces directory is itself an
 * untracked change, so `apply` refused on an otherwise pristine tree, every
 * time. The same "feature blocked by its own leftovers" the recursion guard
 * above was written for, one step further along.
 */
export function workspacesBase(): string {
  return (
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR ??
    path.join(os.tmpdir(), "harness-dispatch", "workspaces")
  );
}

/** Exported for tests, for the same reason as `workspaceRunId`. */
export function workspaceRootFor(originalWorkingDir: string): string {
  const base = workspacesBase();
  // The per-project segment applies to the override too. Without it, every
  // project pointed at one HARNESS_DISPATCH_WORKSPACES_DIR shared a flat
  // directory, so a dispatch in project B pruned project A's aged workspaces —
  // and with both policies now under one root, could strand A's git metadata.
  //
  // Keyed on the full path, not just the basename: two checkouts both called
  // `api` are a normal thing to have, and sharing a directory would make each
  // one's retention depend on how recently the other was dispatched into. The
  // basename stays in the name so the directory is still recognisable by eye.
  return path.join(base, `${safeName(path.basename(originalWorkingDir))}-${pathKey(originalWorkingDir)}`);
}

/**
 * Written into every project root this tool creates, so reclamation can delete
 * a directory because it KNOWS it made it rather than because the name looks
 * about right.
 *
 * The previous attempt matched the generated name shape, `-[0-9a-f]{8}$`. Eight
 * decimal digits are valid hex, so any `<name>-<YYYYMMDD>` collided: a second
 * acceptance pass planted `backup-20260401/data.bin` beside directories that
 * survived and watched one dispatch delete it recursively. A heuristic cannot
 * answer "did I create this" — only a mark can.
 */
const ROOT_MARKER = ".harness-dispatch-root";

/**
 * The shape `workspaceRunId` generates: an ISO stamp, pid, route, 8 hex.
 * Used ONLY to recognise roots created before the marker existed, so those are
 * still reclaimed instead of leaking forever.
 */
const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-.+-[0-9a-f]{8}$/;

/**
 * Bring an existing workspace root up to 0700, and refuse one we do not own.
 *
 * Two separate problems, both POSIX-only, both found by an acceptance pass
 * measuring the shipped `mode:` fix on real Linux rather than trusting it:
 *
 *   ALREADY THERE — `mkdir`'s mode applies only to directories it creates, so
 *     an existing 0755 root stayed 0755. Every pre-existing user was
 *     unaffected by the "fix". An explicit chmod is the only thing that
 *     changes them.
 *   SOMEBODY ELSE'S — the root path is fully deterministic
 *     (`<tmp>/harness-dispatch/workspaces/<basename>-<hash of path>`) inside a
 *     SHARED `os.tmpdir()`, so on the multi-user machine this whole guard
 *     exists for, another local user can create it first. Then it is theirs:
 *     chmod fails, and copying the project into it would hand them the
 *     source. That is not a mode to fix, it is a directory to refuse.
 *
 * Throws on the second case. `markProjectRoot`'s caller treats a marker
 * failure as harmless — correctly, a root without its marker is merely not
 * auto-reclaimed — but "another user owns the directory I am about to copy
 * your code into" is not in that category and must not be swallowed.
 *
 * Windows is skipped deliberately: `uid` is 0 for every process, Node ignores
 * mode, and `os.tmpdir()` is already per-user there.
 */
/**
 * Build the workspace root one segment at a time, and hand back the path that
 * was actually created.
 *
 * THIS REPLACES A CHECK-THEN-USE GUARD, and the replacement is the point. Four
 * consecutive releases patched a validator that inspected a path STRING and
 * then let the rest of the module re-resolve that same string on every write.
 * Each patch closed the hole it was shown and left the shape intact, so the
 * next pass found another one:
 *
 *   - `stat` followed the link it was checking (release 1);
 *   - the guard was applied to one of the two isolation policies (release 2);
 *   - it inspected only the last path segment (release 3);
 *   - it stopped AT `workspacesBase()` and never looked at that directory's
 *     own parent — the one the release notes said it now checked;
 *   - it compared with `startsWith` against an un-normalised base, so a
 *     trailing slash or a `..` in HARNESS_DISPATCH_WORKSPACES_DIR turned the
 *     whole guard off silently;
 *   - and validating once left every later write re-resolving the string, so
 *     swapping a directory for a link DURING the copy redirected it (3,877
 *     files landed in an attacker's directory in the reproduction).
 *
 * So the rule is no longer "look at the path and then trust it". Every segment
 * from the anchor down is CREATED BY US with a non-recursive mkdir, which
 * cannot traverse a link we did not make: if something is already there,
 * `mkdir` fails and we inspect it deliberately rather than following it. The
 * verified, fully-resolved directory is then RETURNED, and callers use that
 * value instead of re-deriving the string.
 *
 * The anchor is the directory the user chose (HARNESS_DISPATCH_WORKSPACES_DIR)
 * or the system temp directory. Above it is not ours to police —
 * `os.tmpdir()` is legitimately a symlink on macOS (`/var` -> `/private/var`),
 * which is exactly why the anchor is RESOLVED rather than refused. Everything
 * below it is ours, and a link there is refused.
 *
 * What this still does not give: `mkdir`/`lstat` name a path, not an open
 * handle, so a sufficiently fast swap between two syscalls remains
 * theoretically possible — Node exposes no `openat`/`O_NOFOLLOW`. The window
 * is now one syscall rather than the whole dispatch, and every destructive
 * operation re-verifies (see `assertStillOurs`) instead of trusting a check
 * made minutes earlier.
 */
async function verifySegment(dir: string): Promise<void> {
  const info = await lstat(dir);
  // Symlink check on EVERY platform. This was skipped entirely on Windows for
  // a stated reason that covers only the ownership half — uid is 0 there and
  // mode is ignored. Junctions need no privileges, `lstat` reports them as
  // symbolic links, and a junction planted at the workspace path was measured
  // taking a whole project into the victim's directory on this maintainer's
  // own machine.
  if (info.isSymbolicLink()) {
    throw new Error(
      `${dir} is a symbolic link, and this tool never creates one there. Refusing to use ` +
        `it: following it would put your project — and this tool's recursive cleanup — ` +
        `wherever the link points. Remove it, or set HARNESS_DISPATCH_WORKSPACES_DIR to a ` +
        `location you control.`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      `${dir} exists and is not a directory. Refusing to use it as a workspace location. ` +
        `Remove it, or set HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `${dir} is owned by another user (uid ${info.uid}, this process is uid ${uid}). ` +
        `Refusing to put your project beneath it: this path is predictable, so a directory ` +
        `you do not own may have been created there deliberately. Remove it, or set ` +
        `HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/**
 * Re-check, immediately before a destructive or bulk operation, that a
 * directory verified earlier is still the one we verified.
 *
 * The old code validated once at the start of a dispatch and then trusted the
 * path string for everything that followed. This is the narrow version of that
 * trust: it costs one `lstat` and it turns "checked minutes ago" into "checked
 * a syscall ago".
 */
export async function assertStillOurs(dir: string): Promise<void> {
  await verifySegment(dir);
}

/**
 * The anchor, resolved. Above this we do not police; below it we do.
 *
 * `path.resolve` is what fixes the guard being silently inert for a
 * HARNESS_DISPATCH_WORKSPACES_DIR written with a trailing slash or containing
 * `..` — the old comparison was `startsWith` against the raw string, so those
 * spellings failed to match and the loop body never ran even once.
 */
async function resolvedAnchor(): Promise<{ declared: string; resolved: string }> {
  const configured = process.env.HARNESS_DISPATCH_WORKSPACES_DIR;
  const anchor = configured !== undefined ? path.resolve(configured) : os.tmpdir();

  // VERIFY THE NEAREST EXISTING ANCESTOR BEFORE CREATING ANYTHING.
  //
  // Creating the anchor first was still a "touch, then check": with a link at
  // `<tmp>/hd`, a recursive mkdir of `<tmp>/hd/workspaces` traversed it and
  // left an empty directory inside the attacker's tree before the refusal
  // arrived. Small, but it is the same mistake in miniature — and this
  // function exists to stop making it.
  //
  // Walking up to what already exists, resolving THAT, and checking who owns
  // it means the first thing we create is created somewhere we have already
  // vouched for.
  let existing = anchor;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  // realpath here, not lstat: the anchor is allowed to BE a link, because
  // os.tmpdir() is one on macOS (`/var` -> `/private/var`) and a user pointing
  // the override at a link is making a choice about their own machine. What
  // must hold is that wherever it lands belongs to us.
  const resolvedExisting = await realpath(existing);
  const info = await lstat(resolvedExisting);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid && info.uid !== 0) {
    throw new Error(
      `${resolvedExisting} is owned by another user (uid ${info.uid}, this process is uid ` +
        `${uid}), and the workspace location resolves beneath it. Refusing to create ` +
        `anything there. Set HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
    );
  }
  // Segments computed in DECLARED space and created in DECLARED space.
  //
  // Computing them between the resolved ancestor and the declared anchor
  // produced `..` components whenever the two differed — i.e. on every macOS
  // machine — and the loop then walked upwards creating nonsense. The resolve
  // happens once, at the end, after the chain exists.
  const relative = path.relative(existing, path.resolve(anchor));
  let current = existing;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      await verifySegment(current);
    }
  }
  // BOTH values are returned, and the distinction is load-bearing.
  //
  // `declared` is what the rest of the module derives paths from
  // (`workspacesBase()` builds on the unresolved `os.tmpdir()`), and
  // `resolved` is where those paths actually land. Comparing a declared target
  // against the RESOLVED anchor is wrong on macOS, where `os.tmpdir()` is
  // `/var/folders/...` and resolves to `/private/var/folders/...`: every
  // legitimate run then looks like it is outside the anchor and is refused.
  // Caught in a container before CI, by running the macOS path shape
  // deliberately rather than assuming POSIX is POSIX.
  return { declared: path.resolve(anchor), resolved: await realpath(current) };
}

/**
 * Create and verify every segment from the anchor down to `root`, and return
 * the verified path.
 */
export async function prepareVerifiedRoot(root: string): Promise<string> {
  const anchor = await resolvedAnchor();
  const target = path.resolve(root);
  // Relative to the DECLARED anchor (how the caller built the path), then
  // created beneath the RESOLVED one (where it really lives).
  const relative = path.relative(anchor.declared, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // Not beneath the anchor at all. Only reachable if the caller derived the
    // path from something other than workspacesBase(); refusing beats
    // silently operating outside the area this function can vouch for.
    throw new Error(
      `Refusing to use ${target} as a workspace location: it is not beneath ` +
        `${anchor.declared}, so this tool cannot vouch for the path it would write and ` +
        `delete under.`,
    );
  }
  let current = anchor.resolved;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    // Non-recursive on purpose: a recursive mkdir traverses whatever is
    // already there, including a link. This creates each level itself, so the
    // only way a link enters the chain is if it existed first — in which case
    // mkdir fails with EEXIST and we inspect it rather than following it.
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      await verifySegment(current);
      continue;
    }
  }
  return current;
}

/**
 * Create the project's workspace root and mark it as ours, returning the
 * VERIFIED path that was actually created.
 *
 * Callers must use the returned value rather than the string they passed in.
 * That is the whole change: the old signature returned nothing, so every
 * caller went on using its own copy of the path and re-resolved it on each
 * write — which is how a directory swapped for a symlink mid-copy redirected
 * the rest of it.
 *
 * The MARKER stays best effort: a root without one is merely not reclaimed
 * automatically, which is the safe direction to fail in. Creating and
 * verifying the directory is not, and must not be swallowed.
 */
async function markProjectRoot(root: string): Promise<string> {
  const verified = await prepareVerifiedRoot(root);
  try {
    const marker = path.join(verified, ROOT_MARKER);
    if (!existsSync(marker)) {
      await writeFile(
        marker,
        "Created by harness-dispatch. This directory and its dated run\n" +
          "subdirectories are managed — and eventually deleted — by it.\n",
        "utf8",
      );
    }
  } catch {
    // A root without its marker is merely not reclaimed automatically, which
    // is the safe direction to fail in.
  }
  return verified;
}

/**
 * Is this directory one we created, and therefore ours to delete?
 *
 * The marker settles it. The fallback covers roots created before the marker
 * existed: every child must be a generated run directory, and there must be at
 * least one — an empty unmarked directory is somebody else's empty directory,
 * not ours. A foreign directory passes only if everything inside it happens to
 * be named like a timestamped run, which is not a thing that happens by
 * accident. This deletes recursively and has now been wrong twice, so it takes
 * positive evidence rather than the absence of a reason to stop.
 */
const PROJECT_ROOT_RE = /^.+-[0-9a-f]{8}$/;

function isOurProjectRoot(full: string, children: string[]): boolean {
  // The NAME must fit too, not just the marker.
  //
  // The marker is an ordinary file, and anything that can write to the
  // workspaces base can create one — including a delegated agent, when
  // HARNESS_DISPATCH_WORKSPACES_DIR points inside the project, which README
  // recommends and the walkthrough exercises. An acceptance pass used exactly
  // that to get an unrelated directory holding the only copy of its contents
  // recursively deleted.
  //
  // Requiring the generated shape as WELL as the marker does not make this
  // unforgeable — a name is guessable and the marker is writable — but it
  // turns "create a file called .harness-dispatch-root" into "also name the
  // directory the way pathKey would have". Combined with the reclamation only
  // ever running inside our own base, that is the honest limit of what a
  // same-uid check can promise here: the caller and the attacker are the same
  // user, so no permission check can separate them.
  if (!PROJECT_ROOT_RE.test(path.basename(full))) return false;
  if (existsSync(path.join(full, ROOT_MARKER))) return true;
  const runs = children.filter((name) => name !== ROOT_MARKER);
  return runs.length > 0 && runs.every((name) => RUN_DIR_RE.test(name));
}

/** Short stable digest of a project path, to keep same-named projects apart. */
function pathKey(dir: string): string {
  return createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8);
}


const DEFAULT_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function workspaceMaxAgeMs(): number {
  const raw = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WORKSPACE_MAX_AGE_MS;
}

/**
 * Delete this project's aged run directories, whatever policy made them.
 *
 * There were two of these, one per policy, ~55 lines each and identical but
 * for whether a git root was required. That duplication is the direct cause of
 * the symlink-guard class needing four releases to close: the `lstat` refusal,
 * the secure-before-prune ordering and this sweep's own name check were each
 * applied to the copy copy, shipped as "fixed", and found still exploitable
 * through the worktree copy by the next review. The comment left behind said
 * "two policies, one hazard: whenever one of these gets a guard, check the
 * other in the same edit" — a process rule standing in for a shared function.
 * This is the shared function.
 *
 * `gitRoot` is optional because only a project under git has worktrees to
 * unregister; the filesystem sweep is the same either way.
 */
async function pruneStaleRuns(root: string, gitRoot?: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  // Before the early return below: a project dispatching for the FIRST time
  // has no root of its own to sweep, and that is exactly the caller most
  // likely to be running on a machine full of other projects' leftovers.
  //
  // The base is derived from `root`, NOT from workspacesBase(). `root` is the
  // VERIFIED, fully-resolved path while `workspacesBase()` returns the
  // DECLARED one, and on any machine where the two differ — every macOS box,
  // since `os.tmpdir()` resolves through `/private` — the "exclude our own
  // root" comparison below compared strings from two different spaces, failed
  // to match, and deleted the directory the dispatch had just created.
  await pruneAbandonedProjectRoots(path.dirname(root), root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  let removedWorktree = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only directories WE named. This loop deletes recursively and had no
    // check of any kind — not a name, not a marker, not an owner — while its
    // sibling `pruneAbandonedProjectRoots` has all three under a comment
    // saying "this deletes directories nothing else is watching". With a
    // symlink planted at the root, that gap swept a user's own files.
    //
    // The same guard `pruneStaleJobs` already uses, and for the same reason:
    // a recursive delete takes positive evidence that the thing is ours,
    // rather than the absence of a reason to stop. `RUN_DIR_RE` is the exact
    // shape `workspaceRunId` generates.
    if (!RUN_DIR_RE.test(entry.name)) continue;
    const workspaceRoot = path.join(root, entry.name);
    try {
      const info = await stat(workspaceRoot);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      // A `worktree` child is the tell that git still has this registered.
      const worktreeRoot = path.join(workspaceRoot, "worktree");
      if (gitRoot !== undefined && existsSync(worktreeRoot)) {
        try {
          await git(["worktree", "remove", "--force", worktreeRoot], gitRoot);
          removedWorktree = true;
        } catch {
          // Registered against a different repo, or already gone: the
          // filesystem sweep below still reclaims the disk, and the prune
          // afterwards clears whatever metadata this repo can see.
        }
      }
      await rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // best effort — a locked/already-gone/permission-denied entry is skipped
    }
  }
  if (removedWorktree && gitRoot !== undefined) {
    await git(["worktree", "prune"], gitRoot).catch(() => undefined);
  }
}

/**
 * Create this run's directory, with every guard the path needs, in the order
 * they have to happen.
 *
 * SECURE BEFORE PRUNING. The order was once the other way round, and the guard
 * could not protect the one operation that deletes: the sweep ran first and
 * `rm -rf`d every aged subdirectory of a root nothing had yet looked at. With
 * a symlink planted at that path, the victim's own directory was swept —
 * reproduced end to end, as two real users.
 *
 * Both policies ran this same five-step sequence from their own copy. Each
 * step is here once now, so a guard cannot be added to one policy and missed
 * on the other, which is how the class stayed open across four releases.
 */
async function secureRunDirectory(
  projectRoot: string,
  routeName: string,
  gitRoot?: string,
): Promise<string> {
  // markProjectRoot creates and secures the root and RETURNS the verified
  // path: everything below uses that, never the string computed by the
  // caller. Re-deriving the string is what let a swapped directory redirect
  // the copy after the check had passed.
  const verifiedRoot = await markProjectRoot(projectRoot);
  await pruneStaleRuns(verifiedRoot, gitRoot);
  const workspaceRoot = path.join(verifiedRoot, workspaceRunId(routeName));
  // Created here, non-recursively, and verified — rather than left to a later
  // recursive mkdir. This run's directory is the segment an attacker would
  // swap between the prune and the write that follows.
  await mkdir(workspaceRoot, { recursive: false, mode: 0o700 });
  await assertStillOurs(workspaceRoot);
  return workspaceRoot;
}

/**
 * Reclaim the per-project directories of projects that never dispatch again.
 *
 * The sweep above only ever looks INSIDE one project's root, and only runs
 * when a dispatch happens for that same project. So a project dispatched once
 * and then renamed, deleted, or — most commonly — created as a temp directory
 * by the test suite keeps its stale runs forever: the code that would reclaim
 * them is reachable only by the project that no longer exists.
 *
 * Measured on the maintainer's machine before this existed: 840 project roots,
 * 839 of them still holding run directories five days past a 24-hour
 * retention window. This project has already lost a disk to leaked scratch
 * directories once — tests/setup-env.ts records 2,605 orphans and 0 bytes free
 * on a 931 GB volume — which is why an unbounded leak gets fixed rather than
 * noted.
 *
 * Deliberately conservative, because this deletes directories nothing else is
 * watching:
 *  - never the caller's own root, which is about to be written into;
 *  - only when EVERY run inside is past retention, so one live run keeps its
 *    project root alive;
 *  - an empty root is removed only if it carries our marker. Unmarked and
 *    empty means there is nothing to identify it by, and an unidentified
 *    directory is somebody else's — measured, because this line previously
 *    claimed empty roots are removed full stop, which stopped being true when
 *    ownership moved from a name shape to a marker;
 *  - best effort throughout — a prune failure must never fail a dispatch.
 *
 * A git_worktree root is left alone here. Removing one behind git's back
 * strands `.git/worktrees` metadata, and the sweep above only knows how to
 * unregister worktrees for the repository the CURRENT dispatch belongs to.
 */
async function pruneAbandonedProjectRoots(base: string, currentRoot: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(base, entry.name);
    if (path.resolve(full) === path.resolve(currentRoot)) continue;
    try {
      const runs = await readdir(full, { withFileTypes: true });
      // Age is not evidence of ownership, and this deletes recursively.
      // HARNESS_DISPATCH_WORKSPACES_DIR is a setting the README actively
      // recommends ("on the project's own volume, for instance"), so the base
      // is not necessarily ours alone and anything else living there is
      // somebody's data.
      if (!isOurProjectRoot(full, runs.map((r) => r.name))) continue;
      let allStale = true;
      for (const run of runs) {
        if (run.name === ROOT_MARKER) continue;
        const runPath = path.join(full, run.name);
        // A worktree run needs git's own removal; leave the whole project
        // root to the owning repository rather than stranding metadata.
        if (existsSync(path.join(runPath, "worktree"))) {
          allStale = false;
          break;
        }
        const info = await stat(runPath);
        if (now - info.mtimeMs <= maxAgeMs) {
          allStale = false;
          break;
        }
      }
      if (allStale) await rm(full, { recursive: true, force: true });
    } catch {
      // best effort — locked, vanished, or permission-denied entries are skipped
    }
  }
}


function shouldExclude(relPath: string, direntName: string): boolean {
  if (EXCLUDED_DIRS.has(direntName)) return true;
  const normalized = relPath.split(path.sep).join("/");
  // Leftovers from installs before workspaces moved out of the project.
  return normalized === ".harness-dispatch/workspaces" || normalized.startsWith(".harness-dispatch/workspaces/");
}

/**
 * Never copy the workspace area into itself.
 *
 * shouldExclude covers ONE hard-coded path, which is fine for the default
 * (workspaces live outside the project) and catastrophic for the override that
 * README and the 0.7.0 notes actively recommend: point
 * HARNESS_DISPATCH_WORKSPACES_DIR at a directory inside the project — to keep
 * the copy on the same volume, where a reflink is possible — and the copy
 * walks into the workspace it is currently writing. Measured on a six-file
 * project: 201 levels of nesting and an 11,800-character path before the run
 * was killed, all of it inside the user's project.
 *
 * Compared as resolved absolute paths, so it does not matter how the override
 * was spelled, and it covers the whole workspaces root rather than this run's
 * directory alone — a sibling run's workspace is no more copyable than our own.
 */
export function isUnderOrEqual(candidate: string, root: string): boolean {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Recreate one symlink in the copy, but only if it stays inside the workspace.
 *
 * The previous version read the target and recreated it verbatim, with no
 * containment check, under a comment saying "preserve relative symlinks" over
 * code that preserved absolute ones just as happily. A link pointing at /etc
 * or a home directory was faithfully rebuilt inside the "isolated" copy, so an
 * agent writing through it wrote to the real host path — isolation defeated by
 * a link the agent may itself have created on an earlier turn.
 *
 * On Windows this happened to be inert: unprivileged fs.symlink fails EPERM
 * and the old bare `catch {}` swallowed it. That is an accident of platform
 * permissions, not a defence, and it does not hold on Linux or macOS where the
 * call succeeds. Verified on Windows with a directory JUNCTION, which needs no
 * privileges and which readdir reports as a symlink.
 *
 * Escaping links are dropped rather than followed. Copying the TARGET's
 * contents in would smuggle host files into the workspace — the same leak
 * pointing the other way.
 */
async function copyLink(
  sourceRoot: string,
  destRoot: string,
  childRel: string,
  skipped: string[],
): Promise<void> {
  const linkPath = path.join(sourceRoot, childRel);
  let target: string;
  try {
    target = await readlink(linkPath);
  } catch {
    return;
  }
  // Resolve against the link's own directory, exactly as the OS would.
  const resolved = path.resolve(path.dirname(linkPath), target);
  const rel = path.relative(sourceRoot, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    skipped.push(`${childRel} -> ${target}`);
    return;
  }
  try {
    await symlink(target, path.join(destRoot, childRel));
  } catch {
    // Best effort: Windows refuses symlink creation without privileges, and a
    // missing in-tree link is a far smaller problem than an escaping one.
  }
}

async function copyTree(
  sourceRoot: string,
  destRoot: string,
  rel = "",
  skipped: string[] = [],
  vanished: string[] = [],
  excludeRoots: string[] = [],
  /**
   * EXCLUDED_DIRS entries that actually existed and were left out. Collected
   * because the omission was invisible: `bin`, `dist`, `build`, `target`,
   * `obj` and `.venv` are all on that list and all plausible SOURCE
   * directories, and an acceptance pass watched a delegate "edit" a committed
   * `bin/tool.sh` that was never in its workspace — the run then reported one
   * changed file, the patch held one file, and apply landed one file, with
   * nothing anywhere saying the rest of the tree had been withheld. The agent
   * also reasons from an incomplete tree, which is the worse half.
   */
  excludedDirs: string[] = [],
): Promise<void> {
  const sourceDir = rel ? path.join(sourceRoot, rel) : sourceRoot;
  const destDir = rel ? path.join(destRoot, rel) : destRoot;
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    try {
      if (entry.isDirectory()) {
        if (shouldExclude(childRel, entry.name)) {
          // Only the name-list exclusions are reported. The workspaces-root
          // ones below are this tool's own scratch space and mean nothing to
          // the user; `.git` is excluded on every branch and would be noise on
          // every single run.
          if (EXCLUDED_DIRS.has(entry.name) && entry.name !== ".git") {
            excludedDirs.push(childRel.split(path.sep).join("/"));
          }
          continue;
        }
        const childAbs = path.join(sourceDir, entry.name);
        if (excludeRoots.some((root) => isUnderOrEqual(childAbs, root))) continue;
        await copyTree(sourceRoot, destRoot, childRel, skipped, vanished, excludeRoots, excludedDirs);
        continue;
      }
      if (entry.isFile()) {
        // COPYFILE_FICLONE asks the filesystem for a copy-on-write reflink:
        // the new file shares the original's blocks until one of them is
        // written to. On APFS, Btrfs/XFS and ReFS/Dev Drive that makes a
        // workspace clone near-instant and free of duplicate allocation,
        // which matters because `copy` duplicates a whole project per
        // dispatch and fanout does it per arm.
        //
        // FICLONE, deliberately NOT FICLONE_FORCE: the plain flag falls back
        // to an ordinary copy when the filesystem cannot reflink (plain NTFS,
        // ext4, or a cross-device copy), while FORCE fails outright. A
        // best-effort speedup must never turn a working copy into an error.
        await copyFile(
          path.join(sourceRoot, childRel),
          path.join(destRoot, childRel),
          fsConstants.COPYFILE_FICLONE,
        );
        continue;
      }
      if (entry.isSymbolicLink()) {
        await copyLink(sourceRoot, destRoot, childRel, skipped);
      }
    } catch (err) {
      // A working directory is LIVE while it is being copied. readdir gives a
      // listing, and by the time each entry is read it may be gone — an editor
      // saving over a temp file, a build watcher cleaning output, another
      // fanout arm writing into the same tree (write-capable fanout REQUIRES
      // copy, so concurrent copies of one directory are the documented case,
      // not an edge one). Failing the whole dispatch on a raw ENOENT because
      // one incidental file blinked out is the wrong trade: the caller loses
      // real work over a file they did not care about.
      //
      // Only "it disappeared" is tolerated. A permission error or a full disk
      // still fails loudly, because those mean the copy is not the snapshot it
      // claims to be for reasons that will not have fixed themselves.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
      vanished.push(childRel.split(path.sep).join("/"));
    }
  }
}

async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  const data = await readFile(filePath);
  return {
    hash: createHash("sha256").update(data).digest("hex"),
    size: data.byteLength,
    eolHash: eolDigest(data),
  };
}

/**
 * The digest WorkspaceFileChange.baseHash carries. Exported so the apply-time
 * divergence check computes it exactly the same way — two spellings of "same
 * content" is how this area produces false conflicts.
 */
export function eolDigest(data: Buffer): string {
  return createHash("sha256")
    .update(data.toString("utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
}

async function fingerprintTree(root: string, rel = "", out: FingerprintMap = new Map()): Promise<FingerprintMap> {
  const current = rel ? path.join(root, rel) : root;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (shouldExclude(childRel, entry.name)) continue;
      await fingerprintTree(root, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      out.set(childRel.split(path.sep).join("/"), await fingerprintFile(path.join(root, childRel)));
    } catch (err) {
      // Same race, other end: a file listed a moment ago can be gone before it
      // is hashed. An absent file simply does not appear in the fingerprint,
      // which diffFingerprints already reads as "deleted" — the truth.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  return out;
}

function diffFingerprints(before: FingerprintMap, after: FingerprintMap): WorkspaceFileChange[] {
  const changes: WorkspaceFileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...paths].sort()) {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (!oldFile && newFile) {
      // No base recorded: the file did not exist when the dispatch started.
      changes.push({ path: filePath, kind: "added" });
      continue;
    }
    if (oldFile && !newFile) {
      changes.push({ path: filePath, kind: "deleted", baseHash: oldFile.eolHash });
      continue;
    }
    if (oldFile && newFile && (oldFile.hash !== newFile.hash || oldFile.size !== newFile.size)) {
      changes.push({ path: filePath, kind: "modified", baseHash: oldFile.eolHash });
    }
  }
  return changes;
}

function mapFiles(files: string[], originalWorkingDir: string, effectiveWorkingDir: string): string[] {
  return files.map((file) => {
    const resolved = path.resolve(file);
    const rel = path.relative(originalWorkingDir, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return path.join(effectiveWorkingDir, rel);
    }
    // Deliberately passed through unmapped: there is nothing inside the
    // isolated workspace that corresponds to a file from outside it, and
    // rewriting the path would hand the agent a path that doesn't exist.
    // The cost is real though — see escapedFiles() — so callers warn.
    return file;
  });
}

/**
 * Files that sit outside `workingDir`, i.e. the ones mapFiles cannot bring
 * into an isolated workspace.
 *
 * These are not merely "still readable at their original path". On CLI routes
 * each such file's PARENT DIRECTORY is passed to the spawned agent as an
 * access grant (generic-cli.ts includedDirectories -> {{file_dirs}} ->
 * `--add-dir`), so under workspace_policy copy/git_worktree a single
 * out-of-tree entry silently widens the "isolated" workspace to include a
 * host directory. files: ["~/.ssh/id_rsa"] grants ~/.ssh.
 *
 * Isolation is the caller's stated intent, so this is surfaced as a warning
 * rather than silently honoured or silently dropped.
 */
export function escapedFiles(files: string[], originalWorkingDir: string): string[] {
  const root = resolveDir(originalWorkingDir);
  const out = new Set<string>();
  for (const file of files) {
    const rel = path.relative(root, path.resolve(file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      out.add(path.dirname(path.resolve(file)));
    }
  }
  return [...out];
}

function diffSummary(changes: WorkspaceFileChange[]): string {
  if (changes.length === 0) return "No file changes detected in the agent workspace.";
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return `${changes.length} changed file(s): ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted.`;
}

/**
 * Note appended to an isolated run when `files` reach outside workingDir.
 *
 * Silence here would be the worst option: the caller asked for isolation and
 * would reasonably assume they got it, while the agent was handed host
 * directories via --add-dir.
 */
function escapeNote(files: string[], originalWorkingDir: string): string[] {
  const dirs = escapedFiles(files, originalWorkingDir);
  if (dirs.length === 0) return [];
  return [
    `ISOLATION WIDENED: ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} outside ` +
      `the workspace ${dirs.length === 1 ? "was" : "were"} granted to the agent because \`files\` referenced them — ` +
      `${dirs.join(", ")}. Those paths are NOT isolated; edits there hit the real filesystem.`,
  ];
}

function attachWorkspace(result: DispatchResult, workspace: WorkspaceRun): DispatchResult {
  return {
    ...result,
    workspace,
  };
}

async function prepareSharedWorkspace(
  policy: "shared" | "shared_locked",
  workingDir: string,
  files: string[],
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  return {
    policy,
    originalWorkingDir,
    effectiveWorkingDir: originalWorkingDir,
    files,
    isolated: false,
    async finish(result) {
      return attachWorkspace(result, {
        policy,
        originalWorkingDir,
        effectiveWorkingDir: originalWorkingDir,
        isolated: false,
        securityBoundary: "none",
        notes:
          policy === "shared_locked"
            ? ["Write-capable shared workspace dispatches are serialized across ALL processes, not just within one."]
            : ["Shared workspace dispatches run directly in the caller's working directory."],
      });
    },
  };
}

async function prepareCopyWorkspace(
  routeName: string,
  workingDir: string,
  files: string[],
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  const root = workspaceRootFor(originalWorkingDir);
  const projectGitRoot = await git(["rev-parse", "--show-toplevel"], originalWorkingDir)
    .then((out) => out || undefined)
    .catch(() => undefined);
  const workspaceRoot = await secureRunDirectory(root, routeName, projectGitRoot);
  const effectiveWorkingDir = path.join(workspaceRoot, "workspace");
  const skippedLinks: string[] = [];
  const vanishedFiles: string[] = [];
  const excludedDirs: string[] = [];
  // The whole workspaces BASE, not this run's directory and not even this
  // project's root under it. A sibling run's workspace is no more copyable
  // than our own, and another project's is no more copyable than a sibling's —
  // all of them sit inside the source tree whenever the override points there.
  await copyTree(
    originalWorkingDir,
    effectiveWorkingDir,
    "",
    skippedLinks,
    vanishedFiles,
    [workspacesBase()],
    excludedDirs,
  );
  const before = await fingerprintTree(effectiveWorkingDir);
  return {
    policy: "copy",
    originalWorkingDir,
    effectiveWorkingDir,
    files: mapFiles(files, originalWorkingDir, effectiveWorkingDir),
    isolated: true,
    workspaceRoot,
    async finish(result) {
      const after = await fingerprintTree(effectiveWorkingDir);
      const changedFiles = diffFingerprints(before, after);
      return attachWorkspace(result, {
        policy: "copy",
        originalWorkingDir,
        effectiveWorkingDir,
        workspaceRoot,
        isolated: true,
        securityBoundary: "project_state_and_process_cwd",
        changedFiles,
        diffSummary: diffSummary(changedFiles),
        cleanupHint: `Remove ${workspaceRoot} when the isolated result is no longer needed.`,
        notes: [
          "The source workspace was copied before dispatch, so edits in the agent workspace are not applied automatically.",
          "This isolates project state, but it is not a hardened OS sandbox for commands with host filesystem access.",
          ...(vanishedFiles.length > 0
            ? [
                `${vanishedFiles.length} file(s) disappeared while the workspace was being ` +
                  `copied and are absent from it: ${vanishedFiles.slice(0, 5).join(", ")}` +
                  `${vanishedFiles.length > 5 ? ", …" : ""}. The copy is a snapshot of a ` +
                  `directory that was being written to.`,
              ]
            : []),
          ...(excludedDirs.length > 0
            ? [
                `${excludedDirs.length} director(ies) were NOT copied into the workspace and were ` +
                  `invisible to the agent: ${excludedDirs.slice(0, 8).join(", ")}` +
                  `${excludedDirs.length > 8 ? ", …" : ""}. These names are excluded as build ` +
                  `output or dependencies, but some of them (bin, dist, build, target, obj) are ` +
                  `real source directories in some projects — if the task needed one, the agent ` +
                  `worked from an incomplete tree and no change to it can appear in the patch.`,
              ]
            : []),
          ...(skippedLinks.length > 0
            ? [
                `Dropped ${skippedLinks.length} symlink(s) pointing outside the workspace, which would ` +
                  `otherwise have resolved to real host paths from inside the copy: ${skippedLinks.join(", ")}.`,
              ]
            : []),
          ...escapeNote(files, originalWorkingDir),
        ],
      });
    },
  };
}

/**
 * Decline git's OPTIONAL locks.
 *
 * git runs background maintenance, which creates and removes
 * `.git/objects/maintenance.lock` underneath whatever else is reading the
 * repository. A CI leg failed with `stat '.../maintenance.lock': No such file
 * or directory` from an ordinary diff — the lock vanished mid-command. We only
 * ever ask git to read, or to apply a patch we already hold, so declining
 * optional locks costs nothing and removes a race we do not control.
 */
export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, windowsHide: true, env: GIT_ENV });
  return String(stdout).trim();
}

async function prepareGitWorktreeWorkspace(
  routeName: string,
  workingDir: string,
  files: string[],
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  // Preconditions answered as themselves, not as whatever git printed.
  //
  // The resolve path (`workspace diff`/`apply`) explains a missing git and a
  // long path; the DISPATCH path had none of it, so the three ordinary ways
  // this cannot start reached the caller as raw git internals with no route
  // taken and no mention of the alternative — an acceptance pass measured
  // `spawn git ENOENT`, `fatal: not a git repository`, and
  // `fatal: ambiguous argument 'HEAD'` on a freshly-initialised project, which
  // is an ordinary state rather than an error.
  const gitRoot = await git(["rev-parse", "--show-toplevel"], originalWorkingDir).catch(
    (err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === "ENOENT") {
        throw new Error(
          "workspace_policy: git_worktree needs git on PATH, and it was not found. Install " +
            "git, or use workspace_policy: copy, which needs no git. `doctor` reports whether " +
            "it found one.",
        );
      }
      throw new Error(
        `workspace_policy: git_worktree needs ${originalWorkingDir} to be inside a git ` +
          `repository, and it is not. Use workspace_policy: copy for a directory that is not ` +
          `version-controlled.`,
      );
    },
  );
  const prefix = await git(["rev-parse", "--show-prefix"], originalWorkingDir);
  const gitWorkspaceRoot = workspaceRootFor(gitRoot);
  const workspaceRoot = await secureRunDirectory(gitWorkspaceRoot, routeName, gitRoot);
  const worktreeRoot = path.join(workspaceRoot, "worktree");
  // A repository with no commits yet is an ordinary state, not a fault, and
  // `git worktree add` has nothing to branch from in it.
  const baseCommit = await git(["rev-parse", "HEAD"], gitRoot).catch(() => {
    throw new Error(
      `workspace_policy: git_worktree needs at least one commit to branch a worktree from, ` +
        `and ${gitRoot} has none yet. Make an initial commit, or use workspace_policy: copy.`,
    );
  });
  await git(["worktree", "add", "--detach", worktreeRoot, baseCommit], gitRoot);
  const effectiveWorkingDir = prefix ? path.join(worktreeRoot, prefix) : worktreeRoot;
  await stat(effectiveWorkingDir);
  const before = await fingerprintTree(worktreeRoot);
  return {
    policy: "git_worktree",
    originalWorkingDir,
    effectiveWorkingDir,
    files: mapFiles(files, gitRoot, worktreeRoot),
    isolated: true,
    workspaceRoot,
    async finish(result) {
      const after = await fingerprintTree(worktreeRoot);
      const changedFiles = diffFingerprints(before, after);

      // A failed attempt that changed nothing leaves nothing to inspect, and
      // its worktree is a registration inside the USER's repository that
      // retention will never reclaim — the sweep deliberately refuses to
      // remove worktrees, because unregistering one needs git and only the
      // owning repo can do it.
      //
      // So they accumulate per attempt, and the ones nobody knows about are
      // the worst: a fallback arm that fails is not named in the response at
      // all, so its worktree has no cleanupHint anywhere. An acceptance pass
      // measured one HTTP request leaving TWO entries in `git worktree list`.
      // This project has already paid for one unbounded directory leak.
      //
      // Only when the attempt both failed AND changed nothing. A failure that
      // wrote files may still hold work worth recovering, and deleting that
      // to tidy up would be the trade this codebase keeps refusing.
      if (!result.success && changedFiles.length === 0) {
        // The directory goes only if GIT let go of it first.
        //
        // The first version swallowed the result of `git worktree remove`,
        // deleted the directory regardless, and reported "unregistered and
        // removed" either way. When git fails — an index lock, a concurrent
        // git operation — that strands `.git/worktrees/<name>` inside the
        // user's repository, which is the exact outcome the comment above
        // says this refuses to cause, while telling them it did not happen.
        // An acceptance pass caught it by reading, inside the fix that
        // introduced it.
        const unregistered = await git(["worktree", "remove", "--force", worktreeRoot], gitRoot)
          .then(() => true)
          .catch(() => false);
        if (unregistered) {
          await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
          return attachWorkspace(result, {
            policy: "git_worktree",
            originalWorkingDir,
            effectiveWorkingDir,
            baseCommit,
            isolated: true,
            securityBoundary: "project_state_and_process_cwd",
            changedFiles,
            diffSummary: diffSummary(changedFiles),
            notes: [
              "This attempt failed without changing any file, so its git worktree was " +
                "unregistered and removed rather than left in your repository.",
            ],
          });
        }
        // Fall through: git still owns it, so it is reported like any other
        // retained worktree, with the hint that names how to remove it.
      }

      return attachWorkspace(result, {
        policy: "git_worktree",
        originalWorkingDir,
        effectiveWorkingDir,
        workspaceRoot,
        baseCommit,
        isolated: true,
        securityBoundary: "project_state_and_process_cwd",
        changedFiles,
        diffSummary: diffSummary(changedFiles),
        cleanupHint: `Run git -C ${gitRoot} worktree remove ${worktreeRoot} when the isolated result is no longer needed.`,
        notes: [
          "The git worktree starts from HEAD; uncommitted source-workspace changes are not copied into it.",
          "This isolates project state, but it is not a hardened OS sandbox for commands with host filesystem access.",
          ...escapeNote(files, originalWorkingDir),
        ],
      });
    },
  };
}

export async function prepareWorkspace(opts: {
  routeName: string;
  policy: WorkspacePolicy;
  workingDir: string;
  files: string[];
}): Promise<PreparedWorkspace> {
  switch (opts.policy) {
    case "shared":
    case "shared_locked":
      return prepareSharedWorkspace(opts.policy, opts.workingDir, opts.files);
    case "copy":
      return prepareCopyWorkspace(opts.routeName, opts.workingDir, opts.files);
    case "git_worktree":
      return prepareGitWorktreeWorkspace(opts.routeName, opts.workingDir, opts.files);
  }
}
