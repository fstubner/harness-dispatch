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
export async function secureProjectRoot(root: string): Promise<void> {
  if (process.platform === "win32") return;
  // EVERY SEGMENT WE CREATE, not just the last one.
  //
  // The first version checked only the leaf. `<tmp>/harness-dispatch` and
  // `<tmp>/harness-dispatch/workspaces` are equally attacker-plantable — they
  // are fixed names under a world-writable directory — and neither was ever
  // looked at. Reproduced with a link at the BASE: the guard passed, and the
  // project was copied into the attacker's tree. Only the 0700 applied to the
  // leaf kept them from reading it, while they still owned the parent.
  //
  // Stops at `workspacesBase()`: everything at or below it is ours to insist
  // on, and `os.tmpdir()` itself is the system's business, not this tool's.
  // With HARNESS_DISPATCH_WORKSPACES_DIR pointed somewhere the user chose,
  // the same rule applies from that directory down.
  const base = workspacesBase();
  const segments: string[] = [];
  for (let dir = root; dir.startsWith(base) || dir === base; dir = path.dirname(dir)) {
    segments.unshift(dir);
    if (dir === base || dir === path.dirname(dir)) break;
  }
  for (const segment of segments) {
    if (segment === root) continue; // checked in full below
    const seg = await lstat(segment).catch(() => undefined);
    if (seg === undefined) continue; // not created yet: nothing to subvert
    if (seg.isSymbolicLink()) {
      throw new Error(
        `${segment} is a symbolic link, and it is a parent of this project's workspace ` +
          `directory. Refusing to use it: following it would put your project — and this ` +
          `tool's recursive cleanup — wherever the link points. Remove it, or set ` +
          `HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
      );
    }
    const segUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (segUid !== undefined && seg.uid !== segUid) {
      throw new Error(
        `${segment} is owned by another user (uid ${seg.uid}, this process is uid ` +
          `${segUid}), and it is a parent of this project's workspace directory. Refusing ` +
          `to copy your project beneath it. Remove it, or set ` +
          `HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
      );
    }
  }
  // lstat, NOT stat.
  //
  // `stat` follows symlinks, so the uid compared was the TARGET's. An
  // attacker who owns neither end simply plants a link at this predictable
  // path pointing at a directory the victim DOES own, and the check passes
  // against the victim's own uid. Reproduced in a container: the guard did
  // not fire, the victim's home directory was chmod'd to 0700, and the
  // project was copied into it.
  //
  // A symlink here is refused outright rather than resolved and re-checked.
  // Nothing this tool creates is ever a link, so there is no legitimate case
  // to preserve, and "follow it and then validate" is how the first version
  // of this guard was defeated.
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    throw new Error(
      `The workspace directory ${root} is a symbolic link. Refusing to use it: this path is ` +
        `predictable, nothing this tool creates is ever a link, and following one would let ` +
        `it write into — and prune — whatever the link points at. Remove it, or set ` +
        `HARNESS_DISPATCH_WORKSPACES_DIR to a location you control.`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `The workspace directory ${root} exists and is owned by another user (uid ${info.uid}, ` +
        `this process is uid ${uid}). Refusing to copy your project into it: on a shared ` +
        `machine this path is predictable, so a directory you do not own may have been ` +
        `created there deliberately. Remove it, or set HARNESS_DISPATCH_WORKSPACES_DIR to a ` +
        `location you control.`,
    );
  }
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
}

/**
 * Create the project's workspace root, secure it, and mark it as ours.
 *
 * The MARKER is best effort — a root without one is merely not reclaimed
 * automatically, which is the safe direction to fail in. Creating and securing
 * the directory is not, and used to sit inside the same swallowing `catch`:
 * an ownership refusal raised there would have been discarded and the copy
 * would have proceeded into someone else's directory.
 */
async function markProjectRoot(root: string): Promise<void> {
  {
    // 0700, like the state directory and every job directory.
    //
    // A `copy` workspace holds a full copy of the user's source, and the
    // default base lives in the SHARED os.tmpdir() — so on a multi-user POSIX
    // machine it was readable by everyone, while the job directory holding the
    // same project's prompt was 0700 and its files 0600. This module was the
    // only one in the family with no mode at all.
    //
    // Applied at the roots rather than to every copied directory: `recursive`
    // creates the missing parents with this mode too, and a 0700 ancestor
    // already stops another user traversing in, so per-file modes inside the
    // tree would be belt-and-braces on a throwaway copy. No effect on Windows,
    // where Node ignores mode — which is also why it cannot be verified on
    // this maintainer's machine, only in CI.
    //
    // The `mode` option alone was NOT enough, and the CHANGELOG entry that
    // shipped with it overclaimed. `mkdir` applies a mode only to directories
    // it CREATES; it never chmods one that already exists. So every user who
    // ran `copy` before that change kept a 0755 root forever and the upgrade
    // did nothing for them. Measured on real Linux: a pre-existing 0755
    // directory is still 0755 after `mkdir(recursive, 0o700)`.
    //
    // Hence the explicit chmod below — see secureProjectRoot, which also
    // handles the case this path cannot: a root somebody ELSE owns.
    await mkdir(root, { recursive: true, mode: 0o700 });
    await secureProjectRoot(root);
  }
  try {
    const marker = path.join(root, ROOT_MARKER);
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
function isOurProjectRoot(full: string, children: string[]): boolean {
  if (existsSync(path.join(full, ROOT_MARKER))) return true;
  const runs = children.filter((name) => name !== ROOT_MARKER);
  return runs.length > 0 && runs.every((name) => RUN_DIR_RE.test(name));
}

/** Short stable digest of a project path, to keep same-named projects apart. */
function pathKey(dir: string): string {
  return createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8);
}

const gitWorkspaceRootFor = workspaceRootFor;

const DEFAULT_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function workspaceMaxAgeMs(): number {
  const raw = process.env.HARNESS_DISPATCH_WORKSPACE_MAX_AGE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WORKSPACE_MAX_AGE_MS;
}

/**
 * Every isolated (copy/git_worktree) dispatch leaves its workspace on disk
 * on purpose — the caller may still want to inspect changedFiles/diffSummary
 * after the tool call returns, so finish() never deletes anything itself.
 * Without SOME reclamation, that's unbounded growth (and for git_worktree,
 * .git/worktrees bloat that can eventually slow or break `git worktree add`
 * itself). Prune anything past the retention window each time a new one is
 * about to be created — self-limiting, no separate scheduler needed. Best
 * effort: a prune failure must never block or fail the actual dispatch.
 */
/**
 * `copyProjectGitRoot` is the repository the copy dispatch is running against,
 * when there is one. Both policies share a workspaces root since 0.7.0, so a
 * copy dispatch's prune can encounter a stale git_worktree workspace — and an
 * `rm -rf` on one of those leaves the directory gone from disk while git still
 * lists the worktree, marked prunable, with `.git/worktrees/<name>` behind it.
 * The code's own retention comment warns that accumulating those "can
 * eventually slow or break `git worktree add` itself". Before 0.7.0 the two
 * roots were separate and this could not happen.
 */
async function pruneStaleCopyWorkspaces(root: string, copyProjectGitRoot?: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  // Before the early return below: a project dispatching for the FIRST time
  // has no root of its own to sweep, and that is exactly the caller most
  // likely to be running on a machine full of other projects' leftovers.
  await pruneAbandonedProjectRoots(workspacesBase(), root);
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
    const full = path.join(root, entry.name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      // A `worktree` child is the tell that this belongs to the other policy.
      const worktreeRoot = path.join(full, "worktree");
      if (copyProjectGitRoot !== undefined && existsSync(worktreeRoot)) {
        try {
          await git(["worktree", "remove", "--force", worktreeRoot], copyProjectGitRoot);
          removedWorktree = true;
        } catch {
          // Registered against a different repo, or already gone: the
          // filesystem sweep below still reclaims the disk, and the prune
          // afterwards clears whatever metadata this repo can see.
        }
      }
      await rm(full, { recursive: true, force: true });
    } catch {
      // best effort — a locked/already-gone/permission-denied entry is skipped
    }
  }
  if (removedWorktree && copyProjectGitRoot !== undefined) {
    await git(["worktree", "prune"], copyProjectGitRoot).catch(() => undefined);
  }
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

async function pruneStaleGitWorktrees(gitRoot: string, root: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  // Same reclamation the copy path does, for a machine that only ever
  // dispatches under git_worktree. Abandoned worktree roots are left alone by
  // that sweep either way — see pruneAbandonedProjectRoots.
  await pruneAbandonedProjectRoots(workspacesBase(), root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  let removedAny = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only directories WE named — the same guard the copy sweep and
    // pruneStaleJobs use. This loop `rm -rf`s recursively and had no name,
    // marker or ownership check of any kind.
    if (!RUN_DIR_RE.test(entry.name)) continue;
    const workspaceRoot = path.join(root, entry.name);
    try {
      const info = await stat(workspaceRoot);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      const worktreeRoot = path.join(workspaceRoot, "worktree");
      try {
        await git(["worktree", "remove", "--force", worktreeRoot], gitRoot);
        removedAny = true;
      } catch {
        // Worktree already gone/never registered — fall through to the
        // filesystem cleanup below either way.
      }
      await rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (removedAny) {
    try {
      await git(["worktree", "prune"], gitRoot);
    } catch {
      // best effort
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
            ? ["Write-capable shared workspace dispatches are serialized across ALL processes (see workspace-lock.ts; this was per-process until 304a1b5)."]
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
  // SECURE BEFORE PRUNING. The order was the other way round, and the guard
  // could not protect the one operation that deletes: `pruneStaleCopyWorkspaces`
  // ran first and `rm -rf`d every aged subdirectory of `root` — a root the
  // guard had not yet looked at. With a symlink planted at that path, the
  // victim's own directory was swept. Reproduced end to end.
  //
  // `markProjectRoot` is what creates and secures the root, so calling it
  // first means the prune can only ever run against a directory that exists,
  // is not a link, and belongs to this user.
  await markProjectRoot(root);
  await pruneStaleCopyWorkspaces(root, projectGitRoot);
  const workspaceRoot = path.join(root, workspaceRunId(routeName));
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
  const gitWorkspaceRoot = gitWorkspaceRootFor(gitRoot);
  // SECURE BEFORE PRUNING, exactly as the copy path does.
  //
  // This ordering fix and the name check inside the sweep were applied to
  // `copy` only, so the identical attack still worked here: same predictable
  // path, same delete-before-validate. Reproduced as two real users — with a
  // symlink planted at the root, the copy policy refused and the worktree
  // policy DELETED the victim's directory, then raised the guard's error
  // afterwards. The release that fixed `copy` claimed the class was closed.
  //
  // Two policies, one hazard: whenever one of these gets a guard, check the
  // other in the same edit.
  await markProjectRoot(gitWorkspaceRoot);
  await pruneStaleGitWorktrees(gitRoot, gitWorkspaceRoot);
  const workspaceRoot = path.join(gitWorkspaceRoot, workspaceRunId(routeName));
  const worktreeRoot = path.join(workspaceRoot, "worktree");
  // Same 0700 reasoning as markProjectRoot: this run's directory holds the
  // worktree checkout, i.e. the project's source.
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
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
