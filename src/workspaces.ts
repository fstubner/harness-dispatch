import { execFile as execFileCb } from "node:child_process";
import { dirFromEnv } from "./state-dir.js";
import { spawnablePath } from "./dispatchers/shared/which-available.js";
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
  unlink,
  utimes,
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

/**
 * Directory names a copy never copies and the change fingerprint never walks.
 * ONE list for both policies' fingerprints; tests/workspace-audit5.test.ts pins
 * that `git_worktree`'s changedFiles agrees with git's patch for every name here.
 *
 * It is the fingerprint that has this list, not git, so the two only agree
 * where the fingerprint is told what git knows. A copy leaves these directories
 * out entirely (and says so). A worktree is a checkout, so a `bin/` in it is
 * TRACKED and its edits are in the patch: its fingerprint walks every excluded
 * directory that exists at checkout time and skips only the ones the agent
 * creates afterwards (see `FingerprintOptions.walkExcluded`).
 */
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
   * Digest over content with CRLF collapsed to LF, kept ALONGSIDE `hash`.
   *
   * `hash` decides whether the AGENT changed a file, where an edit that only
   * rewrites line endings is a real edit. `eolHash` answers whether the USER's
   * copy has moved since the dispatch started, where a checkout whose eol
   * settings rewrote the file on the way in must NOT read as a change.
   */
  eolHash: string;
  /**
   * The file's stat when it was hashed, so a later pass can skip re-reading a
   * file whose stat has not moved. Absent on entries that were not stat'ed.
   */
  mtimeMs?: number;
  ctimeMs?: number;
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
 * that makes real ones rather than by hand: a name this function cannot
 * generate asserts something about an input that never occurs.
 */
