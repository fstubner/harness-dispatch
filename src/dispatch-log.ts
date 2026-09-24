/**
 * Dispatch log — one JSONL line per dispatch attempt, appended to
 * ~/.harness-dispatch/logs/dispatches.jsonl (override the directory with
 * HARNESS_DISPATCH_LOG_DIR).
 *
 * Local-only (nothing phones home) and size-capped via a single rotation
 * (dispatches.jsonl -> dispatches.jsonl.1 at ~5MB, roughly the last ten
 * thousand entries).
 *
 * Writes are SYNCHRONOUS on purpose: dispatches are seconds-to-minutes events,
 * so a sub-millisecond appendFileSync is free, and an async fire-and-forget
 * append loses the race against process.exit in one-shot CLI commands. A write
 * failure never throws into the dispatch path.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { redact } from "./redaction.js";
import path from "node:path";

import type { DispatchResult, RoutingDecision } from "./types.js";
import { dirFromEnv, stateRoot } from "./state-dir.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

function logDir(): string {
  return dirFromEnv("HARNESS_DISPATCH_LOG_DIR", () => path.join(stateRoot(), "logs"));
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
  /**
   * The score components behind the pick, present whenever a decision was
   * made — including on the explicit path, where they record what the forced
   * route WOULD have scored, so hand-picking can be compared against the
   * router.
   */
  scores?: {
    quota: number;
    quality: number;
    capability: number;
    final: number;
  };
  /**
   * What the picked route beat, when the router chose — absent on the forced
   * and explicit paths, where nothing was compared.
   *
   * `reason` records that a choice happened ("tier 1 best (3 available)") and
   * never what it was between, so without this a month of logs says the router
   * was used but not whether it chose well.
   */
  candidates?: Array<{ route: string; score: number }>;
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
    if (decision.candidates !== undefined && decision.candidates.length > 0) {
      entry.candidates = decision.candidates;
    }
    // The score COMPONENTS, not just the winner and the margin. `candidates`
    // says the picked route beat `runner_up` 0.92 to 0.81, not why, and "why"
    // is what tells a scoring bug from a route that is genuinely better. It
    // cannot be reconstructed later: quota and breaker state have moved on.
    entry.scores = {
      quota: decision.quotaScore,
      quality: decision.qualityScore,
      capability: decision.capabilityScore,
      final: decision.finalScore,
    };
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
    // Sink: this file is read by people and pasted into issues.
    const line = redact(JSON.stringify(buildDispatchLogEntry(route, result, decision))) + "\n";
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
