import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

const EXCLUDED_DIRS = new Set([
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

function workspaceRootFor(originalWorkingDir: string): string {
  return (
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR ??
    path.join(originalWorkingDir, ".harness-dispatch", "workspaces")
  );
}

function gitWorkspaceRootFor(originalWorkingDir: string): string {
  return (
    process.env.HARNESS_DISPATCH_WORKSPACES_DIR ??
    path.join(os.tmpdir(), "harness-dispatch", "workspaces", safeName(path.basename(originalWorkingDir)))
  );
}

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

async function copyTree(sourceRoot: string, destRoot: string, rel = ""): Promise<void> {
  const sourceDir = rel ? path.join(sourceRoot, rel) : sourceRoot;
  const destDir = rel ? path.join(destRoot, rel) : destRoot;
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (shouldExclude(childRel, entry.name)) continue;
      await copyTree(sourceRoot, destRoot, childRel);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(path.join(sourceRoot, childRel), path.join(destRoot, childRel));
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Preserve relative symlinks, but do not resolve links during copying.
      try {
        const target = await readlink(path.join(sourceRoot, childRel));
        await symlink(target, path.join(destRoot, childRel));
      } catch {
        // Symlink preservation is best effort; agents can still work with the copied files.
      }
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
    out.set(childRel.split(path.sep).join("/"), await fingerprintFile(path.join(root, childRel)));
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
    return file;
  });
}

function diffSummary(changes: WorkspaceFileChange[]): string {
  if (changes.length === 0) return "No file changes detected in the agent workspace.";
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return `${changes.length} changed file(s): ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted.`;
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
            ? ["Write-capable shared workspace dispatches are serialized within this router process."]
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
  await copyTree(originalWorkingDir, effectiveWorkingDir);
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
  await git(["worktree", "add", "--detach", worktreeRoot, "HEAD"], gitRoot);
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
        isolated: true,
        securityBoundary: "project_state_and_process_cwd",
        changedFiles,
        diffSummary: diffSummary(changedFiles),
        cleanupHint: `Run git -C ${gitRoot} worktree remove ${worktreeRoot} when the isolated result is no longer needed.`,
        notes: [
          "The git worktree starts from HEAD; uncommitted source-workspace changes are not copied into it.",
          "This isolates project state, but it is not a hardened OS sandbox for commands with host filesystem access.",
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