export function workspaceRunId(routeName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${safeName(routeName)}-${randomUUID().slice(0, 8)}`;
}

function resolveDir(workingDir: string): string {
  return path.resolve(workingDir || process.cwd());
}

/**
 * The directory all per-project workspace roots hang off.
 *
 * Isolated workspaces live OUTSIDE the project, for both policies. A copy
 * nested inside the project it isolates from is walked by
 * `git diff --no-index <project> <copy>` while it scans the project, so
 * created files pair up as renames and sibling jobs' retained workspaces show
 * up as deletions — applying one job's patch then destroys another delegate's
 * only copy of its work. The cost is that a temp dir on another volume cannot
 * reflink; HARNESS_DISPATCH_WORKSPACES_DIR overrides the location for anyone
 * who wants the copy on the project's volume.
 *
 * Exported because the apply-time dirty check has to know it too: with the
 * override pointed inside the project, the workspaces directory is itself an
 * untracked change and `apply` would refuse on an otherwise pristine tree.
 */
export function workspacesBase(): string {
  return dirFromEnv("HARNESS_DISPATCH_WORKSPACES_DIR", () =>
    path.join(os.tmpdir(), defaultWorkspacesFolder(), "workspaces"),
  );
}

/**
 * `harness-dispatch` on Windows, `harness-dispatch-<uid>` on POSIX.
 *
 * On Windows `os.tmpdir()` is already per-user, so a bare name is correct
 * there. On Linux `/tmp` is shared, and without a uid segment whoever
 * dispatches FIRST owns `/tmp/harness-dispatch` 0700 and the ownership guard
 * then refuses `copy` and `git_worktree` to every other user on the machine —
 * including the user themselves, after one `sudo` run leaves the directory
 * owned by root. The per-user directory is still created 0700 and still
 * ownership-checked, so the guard is unweakened.
 */
function defaultWorkspacesFolder(): string {
  if (process.platform === "win32") return "harness-dispatch";
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined ? "harness-dispatch" : `harness-dispatch-${uid}`;
}

/** Exported for tests, for the same reason as `workspaceRunId`. */
export function workspaceRootFor(originalWorkingDir: string): string {
  const base = workspacesBase();
  // The per-project segment applies to the override too: without it, every
  // project pointed at one HARNESS_DISPATCH_WORKSPACES_DIR shares a flat
  // directory, so a dispatch in project B prunes project A's aged workspaces
  // and can strand A's git metadata. Keyed on the full path rather than the
  // basename, because two checkouts both called `api` are a normal thing to
  // have; the basename stays in the name to keep it recognisable by eye.
  return path.join(base, `${safeName(path.basename(originalWorkingDir))}-${pathKey(originalWorkingDir)}`);
}

/**
 * Written into every project root this tool creates, so reclamation can delete
 * a directory because it KNOWS it made it. A name shape cannot answer that:
 * eight decimal digits are valid hex, so `-[0-9a-f]{8}$` matches any
 * `<name>-<YYYYMMDD>`, someone else's `backup-20260401` included.
 */
const ROOT_MARKER = ".harness-dispatch-root";

/**
 * The shape `workspaceRunId` generates: an ISO stamp, pid, route, 8 hex.
 * Used ONLY to recognise roots created before the marker existed, so those are
 * still reclaimed instead of leaking forever.
 */
const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-.+-[0-9a-f]{8}$/;

/**
 * Whether `dir` is a directory of workspaces rather than one workspace: a
 * project root this tool marked, or one holding run directories. Discard
 * refuses such a directory, since deleting it deletes every run inside.
 */
export async function holdsWorkspaceRuns(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.name === ROOT_MARKER || (e.isDirectory() && RUN_DIR_RE.test(e.name)),
  );
}

/**
 * Refuse one already-existing workspace path segment we cannot vouch for, and
 * bring the ones we can up to 0700.
 *
 * A workspace path is fully deterministic inside a possibly SHARED
 * `os.tmpdir()`, so another local user can create it first. Then it is theirs:
 * chmod fails, and copying the project into it would hand them the source —
 * not a mode to fix but a directory to refuse. The chmod is needed as well as
 * `mkdir`'s `mode:`, which applies only to directories mkdir creates.
 *
 * Ownership and mode are POSIX-only: `uid` is 0 for every process on Windows,
 * Node ignores mode there, and `os.tmpdir()` is already per-user.
 */
async function verifySegment(dir: string): Promise<void> {
  const info = await lstat(dir);
  // Symlink check on EVERY platform, unlike the ownership and mode checks
  // below. Junctions need no privileges on Windows and `lstat` reports them as
  // symbolic links, so one planted at the workspace path takes a whole project
  // into the attacker's directory.
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
 * Costs one `lstat`, and turns "checked minutes ago" into "checked a syscall
 * ago".
 */
export async function assertStillOurs(dir: string): Promise<void> {
  await verifySegment(dir);
}

/**
 * The anchor, resolved. Above this we do not police; below it we do.
 *
 * `path.resolve` rather than a `startsWith` against the raw string: a
 * HARNESS_DISPATCH_WORKSPACES_DIR written with a trailing slash or containing
 * `..` would otherwise fail to match and turn the guard off silently.
 */
async function resolvedAnchor(): Promise<{ declared: string; resolved: string }> {
  // Same rule as everywhere else: an empty value means "not set". Read
  // directly rather than through workspacesBase() because the anchor is the
  // configured directory itself, not the `workspaces` subdirectory under it.
  const anchor = dirFromEnv("HARNESS_DISPATCH_WORKSPACES_DIR", () => os.tmpdir());

  // VERIFY THE NEAREST EXISTING ANCESTOR BEFORE CREATING ANYTHING. Creating
  // the anchor first would be a "touch, then check": with a link at
  // `<tmp>/hd`, a recursive mkdir of `<tmp>/hd/workspaces` traverses it and
  // leaves a directory inside the attacker's tree before the refusal arrives.
  let existing = anchor;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  // realpath here, not lstat: the anchor is allowed to BE a link, because
  // os.tmpdir() is one on macOS (`/var` -> `/private/var`). What must hold is
  // that wherever it lands belongs to us.
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
  // Computing them between the resolved ancestor and the declared anchor
  // yields `..` components whenever the two differ — i.e. on every macOS
  // machine. The resolve happens once, at the end, after the chain exists.
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
  // BOTH values are returned, and the distinction is load-bearing. `declared`
  // is what the rest of the module derives paths from (`workspacesBase()`
  // builds on the unresolved `os.tmpdir()`), `resolved` is where those paths
  // actually land. Comparing a declared target against the RESOLVED anchor is
  // wrong on macOS, where `os.tmpdir()` resolves through `/private`: every
  // legitimate run then looks like it is outside the anchor and is refused.
  return { declared: path.resolve(anchor), resolved: await realpath(current) };
}

/**
 * Create and verify every segment from the anchor down to `root`, and return
 * the verified path.
 *
 * Not a check-then-use guard: inspecting a path string and then letting later
 * writes re-resolve it lets a directory swapped for a symlink mid-copy
 * redirect the rest of it. Every segment from the anchor down is created here
 * with a non-recursive mkdir, which cannot traverse a link we did not make,
 * and the verified fully-resolved directory is RETURNED so callers use that
 * value rather than re-deriving the string.
 *
 * The anchor is HARNESS_DISPATCH_WORKSPACES_DIR or the system temp directory.
 * Above it is not ours to police, which is why it is RESOLVED rather than
 * refused; everything below it is ours, and a link there is refused.
 *
 * `mkdir`/`lstat` name a path, not an open handle, and Node exposes no
 * `openat`/`O_NOFOLLOW`, so a swap between two syscalls remains possible. The
 * window is one syscall rather than the whole dispatch, and every destructive
 * operation re-verifies via `assertStillOurs`.
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
    // A link can only enter the chain by existing first, and then mkdir fails
    // with EEXIST and we inspect it rather than following it.
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
 * Callers must use the returned value rather than the string they passed in: a
 * caller that re-resolves its own copy of the path on each write can be
 * redirected by a directory swapped for a symlink mid-copy. The MARKER is best
 * effort; creating and verifying the directory is not, and must not be
 * swallowed.
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
    // Freshened on every dispatch: the marker's age is what tells another
    // project's prune that this root is in use right now, in the moment before
    // this dispatch has created its run directory inside it.
    const now = new Date();
    await utimes(marker, now, now);
  } catch {
    // A root without its marker is merely not reclaimed automatically.
  }
  return verified;
}

/**
 * Is this directory one we created, and therefore ours to delete?
 *
 * The marker settles it. The fallback covers roots created before the marker
 * existed: every child must be a generated run directory, and there must be at
 * least one — an empty unmarked directory is somebody else's. This deletes
 * recursively, so it takes positive evidence rather than the absence of a
 * reason to stop.
 */
const PROJECT_ROOT_RE = /^.+-[0-9a-f]{8}$/;

function isOurProjectRoot(full: string, children: string[]): boolean {
  // The NAME must fit too, not just the marker: the marker is an ordinary file
  // and anything that can write to the workspaces base can create one,
  // including a delegated agent when HARNESS_DISPATCH_WORKSPACES_DIR points
  // inside the project. Requiring the generated shape as well does not make
  // this unforgeable — same uid means no permission check can separate the
  // caller from the attacker — but combined with reclamation only ever running
  // inside our own base, it is the honest limit of what is checkable here.
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
  // Positive only: 0 read as "no age at all" deleted every workspace of the
  // project, live ones included, on the next isolated dispatch.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_MAX_AGE_MS;
}

/**
 * Proof that a run is still going. A directory's mtime moves only when its
 * DIRECT entries change, and an agent writes deeper than that, so judging a run
 * by its directory alone deleted live workspaces once a job outlasted the
 * retention age (measured: HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS lowered, or a
 * `timeoutMs` past 24 h). Sits in the run directory, outside the workspace, so
 * it is never copied, fingerprinted or patched.
 */
const HEARTBEAT_FILE = ".alive";

/**
 * Longest a heartbeat keeps going. A run whose `finish` never came (an
 * abandoned stream inside a long-lived server) must not pin its workspace for
 * the life of the process.
 */
const HEARTBEAT_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The id of the job that created a run directory, written when it is created.
 *
 * Discard deletes the directory a job's record names, and the record is a
 * file on disk anyone with access to the state directory can edit. Pointed at
 * another job's run directory, it passed every other check, so a forced
 * discard deleted that job's unapplied work. This is what lets discard prove
 * the directory is the asking job's own. Sits in the run directory beside the
 * heartbeat, outside the workspace, so it is never copied or patched.
 */
const OWNER_FILE = ".owner";

/**
 * Record `jobId` as the creator of the new run directory `runDir`. Exported
 * for tests that build run directories by hand, for the same reason as
 * `workspaceRunId`.
 */
export async function recordWorkspaceOwner(runDir: string, jobId: string): Promise<void> {
  await writeFile(path.join(runDir, OWNER_FILE), jobId, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/** The job recorded as having created `runDir`, or undefined when none is. */
export async function workspaceOwner(runDir: string): Promise<string | undefined> {
  try {
    return (await readFile(path.join(runDir, OWNER_FILE), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep this run's heartbeat fresh until the returned function is called, which
 * also removes the file — leaving the directory's mtime at the finish time, so
 * retention counts from the end of the run.
 */
async function startHeartbeat(workspaceRoot: string): Promise<() => Promise<void>> {
  const file = path.join(workspaceRoot, HEARTBEAT_FILE);
  const beat = (): Promise<void> =>
    writeFile(file, "").catch(() => undefined);
  await beat();
  const started = Date.now();
  // Often enough that a lowered max age still sees a fresh stamp.
  const period = Math.min(60_000, Math.max(100, workspaceMaxAgeMs() / 4));
  const timer = setInterval(() => {
    if (Date.now() - started > HEARTBEAT_MAX_MS) clearInterval(timer);
    else void beat();
  }, period);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await rm(file, { force: true }).catch(() => undefined);
  };
}

/** When a run last showed signs of life: its directory, or its heartbeat if newer. */
async function lastActiveMs(runPath: string): Promise<number> {
  const dir = await stat(runPath);
  const beat = await stat(path.join(runPath, HEARTBEAT_FILE)).catch(() => undefined);
  return Math.max(dir.mtimeMs, beat?.mtimeMs ?? 0);
}

/**
 * Remove every symbolic link and directory junction at or under `dir` — the
 * link itself, never what it points at — so that whatever deletes `dir` next
 * finds only real files and directories.
 *
 * `git worktree remove --force` on Windows treats a junction as a directory:
 * it walks INTO it and deletes the target's contents before removing the
 * junction (measured, Git 2.45.1.windows.1: a folder outside the workspace
 * went from one file to none). A junction needs no privilege to create, so a
 * delegate with a shell could empty any folder the user can write by
 * planting one in its worktree. Node's own recursive `rm` removes a junction
 * without following it (measured on the same machine), so only git's removal
 * was exposed; this still runs before every workspace removal, so one rule
 * covers them all.
 *
 * Throws when a directory cannot be read or a link cannot be removed. The
 * caller must then not delete `dir`: a corner this could not examine may still
 * hold a link.
 */
export async function removeLinksWithin(dir: string): Promise<void> {
  const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";
  let info;
  try {
    info = await lstat(dir);
  } catch (err) {
    if (gone(err)) return;
    throw err;
  }
  if (info.isSymbolicLink()) {
    // On Windows `unlink` removes a directory junction itself (measured).
    await unlink(dir).catch((err: unknown) => {
      if (!gone(err)) throw err;
    });
    return;
  }
  if (!info.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (gone(err)) return;
    throw err;
  }
  // Sequential: a worktree can hold an installed dependency tree, and an
  // unbounded fan-out over it runs out of file handles.
  // A junction's entry reads as a symbolic link, not a directory (measured);
  // plain files are skipped without a stat each.
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      await removeLinksWithin(path.join(dir, entry.name));
    }
  }
}

/**
 * Delete this project's aged run directories, whatever policy made them.
 *
 * Shared by both isolation policies, so a guard added here cannot be added to
 * one policy and missed on the other.
 *
 * `gitRoot` is optional because only a project under git has worktrees to
 * unregister; the filesystem sweep is the same either way.
 */
async function pruneStaleRuns(root: string, gitRoot?: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  // Before the early return below, because a project dispatching for the FIRST
  // time has no root of its own to sweep and is the caller most likely to be on
  // a machine full of other projects' leftovers.
  //
  // The base is derived from `root`, NOT from workspacesBase(): `root` is the
  // VERIFIED, fully-resolved path and workspacesBase() the DECLARED one, so
  // where the two differ (every macOS box) the "exclude our own root"
  // comparison below would compare two different spaces, fail to match, and
  // delete the directory the dispatch just created.
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
    // Only directories WE named. A recursive delete takes positive evidence
    // that the thing is ours, rather than the absence of a reason to stop:
    // with a symlink planted at the root, an unchecked sweep reaches a user's
    // own files. `RUN_DIR_RE` is the exact shape `workspaceRunId` generates.
    if (!RUN_DIR_RE.test(entry.name)) continue;
    const workspaceRoot = path.join(root, entry.name);
    try {
      if (now - (await lastActiveMs(workspaceRoot)) <= maxAgeMs) continue;
      // Throws when it cannot finish, which skips this run entirely.
      await removeLinksWithin(workspaceRoot);
      // A `worktree` child is the tell that git still has this registered.
      const worktreeRoot = path.join(workspaceRoot, "worktree");
      if (gitRoot !== undefined && existsSync(worktreeRoot)) {
        try {
          await git(["worktree", "remove", "--force", worktreeRoot], gitRoot);
          removedWorktree = true;
        } catch {
          // Registered against a different repo, or already gone: the sweep
          // below still reclaims the disk and the prune afterwards clears
          // whatever metadata this repo can see.
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
 * SECURE BEFORE PRUNING. Sweeping first would `rm -rf` every aged
 * subdirectory of a root nothing had yet looked at, so a symlink planted at
 * that path takes the sweep into the victim's own directory.
 *
 * Shared by both isolation policies, so a guard cannot be added to one and
 * missed on the other.
 */
async function secureRunDirectory(
  projectRoot: string,
  routeName: string,
  gitRoot: string | undefined,
  jobId: string | undefined,
): Promise<string> {
  // Everything below uses the verified path markProjectRoot returns, never the
  // string the caller computed.
  const verifiedRoot = await markProjectRoot(projectRoot);
  await pruneStaleRuns(verifiedRoot, gitRoot);
  const workspaceRoot = path.join(verifiedRoot, workspaceRunId(routeName));
  // This run's directory is the segment an attacker would swap between the
  // prune and the write that follows, so it is created non-recursively here and
  // verified rather than left to a later recursive mkdir.
  try {
    await mkdir(workspaceRoot, { recursive: false, mode: 0o700 });
  } catch (err) {
    // Another project's prune can still remove this root in the instant
    // between its freshness check and its delete. Re-mark and try once more;
    // a second loss is not a race this code can win, so it surfaces.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await markProjectRoot(projectRoot);
    await mkdir(workspaceRoot, { recursive: false, mode: 0o700 });
  }
  await assertStillOurs(workspaceRoot);
  // Without a job (direct library use) there is no owner to record, and
  // discard, which is always asked about a job, refuses the directory.
  if (jobId !== undefined) await recordWorkspaceOwner(workspaceRoot, jobId);
  return workspaceRoot;
}

/**
 * Reclaim the per-project directories of projects that never dispatch again.
 *
 * The sweep above only ever looks INSIDE one project's root, and only runs
 * when a dispatch happens for that same project. So a project dispatched once
 * and then renamed, deleted, or — most commonly — created as a temp directory
 * by the test suite keeps its stale runs forever, and they accumulate without
 * bound: the code that would reclaim them is reachable only by the project
 * that no longer exists.
 *
 * Deliberately conservative, because this deletes directories nothing else is
 * watching:
 *  - never the caller's own root, which is about to be written into;
 *  - only when EVERY run inside is past retention, so one live run keeps its
 *    project root alive;
 *  - an empty root is removed only if it carries our marker. Unmarked and
 *    empty means there is nothing to identify it by, and an unidentified
 *    directory is somebody else's;
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
      // Age is not evidence of ownership, and this deletes recursively. With
      // HARNESS_DISPATCH_WORKSPACES_DIR set, the base is not necessarily ours
      // alone and anything else living there is somebody's data.
      if (!isOurProjectRoot(full, runs.map((r) => r.name))) continue;
      let allStale = true;
      for (const run of runs) {
        if (run.name === ROOT_MARKER) {
          // A root holding only its marker is either abandoned or a dispatch
          // that has just marked it and not yet made its run directory. Only
          // the marker's age tells the two apart; without this check,
          // concurrent isolated dispatches in different projects deleted each
          // other's roots mid-setup (measured: 19% of setups failed with two
          // projects starting together).
          const marked = await stat(path.join(full, ROOT_MARKER));
          if (now - marked.mtimeMs <= maxAgeMs) {
            allStale = false;
            break;
          }
          continue;
        }
        const runPath = path.join(full, run.name);
        // A worktree run needs git's own removal; leave the whole project
        // root to the owning repository rather than stranding metadata.
        if (existsSync(path.join(runPath, "worktree"))) {
          allStale = false;
          break;
        }
        if (now - (await lastActiveMs(runPath)) <= maxAgeMs) {
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
 * shouldExclude covers ONE hard-coded path, which is enough for the default
 * but not for HARNESS_DISPATCH_WORKSPACES_DIR pointed inside the project (to
 * keep the copy on one volume, where a reflink is possible): there the copy
 * walks into the workspace it is currently writing, nesting until the path
 * length kills the run.
 *
 * Compared as resolved absolute paths, so the override's spelling does not
 * matter, and it covers the whole workspaces root rather than this run's
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
 * A link pointing at /etc or a home directory, rebuilt verbatim inside the
 * "isolated" copy, means an agent writing through it writes to the real host
 * path. Windows is no exception: a directory JUNCTION needs no privileges and
 * readdir reports it as a symlink.
 *
 * Escaping links are dropped rather than followed — copying the TARGET's
 * contents in would smuggle host files into the workspace instead.
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

/**
 * How many files are copied or hashed at once.
 *
 * One await at a time left a 12,000-file project at minutes per run on Windows,
 * where the cost is per-file latency (first read after a write, antivirus), not
 * bandwidth, and only overlapping requests hide it. A fixed small bound keeps
 * fanout (one copy per arm) from exhausting file handles.
 */
const FILE_CONCURRENCY = 16;

/** Run at most `width` of the functions passed to the returned limiter at once. */
function createLimiter(width: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (fn) => {
    // A finishing task hands its slot straight to the next waiter, so `active`
    // never dips below the width while anyone is queued.
    if (active >= width) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Wait for EVERY task, then throw the first failure. Plain Promise.all would
 * reject at the first error while sibling copies kept writing into a workspace
 * the caller is about to give up on.
 */
async function settleAll(tasks: Array<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

interface CopyContext {
  sourceRoot: string;
  destRoot: string;
  skipped: string[];
  vanished: string[];
  excludeRoots: string[];
  /**
   * EXCLUDED_DIRS entries that actually existed and were left out. Collected
   * because the omission is otherwise invisible: `bin`, `dist`, `build`,
   * `target`, `obj` and `.venv` are all on that list and all plausible SOURCE
   * directories, so a delegate can "edit" a committed file that was never in
   * its workspace — and reasons from an incomplete tree either way.
   */
  excludedDirs: string[];
  /** The "before" fingerprint of the copy, filled in as each file lands. */
  fingerprints: FingerprintMap;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Copy one file and record its fingerprint, hashing the SOURCE bytes.
 *
 * The source was just read for the hash, so the copy reads it warm; reading the
 * freshly written destination afterwards is what cost most of the time. If the
 * source changed while this ran, the hash may not describe what landed, and the
 * destination is hashed instead — the answer the old two-pass code always gave.
 */
async function copyAndFingerprint(ctx: CopyContext, childRel: string): Promise<void> {
  const source = path.join(ctx.sourceRoot, childRel);
  const dest = path.join(ctx.destRoot, childRel);
  const sourceBefore = await stat(source);
  const data = await readFile(source);
  // COPYFILE_FICLONE asks the filesystem for a copy-on-write reflink, so
  // on APFS, Btrfs/XFS and ReFS/Dev Drive a workspace clone is
  // near-instant and allocates nothing — which matters because `copy`
  // duplicates a whole project per dispatch and fanout does it per arm.
  //
  // FICLONE, deliberately NOT FICLONE_FORCE: the plain flag falls back
  // to an ordinary copy where reflinks are unavailable (plain NTFS, ext4,
  // a cross-device copy), while FORCE fails outright. A best-effort
  // speedup must never turn a working copy into an error.
  await copyFile(source, dest, fsConstants.COPYFILE_FICLONE);
  const sourceAfter = await stat(source);
  const steady =
    sourceAfter.size === sourceBefore.size &&
    sourceAfter.mtimeMs === sourceBefore.mtimeMs &&
    data.byteLength === sourceBefore.size;
  const fingerprint = steady ? fingerprintOf(data) : await fingerprintFile(dest);
  const info = await stat(dest);
  ctx.fingerprints.set(childRel.split(path.sep).join("/"), {
    ...fingerprint,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  });
}

async function copyDir(ctx: CopyContext, rel: string): Promise<void> {
  const sourceDir = rel ? path.join(ctx.sourceRoot, rel) : ctx.sourceRoot;
  const destDir = rel ? path.join(ctx.destRoot, rel) : ctx.destRoot;
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await settleAll(
    entries.map(async (entry) => {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      try {
        if (entry.isDirectory()) {
          if (shouldExclude(childRel, entry.name)) {
            // Only the name-list exclusions are reported. The workspaces-root
            // ones below are this tool's own scratch space and mean nothing to
            // the user; `.git` is excluded on every branch and would be noise on
            // every single run.
            if (EXCLUDED_DIRS.has(entry.name) && entry.name !== ".git") {
              ctx.excludedDirs.push(childRel.split(path.sep).join("/"));
            }
            return;
          }
          const childAbs = path.join(sourceDir, entry.name);
          if (ctx.excludeRoots.some((root) => isUnderOrEqual(childAbs, root))) return;
          await copyDir(ctx, childRel);
          return;
        }
        if (entry.isFile()) {
          await ctx.limit(() => copyAndFingerprint(ctx, childRel));
          return;
        }
        if (entry.isSymbolicLink()) {
          await copyLink(ctx.sourceRoot, ctx.destRoot, childRel, ctx.skipped);
        }
      } catch (err) {
        // A working directory is LIVE while it is being copied: by the time each
        // readdir entry is read it may be gone — an editor saving over a temp
        // file, a build watcher cleaning output, another fanout arm writing into
        // the same tree (write-capable fanout REQUIRES copy, so concurrent copies
        // of one directory are the documented case). Failing the whole dispatch
        // because one incidental file blinked out loses the caller real work over
        // a file they did not care about.
        //
        // Only "it disappeared" is tolerated. A permission error or a full disk
        // still fails loudly, because those mean the copy is not the snapshot it
        // claims to be for reasons that will not have fixed themselves.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") throw err;
        ctx.vanished.push(childRel.split(path.sep).join("/"));
      }
    }),
  );
}

/**
 * Copy `sourceRoot` into `destRoot` and return the fingerprint of what landed.
 *
 * The three report arrays are filled in whatever order the concurrent walk
 * finishes, so they are sorted before anyone reads them.
 */
async function copyTree(
  sourceRoot: string,
  destRoot: string,
  skipped: string[],
  vanished: string[],
  excludeRoots: string[],
  excludedDirs: string[],
): Promise<FingerprintMap> {
  const fingerprints: FingerprintMap = new Map();
  await copyDir(
    {
      sourceRoot,
      destRoot,
      skipped,
      vanished,
      excludeRoots,
      excludedDirs,
      fingerprints,
      limit: createLimiter(FILE_CONCURRENCY),
    },
    "",
  );
  skipped.sort();
  vanished.sort();
  excludedDirs.sort();
  return fingerprints;
}

function fingerprintOf(data: Buffer): FileFingerprint {
  return {
    hash: createHash("sha256").update(data).digest("hex"),
    size: data.byteLength,
    eolHash: eolDigest(data),
  };
}

async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  return fingerprintOf(await readFile(filePath));
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

/**
 * A file stamped within this long of the snapshot may still be rewritten inside
 * the same timestamp tick, on a filesystem with coarse timestamps, without its
 * stat changing. Such files are always re-read. (Git's "racy" rule, for the
 * same reason.)
 */
const RACY_WINDOW_MS = 2000;

interface FingerprintOptions {
  /**
   * With this, a file whose size, mtime and ctime still match its entry in the
   * earlier fingerprint is not read again: the second pass of a run, over a tree
   * where the agent touched a handful of files, becomes a stat per file. ctime
   * is part of the match because it cannot be set back by `utimes`, so an edit
   * that restores size and mtime still shows.
   */
  reuse?: { before: FingerprintMap; settledAt: number };
  /**
   * Which EXCLUDED_DIRS directories to walk anyway: `"all"` (every one but
   * `.git`) or the set of relative paths a previous walk reported in `found`.
   * Default: none, which is what a copy wants, since it never copied them.
   *
   * A git_worktree is a checkout, so a directory named `bin` or `dist` in it
   * holds TRACKED files, and the patch (made by git) carries edits to them. The
   * walk must see them too, or `changedFiles` and the patch disagree about what
   * the agent changed. Directories the agent creates afterwards (`npm install`,
   * a build) are not in the first walk's `found`, so they stay out, as before.
   */
  walkExcluded?: "all" | ReadonlySet<string>;
  /** Filled with the relative path of every excluded directory that was walked. */
  found?: Set<string>;
}

/** Fingerprint every regular file under `root`, hashing through a bounded pool. Exported for tests. */
export async function fingerprintTree(root: string, opts: FingerprintOptions = {}): Promise<FingerprintMap> {
  const { reuse, walkExcluded, found } = opts;
  const out: FingerprintMap = new Map();
  const limit = createLimiter(FILE_CONCURRENCY);

  async function visit(rel: string): Promise<void> {
    const current = rel ? path.join(root, rel) : root;
    const entries = await readdir(current, { withFileTypes: true });
    await settleAll(
      entries.map(async (entry) => {
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        const key = childRel.split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (shouldExclude(childRel, entry.name)) {
            const walked =
              EXCLUDED_DIRS.has(entry.name) &&
              entry.name !== ".git" &&
              (walkExcluded === "all" || walkExcluded?.has(key) === true);
            if (!walked) return;
            found?.add(key);
          }
          await visit(childRel);
          return;
        }
        if (!entry.isFile()) return;
        await limit(async () => {
          const absolute = path.join(root, childRel);
          try {
            const info = await stat(absolute);
            const prior = reuse?.before.get(key);
            if (
              reuse &&
              prior &&
              prior.mtimeMs === info.mtimeMs &&
              prior.ctimeMs === info.ctimeMs &&
              prior.size === info.size &&
              Math.max(info.mtimeMs, info.ctimeMs) < reuse.settledAt - RACY_WINDOW_MS
            ) {
              out.set(key, prior);
              return;
            }
            out.set(key, { ...(await fingerprintFile(absolute)), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
          } catch (err) {
            // Same race, other end: a file listed a moment ago can be gone before it
            // is hashed. An absent file simply does not appear in the fingerprint,
            // which diffFingerprints already reads as "deleted" — the truth.
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
          }
        });
      }),
    );
  }

  await visit("");
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
    // Deliberately passed through unmapped: nothing inside the isolated
    // workspace corresponds to a file from outside it, so rewriting the path
    // would hand the agent one that doesn't exist. The cost is real — see
    // escapedFiles() — so callers warn.
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
 * `--add-dir`), so under copy/git_worktree a single out-of-tree entry widens
 * the "isolated" workspace to include a host directory: files:
 * ["~/.ssh/id_rsa"] grants ~/.ssh. Surfaced as a warning rather than silently
 * honoured or silently dropped, because isolation was the caller's intent.
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
 * Silence would leave the caller assuming they got the isolation they asked
 * for while the agent was handed host directories via --add-dir.
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

/**
 * Note for a shared run whose `files` reach outside the working directory.
 *
 * Distinct from `escapeNote`: there is no isolation to widen under `shared`,
 * so "ISOLATION WIDENED" would be false. The disclosure is the same, though —
 * naming one file grants the agent its whole parent directory.
 */
function grantNote(files: string[], originalWorkingDir: string): string[] {
  const dirs = escapedFiles(files, originalWorkingDir);
  if (dirs.length === 0) return [];
  return [
    `DIRECTORIES GRANTED: ${dirs.length} outside the working directory ` +
      `${dirs.length === 1 ? "was" : "were"} granted to the agent because \`files\` referenced ` +
      `${dirs.length === 1 ? "a file" : "files"} there — ${dirs.join(", ")}.`,
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
        notes: [
          policy === "shared_locked"
            ? "Write-capable shared workspace dispatches are serialized across ALL processes, not just within one."
            : "Shared workspace dispatches run directly in the caller's working directory.",
          // The `files` schema promises this warning unconditionally, and
          // `shared` is the default: a path outside workingDir grants its
          // parent directory via --add-dir here too.
          ...grantNote(files, originalWorkingDir),
        ],
      });
    },
  };
}

