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

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { withFileLock } from "./file-lock.js";
import { redact } from "./redaction.js";
import path from "node:path";

import type { DispatchCaller, DispatchResult, RoutingDecision } from "./types.js";
import { dirFromEnv, stateRoot } from "./state-dir.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

function logDir(): string {
  return dirFromEnv("HARNESS_DISPATCH_LOG_DIR", () => path.join(stateRoot(), "logs"));
}

export function dispatchLogPath(): string {
  return path.join(logDir(), "dispatches.jsonl");
}

/** Who asked, the job it ran under, and which config was loaded. Absent for direct library use. */
export interface DispatchLogContext extends DispatchCaller {
  jobId?: string;
  /**
   * The config file this process was running on (absent when none was loaded).
   * State lives in one directory whatever `--config` says, so a run against a
   * throwaway config writes into the same log as real work; this is what lets a
   * reader tell the two apart.
   */
  configPath?: string;
}

export interface DispatchLogEntry {
  ts: string;
  route: string;
  /**
   * Which client and connection asked (see DispatchCaller), and the job the
   * attempt ran under. Without these, the log says how routes performed but
   * not who used them: every session on the machine writes one shared log.
   */
  client?: string;
  clientVersion?: string;
  session?: string;
  jobId?: string;
  /** Absolute path of the config file in use; absent when none was loaded. */
  config?: string;
  success: boolean;
  /** The prompt was refused before any process started; says nothing about the route. */
  inputRejected?: true;
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
  context?: DispatchLogContext,
): DispatchLogEntry {
  const entry: DispatchLogEntry = {
    ts: new Date().toISOString(),
    route,
    ...(context?.client !== undefined ? { client: context.client } : {}),
    ...(context?.clientVersion !== undefined ? { clientVersion: context.clientVersion } : {}),
    ...(context?.session !== undefined ? { session: context.session } : {}),
    ...(context?.jobId !== undefined ? { jobId: context.jobId } : {}),
    ...(context?.configPath !== undefined ? { config: context.configPath } : {}),
    success: result.success,
    ...(result.inputRejected ? { inputRejected: true as const } : {}),
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
    //
    // Not for a decision that scored nothing (a run cancelled before routing
    // passes one with only a reason): that would log `"scores":{}`.
    if (
      decision.quotaScore !== undefined ||
      decision.capabilityScore !== undefined ||
      decision.finalScore !== undefined
    ) {
      entry.scores = {
        quota: decision.quotaScore,
        capability: decision.capabilityScore,
        final: decision.finalScore,
      };
    }
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
  context?: DispatchLogContext,
): void {
  try {
    const file = dispatchLogPath();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Checked again under a lock. Two processes that both saw the log over
    // the limit both renamed it, and the second rename replaced the 5 MB
    // archive the first had just made with the one line written since.
    const oversized = (): boolean => {
      try {
        return statSync(file).size > MAX_LOG_BYTES;
      } catch {
        return false; // Not created yet.
      }
    };
    if (oversized()) {
      withFileLock(file, () => {
        try {
          if (oversized()) renameSync(file, `${file}.1`);
        } catch {
          // A failed rotation must not cost the entry; the next write retries.
        }
      });
    }
    // Sink: this file is read by people and pasted into issues.
    const line = redact(JSON.stringify(buildDispatchLogEntry(route, result, decision, context))) + "\n";
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

// ---------------------------------------------------------------------------
// Recent outcomes, for status and usage
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 7;

/** What the log says one route did over the window. A route's attempts, not dispatches: a fallback writes its own row. */
export interface RecentOutcome {
  attempts: number;
  successes: number;
  /** Declined for rate limiting. Counted as attempts that did not succeed, and shown apart. */
  rateLimited: number;
}

let recentCache: { key: string; days: number; value: Record<string, RecentOutcome> } | undefined;

function readIfPresent(file: string): { text: string; key: string } | undefined {
  try {
    const st = statSync(file);
    return { text: readFileSync(file, "utf8"), key: `${file}:${st.size}:${st.mtimeMs}` };
  } catch {
    return undefined;
  }
}

/**
 * Per-route outcomes from the dispatch log over the last `days` days.
 *
 * Read from the log and not from the usage counters on purpose: the counters
 * are lifetime, and what a delegator needs before choosing a route is how it
 * has been doing LATELY. (A route can be 20% successful this week and 80% for
 * its lifetime.) Rows for prompts refused before running are left out.
 *
 * The rotated `.1` file is read only when the live one does not reach back far
 * enough. Memoised on the files' size and mtime, since `status --watch` and
 * every `usage` call ask. Never throws: no log is an empty answer.
 */
export function recentOutcomes(
  days: number = RECENT_DAYS,
  now: number = Date.now(),
): Record<string, RecentOutcome> {
  const file = dispatchLogPath();
  const current = readIfPresent(file);
  const cutoff = now - days * 24 * 3600 * 1000;
  const parts: Array<{ text: string; key: string }> = [];
  if (current) parts.push(current);
  // The live file begins where rotation last cut it; if its first row is already
  // inside the window, older rows may sit in the archive.
  const firstTs = current ? Date.parse(/"ts":"([^"]+)"/.exec(current.text)?.[1] ?? "") : Number.NaN;
  if (!current || !(firstTs < cutoff)) {
    const archive = readIfPresent(`${file}.1`);
    if (archive) parts.unshift(archive);
  }
  // Time is part of the key at hour granularity: the window slides.
  const key = `${days}:${Math.floor(now / 3_600_000)}:${parts.map((p) => p.key).join("|")}`;
  if (recentCache !== undefined && recentCache.key === key && recentCache.days === days) {
    return recentCache.value;
  }
  const out: Record<string, RecentOutcome> = Object.create(null) as Record<string, RecentOutcome>;
  for (const { text } of parts) {
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let row: { ts?: unknown; route?: unknown; success?: unknown; rateLimited?: unknown; inputRejected?: unknown };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue; // A torn line from a crashed writer.
      }
      if (typeof row.ts !== "string" || typeof row.route !== "string") continue;
      if (row.inputRejected === true) continue;
      const at = Date.parse(row.ts);
      if (!Number.isFinite(at) || at < cutoff) continue;
      const o = (out[row.route] ??= { attempts: 0, successes: 0, rateLimited: 0 });
      o.attempts += 1;
      if (row.success === true) o.successes += 1;
      else if (row.rateLimited === true) o.rateLimited += 1;
    }
  }
  recentCache = { key, days, value: out };
  return out;
}
