/**
 * Dispatch log — one JSONL line per dispatch attempt, appended to
 * ~/.harness-dispatch/logs/dispatches.jsonl (override the directory with
 * HARNESS_DISPATCH_LOG_DIR).
 *
 * This exists because synchronous `code` calls previously left ZERO
 * persistent artifacts — only `job` runs did — so a failed session couldn't
 * be autopsied after the fact. The log is local-only (same posture as
 * everything else here: nothing phones home) and size-capped via a single
 * rotation (dispatches.jsonl -> dispatches.jsonl.1 at ~5MB, keeping roughly
 * the last ten thousand entries).
 *
 * Writes are SYNCHRONOUS on purpose: dispatches are seconds-to-minutes
 * events, so a sub-millisecond appendFileSync is free — and an async
 * fire-and-forget append loses the race against process.exit in one-shot
 * CLI commands (doctor --live's probe entry simply vanished). A write
 * failure never throws into the dispatch path.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import type { DispatchResult, RoutingDecision } from "./types.js";
import { stateRoot } from "./state-dir.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

function logDir(): string {
  return process.env.HARNESS_DISPATCH_LOG_DIR ?? path.join(stateRoot(), "logs");
}

export function dispatchLogPath(): string {
  return path.join(logDir(), "dispatches.jsonl");
}

export interface DispatchLogEntry {
  ts: string;
  route: string;
  success: boolean;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  rateLimited?: boolean;
  error?: string;
  outputChars?: number;
  /** From the routing decision, when available. */
  taskType?: string;
  model?: string;
  tier?: number;
  safetyProfile?: string;
  reason?: string;
}

export function buildDispatchLogEntry(
  route: string,
  result: DispatchResult,
  decision?: RoutingDecision | null,
): DispatchLogEntry {
  const entry: DispatchLogEntry = {
    ts: new Date().toISOString(),
    route,
    success: result.success,
  };
  if (result.durationMs !== undefined) entry.durationMs = result.durationMs;
  if (result.tokensUsed !== undefined) entry.tokensUsed = result.tokensUsed;
  if (result.rateLimited) entry.rateLimited = true;
  if (result.error) entry.error = result.error.slice(0, MAX_ERROR_CHARS);
  if (result.output) entry.outputChars = result.output.length;
  if (decision) {
    if (decision.taskType) entry.taskType = decision.taskType;
    if (decision.model !== undefined) entry.model = decision.model;
    if (decision.tier !== undefined) entry.tier = decision.tier;
    if (decision.effectiveSafetyProfile !== undefined) {
      entry.safetyProfile = decision.effectiveSafetyProfile;
    }
    if (decision.reason !== undefined) entry.reason = decision.reason;
  }
  return entry;
}

let warnedOnce = false;

/**
 * Append one entry synchronously. Never throws into the dispatch path; the
 * first write failure warns on stderr, later ones are silent.
 */
export function logDispatch(
  route: string,
  result: DispatchResult,
  decision?: RoutingDecision | null,
): void {
  try {
    const file = dispatchLogPath();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // File doesn't exist yet (or rotation raced another process) — fine.
    }
    const line = JSON.stringify(buildDispatchLogEntry(route, result, decision)) + "\n";
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(
        `harness-dispatch: dispatch log write failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.`,
      );
    }
  }
}