async function prepareCopyWorkspace(
  routeName: string,
  workingDir: string,
  files: string[],
  jobId: string | undefined,
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  const root = workspaceRootFor(originalWorkingDir);
  const projectGitRoot = await git(["rev-parse", "--show-toplevel"], originalWorkingDir)
    .then((out) => out || undefined)
    .catch(() => undefined);
  const workspaceRoot = await secureRunDirectory(root, routeName, projectGitRoot, jobId);
  const effectiveWorkingDir = path.join(workspaceRoot, "workspace");
  const skippedLinks: string[] = [];
  const vanishedFiles: string[] = [];
  const excludedDirs: string[] = [];
  // The whole workspaces BASE, not this run's directory and not even this
  // project's root under it: whenever the override points inside the project,
  // every run's workspace — ours, a sibling's, another project's — sits in the
  // source tree and none of them is copyable.
  const before = await copyTree(
    originalWorkingDir,
    effectiveWorkingDir,
    skippedLinks,
    vanishedFiles,
    [workspacesBase()],
    excludedDirs,
  );
  const settledAt = Date.now();
  const stopHeartbeat = await startHeartbeat(workspaceRoot);
  return {
    policy: "copy",
    originalWorkingDir,
    effectiveWorkingDir,
    files: mapFiles(files, originalWorkingDir, effectiveWorkingDir),
    isolated: true,
    workspaceRoot,
    async finish(result) {
      await stopHeartbeat();
      const after = await fingerprintTree(effectiveWorkingDir, { reuse: { before, settledAt } });
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
 * git's background maintenance creates and removes
 * `.git/objects/maintenance.lock` underneath whatever else is reading the
 * repository, so an ordinary diff can fail with `stat '.../maintenance.lock':
 * No such file or directory`. We only ever ask git to read, or to apply a patch
 * we already hold, so declining optional locks costs nothing.
 */
export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(spawnablePath("git"), args, { cwd, windowsHide: true, env: GIT_ENV });
  return String(stdout).trim();
}

/**
 * The leading git arguments for every command run INSIDE a git_worktree after
 * the agent has had it: the worktree's own registration, pinned, and no
 * config-driven command honoured from anything the agent could have written.
 *
 * Without this, git DISCOVERS its repository from the worktree, and the
 * worktree's `.git` is a file the agent can replace. An agent that only writes
 * files swapped it for a `.git` directory whose config set `core.fsmonitor`,
 * and harness-dispatch's own post-run `git add` / `git diff` then ran that
 * command as the user, outside any harness sandbox (audit5 F1). An embedded
 * repository the agent creates in a subdirectory reaches the same place
 * another way: `git diff` checks a gitlink for local changes by running
 * `git status` INSIDE it, which honours that repository's fsmonitor and its
 * clean filters (measured, git 2.45).
 *
 * So:
 *  - `--git-dir` is the registration under `<repo>/.git/worktrees/`, which
 *    lives in the user's project, outside the agent's tree. The worktree's
 *    gitfile is only read to find it, and is refused unless it points at
 *    exactly this worktree's registration — a replaced or redirected `.git`
 *    means nothing here runs git against the worktree at all.
 *  - `-c core.fsmonitor=false` and an unusable `core.hooksPath` reach every
 *    child git through GIT_CONFIG_PARAMETERS and outrank repository config,
 *    an embedded repository's included.
 *  - Callers that diff or ask for status also pass `--ignore-submodules=dirty`,
 *    so git never starts a child inside an embedded repository (its filters
 *    are not covered by the overrides above), and `--no-ext-diff
 *    --no-textconv` where a patch is produced. `git add` has no such option
 *    and overrides `diff.ignoreSubmodules`, so its callers exclude every
 *    gitlink path instead — see gitlinkExclusions in workspace-resolve.ts.
 *
 * Nothing run here fetches or pages, so `core.sshCommand`, `core.pager` and
 * credential helpers are never consulted; diff and filter drivers come only
 * from config, which with the gitdir pinned is the user's own.
 */
export async function worktreeGitArgs(worktreeRoot: string, projectDir: string): Promise<string[]> {
  const refuse = (why: string): Error =>
    new Error(
      `The git worktree at ${worktreeRoot} no longer points at its own registration in the ` +
        `project's repository (${why}). Only the agent that ran there could have changed ` +
        `that, and a repository written by the agent can make git run commands, so ` +
        `harness-dispatch will not run git against this worktree. Nothing has been applied. ` +
        `Inspect its files by hand, ignoring its .git.`,
    );
  const commonDir = path.resolve(
    projectDir,
    await git(["rev-parse", "--git-common-dir"], projectDir),
  );
  const gitfile = path.join(worktreeRoot, ".git");
  // Unreadable (EISDIR) when a `.git` directory was planted in place of the file.
  const content = await readFile(gitfile, "utf8").catch(() => undefined);
  const declared = content === undefined ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(content)?.[1];
  if (declared === undefined) throw refuse(".git is no longer a gitfile");
  const [adminDir, registrations] = await Promise.all([
    realpath(path.resolve(worktreeRoot, declared)).catch(() => undefined),
    realpath(path.join(commonDir, "worktrees")).catch(() => undefined),
  ]);
  if (
    adminDir === undefined ||
    registrations === undefined ||
    adminDir === registrations ||
    !isUnderOrEqual(adminDir, registrations)
  ) {
    throw refuse(".git points outside the repository's worktree registrations");
  }
  // And it must be THIS worktree's registration, not another job's.
  const backLink = await readFile(path.join(adminDir, "gitdir"), "utf8").catch(() => "");
  const [registered, actual] = await Promise.all([
    realpath(backLink.trim()).catch(() => undefined),
    realpath(gitfile).catch(() => undefined),
  ]);
  if (registered === undefined || registered !== actual) {
    throw refuse(".git points at another worktree's registration");
  }
  return [
    `--git-dir=${adminDir}`,
    `--work-tree=${worktreeRoot}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${os.devNull}`,
  ];
}

async function prepareGitWorktreeWorkspace(
  routeName: string,
  workingDir: string,
  files: string[],
  jobId: string | undefined,
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  // Preconditions answered as themselves, not as whatever git printed. The
  // three ordinary ways this cannot start — no git on PATH, not a repository,
  // no commits yet — would otherwise reach the caller as raw git internals
  // (`spawn git ENOENT`, `fatal: not a git repository`,
  // `fatal: ambiguous argument 'HEAD'`) with no mention of the alternative.
  const gitRoot = await git(["rev-parse", "--show-toplevel"], originalWorkingDir).catch(
    (err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === "ENOENT") {
        throw new Error(
          "workspacePolicy: git_worktree needs git on PATH, and it was not found. Install " +
            "git, or use workspacePolicy: copy, which needs no git. `doctor` reports whether " +
            "it found one.",
        );
      }
      throw new Error(
        `workspacePolicy: git_worktree needs ${originalWorkingDir} to be inside a git ` +
          `repository, and it is not. Use workspacePolicy: copy for a directory that is not ` +
          `version-controlled.`,
      );
    },
  );
  const prefix = await git(["rev-parse", "--show-prefix"], originalWorkingDir);
  const gitWorkspaceRoot = workspaceRootFor(gitRoot);
  const workspaceRoot = await secureRunDirectory(gitWorkspaceRoot, routeName, gitRoot, jobId);
  const worktreeRoot = path.join(workspaceRoot, "worktree");
  // A repository with no commits yet is an ordinary state, not a fault, and
  // `git worktree add` has nothing to branch from in it.
  const baseCommit = await git(["rev-parse", "HEAD"], gitRoot).catch(() => {
    throw new Error(
      `workspacePolicy: git_worktree needs at least one commit to branch a worktree from, ` +
        `and ${gitRoot} has none yet. Make an initial commit, or use workspacePolicy: copy.`,
    );
  });
  await git(["worktree", "add", "--detach", worktreeRoot, baseCommit], gitRoot);
  const effectiveWorkingDir = prefix ? path.join(worktreeRoot, prefix) : worktreeRoot;
  try {
    await stat(effectiveWorkingDir);
  } catch {
    // The worktree starts from HEAD, and a working directory that exists only
    // as uncommitted files is not in HEAD. Left alone, this was a bare ENOENT
    // plus a worktree registered in the user's repository until retention.
    // No agent has run here yet; removed like every other workspace anyway,
    // so no removal path skips the link sweep.
    await removeLinksWithin(workspaceRoot)
      .then(() => git(["worktree", "remove", "--force", worktreeRoot], gitRoot))
      .catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `workspace_policy: git_worktree starts from the last commit, and ${prefix} is not in it ` +
        `(${originalWorkingDir} holds only uncommitted files). Commit it first, or use ` +
        `workspace_policy: copy, which copies the directory as it is.`,
    );
  }
  // Everything in a fresh worktree is tracked, so no excluded directory is
  // skipped here, and the ones found are the ones the second walk keeps.
  const trackedExcluded = new Set<string>();
  const before = await fingerprintTree(worktreeRoot, { walkExcluded: "all", found: trackedExcluded });
  const settledAt = Date.now();
  const stopHeartbeat = await startHeartbeat(workspaceRoot);
  return {
    policy: "git_worktree",
    originalWorkingDir,
    effectiveWorkingDir,
    files: mapFiles(files, gitRoot, worktreeRoot),
    isolated: true,
    workspaceRoot,
    async finish(result) {
      await stopHeartbeat();
      const after = await fingerprintTree(worktreeRoot, {
        reuse: { before, settledAt },
        walkExcluded: trackedExcluded,
      });
      const changedFiles = diffFingerprints(before, after);

      // A failed attempt that changed nothing leaves nothing to inspect, and
      // its worktree is a registration inside the USER's repository that
      // retention will never reclaim — the sweep refuses to remove worktrees,
      // because unregistering one needs git and only the owning repo can do
      // it. They accumulate per attempt, and a fallback arm that fails is not
      // named in the response at all, so its worktree has no cleanupHint
      // anywhere.
      //
      // Only when the attempt both failed AND changed nothing: a failure that
      // wrote files may still hold work worth recovering.
      // Git is asked too: the fingerprint still skips excluded directories the
      // agent created (a build's dist/, an install's node_modules/), and an
      // untracked-but-not-ignored file there is work worth keeping. Anything
      // git reports, or a git that cannot be asked, keeps it.
      const gitSeesChanges =
        !result.success && changedFiles.length === 0
          ? await worktreeGitArgs(worktreeRoot, gitRoot)
              .then((pinned) =>
                git([...pinned, "status", "--porcelain", "--ignore-submodules=dirty"], worktreeRoot),
              )
              .then((out) => out.trim() !== "")
              .catch(() => true)
          : true;
      if (!result.success && changedFiles.length === 0 && !gitSeesChanges) {
        // The directory goes only if GIT let go of it first: when
        // `git worktree remove` fails — an index lock, a concurrent git
        // operation — deleting it anyway strands `.git/worktrees/<name>`
        // inside the user's repository.
        // Links first: git's removal follows a junction (see removeLinksWithin).
        const unregistered = await removeLinksWithin(workspaceRoot)
          .then(() => git(["worktree", "remove", "--force", worktreeRoot], gitRoot))
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
          // Measured from the REPOSITORY root: that is what mapFiles maps into the
          // worktree, so a sibling package's file is isolated, not an escape.
          ...escapeNote(files, gitRoot),
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
  /** The job the run belongs to, recorded in an isolated run directory (see OWNER_FILE). */
  jobId?: string;
}): Promise<PreparedWorkspace> {
  switch (opts.policy) {
    case "shared":
    case "shared_locked":
      return prepareSharedWorkspace(opts.policy, opts.workingDir, opts.files);
    case "copy":
      return prepareCopyWorkspace(opts.routeName, opts.workingDir, opts.files, opts.jobId);
    case "git_worktree":
      return prepareGitWorktreeWorkspace(opts.routeName, opts.workingDir, opts.files, opts.jobId);
  }
}
