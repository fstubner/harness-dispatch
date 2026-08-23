import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
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

function workspaceRunId(routeName: string): string {
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
function workspaceRootFor(originalWorkingDir: string): string {
  return (
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR ??
    path.join(
      os.tmpdir(),
      "harness-dispatch",
      "workspaces",
      safeName(path.basename(originalWorkingDir)),
    )
  );
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
async function pruneStaleCopyWorkspaces(root: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(full, { recursive: true, force: true });
      }
    } catch {
      // best effort — a locked/already-gone/permission-denied entry is skipped
    }
  }
}

async function pruneStaleGitWorktrees(gitRoot: string, root: string): Promise<void> {
  const maxAgeMs = workspaceMaxAgeMs();
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
  return normalized === ".harness-dispatch/workspaces" || normalized.startsWith(".harness-dispatch/workspaces/");
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
): Promise<void> {
  const sourceDir = rel ? path.join(sourceRoot, rel) : sourceRoot;
  const destDir = rel ? path.join(destRoot, rel) : destRoot;
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    try {
      if (entry.isDirectory()) {
        if (shouldExclude(childRel, entry.name)) continue;
        await copyTree(sourceRoot, destRoot, childRel, skipped, vanished);
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
  };
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
      changes.push({ path: filePath, kind: "added" });
      continue;
    }
    if (oldFile && !newFile) {
      changes.push({ path: filePath, kind: "deleted" });
      continue;
    }
    if (oldFile && newFile && (oldFile.hash !== newFile.hash || oldFile.size !== newFile.size)) {
      changes.push({ path: filePath, kind: "modified" });
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
  await pruneStaleCopyWorkspaces(root);
  const workspaceRoot = path.join(root, workspaceRunId(routeName));
  const effectiveWorkingDir = path.join(workspaceRoot, "workspace");
  const skippedLinks: string[] = [];
  const vanishedFiles: string[] = [];
  await copyTree(originalWorkingDir, effectiveWorkingDir, "", skippedLinks, vanishedFiles);
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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, windowsHide: true });
  return String(stdout).trim();
}

async function prepareGitWorktreeWorkspace(
  routeName: string,
  workingDir: string,
  files: string[],
): Promise<PreparedWorkspace> {
  const originalWorkingDir = resolveDir(workingDir);
  const gitRoot = await git(["rev-parse", "--show-toplevel"], originalWorkingDir);
  const prefix = await git(["rev-parse", "--show-prefix"], originalWorkingDir);
  const gitWorkspaceRoot = gitWorkspaceRootFor(gitRoot);
  await pruneStaleGitWorktrees(gitRoot, gitWorkspaceRoot);
  const workspaceRoot = path.join(gitWorkspaceRoot, workspaceRunId(routeName));
  const worktreeRoot = path.join(workspaceRoot, "worktree");
  await mkdir(workspaceRoot, { recursive: true });
  const baseCommit = await git(["rev-parse", "HEAD"], gitRoot);
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
