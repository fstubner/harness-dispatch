/**
 * Config-driven CLI dispatcher for harness-dispatch.
 *
 * Every part of the invocation comes from `svc.protocol` (CliProtocolConfig,
 * see types.ts) — this dispatcher has no hardcoded knowledge of any specific
 * CLI's flags or output shape. It's the ONE interpreter for every CLI
 * harness, built-in or user-added: prompt input style, working-dir flag,
 * per-file directory flags, model flag, per-safety-profile args, API-key env
 * injection, and (via `eventRules`) the same tool_use/thinking/usage
 * streaming-event semantics Codex's original hand-written dispatcher used —
 * expressed declaratively instead of imperatively, so a new harness (or a
 * redefinition of an existing one) needs zero new TypeScript.
 */

import os from "node:os";
import path from "node:path";
import which from "which";
import type {
  CliEventRule,
  CliProtocolConfig,
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  SafetyProfile,
  ServiceConfig,
} from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";
import { commandAvailable } from "./shared/which-available.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * "429" only counts next to HTTP context. A bare includes("429") flagged any
 * failed run whose transcript mentioned the number at all — a port, a line
 * number, a test count. That claim was made once and was still false: an
 * acceptance pass measured "Error on line 429 of the config" and two test
 * assertions all flagging, because the gap allowed arbitrary WORDS between
 * the keyword and the number. It now allows only separators, and a line that
 * reads as a test assertion is excluded outright. One flag trips the breaker
 * with NO threshold, blocking the route for 300s and recording `rate_limited`
 * in the counts the orchestrator is told to trust. The phrase list below covers limiters that
 * spell it out; this pattern covers the ones that only send the status code.
 */
const HTTP_429_RE =
  /\b(?:http|status(?:[_\s]?code)?|error(?:[_\s]?code)?|code)\b["'\s:=_,-]{0,4}429\b|\b429\b[\s:-]{0,3}too many requests/i;

/**
 * Text that is TALKING ABOUT a 429 rather than reporting one.
 *
 * The pattern above still matched an assertion — "expected error code 429 but
 * got 200", "assertion failed: status code 429 expected" — which is a test
 * suite the delegate RAN, not a limiter the delegate HIT. Flagging it trips
 * the breaker with no threshold and blocks the route for 300 seconds, and
 * records a rate limit in the counts an orchestrator is told to trust.
 *
 * Checked per line, so an assertion elsewhere in a long transcript cannot mask
 * a genuine 429 on its own line.
 *
 * The tick/cross and "Test Files"/"Tests " markers were added after this
 * repository's OWN vitest output was measured flagging as rate-limited: a
 * test NAME containing "usage limit" is not an assertion and carried no
 * keyword, so nothing here caught it. A delegated "run the tests" task that
 * exits non-zero then blocks its route for 300 seconds.
 *
 * This stays a HEURISTIC, and it is worth saying so rather than implying a
 * solved problem: separating "the delegate hit a limiter" from "the delegate
 * printed the words" is undecidable from text alone. The structural answer is
 * to discriminate by STREAM — a harness reports its own limiter on stderr,
 * while a test runner writes results to stdout — and that is deliberately not
 * done here, because some CLIs do print limiter errors to stdout and getting
 * it wrong in that direction MISSES a real limit, which is the worse failure.
 *
 * `should` was in this list and had to come out: it discards
 * "429 received; the request should be retried", a REAL limiter message that
 * matched before this filter existed. A guard against false positives that
 * creates false negatives on the same surface is worse than the problem — a
 * missed 429 means the router keeps hammering an exhausted route.
 *
 * `it(` and `describe(` are written without a trailing `\b`, which could never
 * match: `(` followed by a quote is not a word boundary, so both alternatives
 * were dead while the docblock named them as covered.
 */
const ASSERTION_CONTEXT_RE =
  /\bassert\w*|\bexpect\w*|\btest case\b|\bit\(|\bdescribe\(|^\s*[✓✗×]|\bTest Files\b|\bTests\s\s/i;

/** Does any line report a 429 without reading as a test assertion? */
function mentions429(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!HTTP_429_RE.test(line)) continue;
    if (ASSERTION_CONTEXT_RE.test(line)) continue;
    return true;
  }
  return false;
}

/**
 * Only the TAIL of each stream is scanned (per stream, before joining).
 * Failed runs carry up to 10 MB of agent transcript, and a rate-limit
 * message a CLI actually died from is at the end of its output; scanning the
 * whole transcript mostly adds chances for an innocent mention of "rate
 * limit" in the AGENT'S OWN WORK to block the route.
 */
const RATE_LIMIT_SCAN_TAIL_BYTES = 16 * 1024;

export function rateLimitScanTail(text: string): string {
  return text.length > RATE_LIMIT_SCAN_TAIL_BYTES ? text.slice(-RATE_LIMIT_SCAN_TAIL_BYTES) : text;
}

/** Phrases a limiter actually uses, matched per line. */
const LIMITER_PHRASES = [
  "rate limit",
  // Anthropic's own error type, and OpenAI's 429 body text. Neither matched:
  // the list had `rate limit` with a SPACE and `quota exceeded` in that order,
  // so `rate_limit_error` and "You exceeded your current quota" both went
  // through as ordinary failures. A missed limiter is the worse direction —
  // the router keeps hammering a route that has already said stop.
  "rate_limit_error",
  "rate-limited",
  "quota exceeded",
  "exceeded your quota",
  "exceeded your current quota",
  "resource_exhausted",
  "too many requests",
  // "usage limit" is OpenAI Codex's real phrasing (confirmed live,
  // 2026-07-24: "You've hit your usage limit... try again at Jul 28th,
  // 2026 10:16 PM.") — none of the phrases above matched it, so a real
  // Codex exhaustion was silently NOT flagged as rate-limited.
  "usage limit",
];

/** Exported for tests: the false-positive space here is what trips breakers. */
export function detectRateLimit(text: string): { rateLimited: boolean; retryAfter: number | null } {
  // PER LINE, and past the assertion filter — like the 429 check beside it.
  //
  // These phrases were matched against the whole blob with no filter at all,
  // so the assertion guard protected one half of this function and not the
  // other. Measured: this repository's OWN vitest output, fed back in, flags
  // as rate-limited — a delegated "run the tests" task that exits non-zero
  // then trips the breaker with no threshold, blocks the route for 300s, and
  // records a rate limit that never happened. The scan-tail comment above
  // claims the tail exists to stop exactly that.
  const flagged = text.split(/\r?\n/).some((line) => {
    if (ASSERTION_CONTEXT_RE.test(line)) return false;
    const lowered = line.toLowerCase();
    return LIMITER_PHRASES.some((phrase) => lowered.includes(phrase)) || mentions429(line);
  });
  if (!flagged) return { rateLimited: false, retryAfter: null };
  const match = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = match?.[1] ? Number.parseFloat(match[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}

/**
 * The harness could not run its own tools — an environment fault, not an
 * answer.
 *
 * Observed live: Codex's Windows sandbox failed to spawn ANY child on a deep
 * path (`CreateProcessAsUserW failed: 5 (Access is denied)`, six times in one
 * run). The delegate, unable to read anything, replied "Unable to read file.",
 * the process exited 0, and a lenient harness reported `success: true`. That
 * counted a success in `usage`, left the breaker closed, and cost 57k tokens
 * and 63 seconds — so the router kept choosing a route that could not do
 * anything. PRODUCT.md names exactly that shape as a counter-signal.
 *
 * Erring toward failure is deliberate. If the agent recovered and the run was
 * fine, calling it a failure costs one retry on another route. The other
 * direction costs plausible garbage, real quota, and a breaker that never
 * opens — and the user cannot tell.
 *
 * Deliberately NOT a general "did any tool call fail" check: an agent hitting
 * a permission error and working around it is normal. This matches the harness
 * reporting that it could not START a process at all, which no prompt can
 * work around.
 */
export function detectHarnessEnvironmentFailure(...streams: string[]): string | undefined {
  // TWO DIAGNOSTIC LINES, in each stream's TAIL.
  //
  // This overrides a SUCCESSFUL exit code, so a false positive is expensive:
  // it charges the route a failure, counts toward the breaker, and tells the
  // caller "any answer it gave was produced without reading or running
  // anything" — a fabricated diagnosis about a run that worked.
  //
  // Counting bare mentions does not separate the two cases. The first version
  // fired on one mention anywhere; raising it to two still fired on a
  // delegate's prose ABOUT this function, which is a realistic thing to
  // receive — this project delegates work on this very file. Both versions
  // were reproduced with a CLI exiting 0 while printing sentences.
  //
  // What separates them better than volume is SHAPE. The harness emits its
  // own diagnostic with the errno attached ("CreateProcessAsUserW failed: 5
  // (Access is denied)"), which prose usually shortens to the bare phrase, so
  // requiring the errno form on two separate LINES needs a real diagnostic,
  // repeated — and a sandbox that cannot spawn fails EVERY attempt, so it
  // repeats by definition (the run this was built from logged six).
  //
  // Narrower, not closed, and worth being exact about both ways:
  //  - Prose QUOTING the full diagnostic on two lines still fires. A report
  //    on this file can do that, including a diff of this function's own
  //    tests. Nothing in the text distinguishes those cases; only the source
  //    of the stream would, and we do not have it here.
  //  - Only `failed: <digits>` matches. `failed (5)`, `failed with error 5`,
  //    or the errno on the next line are all missed. That is deliberate
  //    rather than an oversight: the form above is the one observed live, and
  //    inventing variants would widen a false-positive surface that has
  //    already misfired twice to cover output nobody has seen.
  //
  // Each stream is tailed SEPARATELY, like the rate-limit scanner: six real
  // occurrences on stdout followed by a wall of stderr noise would otherwise
  // fall off the end of a single joined tail.
  const lines = streams.flatMap((s) => rateLimitScanTail(s).split(/\r?\n/));
  const diagnostics = lines.filter((line) => /CreateProcessAsUserW failed:\s*\d+/i.test(line));
  if (diagnostics.length >= 2) {
    return (
      "the harness could not spawn any child process — its sandbox refused " +
      "(CreateProcessAsUserW failed). Any answer it gave was produced without " +
      "reading or running anything. On Windows this is usually a path the " +
      "harness's own sandbox will not run in; try a shorter working directory, " +
      "or a different route."
    );
  }
  return undefined;
}

/**
 * Command-line budgets, deliberately a little under the true limits.
 *
 * Windows: CreateProcess caps the whole command line at 32,767 characters.
 * POSIX: ARG_MAX bounds the total but MAX_ARG_STRLEN caps a SINGLE argument at
 * 128 KiB, and the prompt is one argument, so that is the binding constraint.
 * Under-shooting means the refusal comes from here, with an explanation,
 * rather than from the OS as a bare ENAMETOOLONG.
 */
const WINDOWS_CMDLINE_MAX = 32_000;
const POSIX_ARG_MAX = 128 * 1024 - 2048;
/**
 * cmd.exe's own limit, and the one that actually binds on Windows more often
 * than the CreateProcess figure above.
 *
 * A `.cmd`/`.bat` target is re-spawned through `cmd.exe`, which caps a command
 * line at 8,191 characters — a quarter of the CreateProcess limit. The first
 * version of this check budgeted 32,000 for everything, so the shipped Cursor
 * route (a `cursor-agent.CMD` PowerShell wrapper, not an npm shim, handed
 * straight to cross-spawn) still failed at ~9k characters with the bare
 * "The command line is too long." this check exists to replace. Measured on a
 * stock install; the true ceiling was then bisected at exactly 8,191.
 *
 * Only eleven characters of margin, because commandLineLength no longer
 * estimates — it builds cross-spawn's own escaped forms and measures them, so
 * the slack that used to cover a wrong model is not needed and was costing
 * ~10% of the usable prompt.
 *
 * One case that margin would NOT cover: cross-spawn keys its escaping on the
 * SHEBANG-RESOLVED file, and unshifts the resolved interpreter path as an
 * extra argument. This keys on the raw command, so a shebang script would go
 * ~60 characters uncounted. It cannot happen through the dispatchers here —
 * resolveCliCommand hands over a fully `which`-resolved path, and reaching
 * cross-spawn's shebang branch on Windows needs an extensionless PATHEXT hit
 * — but a future caller passing an unresolved command is the way in.
 */
const WINDOWS_CMD_SHIM_MAX = 8_180;

/**
 * The limit that applies to THIS command, not to the platform in general.
 *
 * Keyed on what cross-spawn will actually DO, not on the extension string.
 * cross-spawn routes through cmd.exe for anything that is not `.com` or `.exe`
 * (lib/parse.js), so an extensionless target, a `.ps1`, or a hand-rolled shim
 * gets the same 8,191-character ceiling as a `.cmd` — the first version of
 * this listed `.cmd`/`.bat` explicitly and handed everything else the
 * four-times-larger CreateProcess budget.
 */
function commandLineBudget(command: string): number {
  if (process.platform !== "win32") return POSIX_ARG_MAX;
  const ext = path.extname(command).toLowerCase();
  return ext === ".exe" || ext === ".com" ? WINDOWS_CMDLINE_MAX : WINDOWS_CMD_SHIM_MAX;
}

/**
 * cross-spawn's own meta-character class, copied verbatim from
 * `cross-spawn/lib/util/escape.js`.
 *
 * Every one of these gets a `^` prefix when the target goes through cmd.exe —
 * INCLUDING THE SPACE, which is the character that made hand-modelling this
 * wrong. My first version counted `"` and `\` only, so ordinary prose (~15%
 * spaces) and JSON measured well under budget and still died with cmd.exe's
 * own "The command line is too long." — from ~6,600 characters for prose and
 * ~4,500 for code, against a guard that did not fire until ~7,820.
 *
 * Copied rather than imported because it lives in cross-spawn's internals,
 * which are not part of its public API. The coupling is real either way; a
 * copy at least fails visibly if cross-spawn changes, and the tests below pin
 * the shapes that actually matter.
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * cross-spawn double-escapes meta chars for an npm-style cmd shim
 * (`node_modules/.bin/x.cmd`) — `isCmdShimRegExp` in its `lib/parse.js`.
 *
 * Counting them once meant such a target died at ~5,300 characters while the
 * estimate said 6,400 against a budget of 8,000, so the guard stayed silent
 * and the bare "The command line is too long." reached the caller anyway.
 */
const CMD_SHIM_DOUBLE_ESCAPE_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

/**
 * `<comspec> /d /s /c "` … `"` — what cross-spawn actually spawns, and it
 * counts against the same ceiling.
 *
 * comspec, not the literal "cmd.exe": cross-spawn uses
 * `process.env.comspec || "cmd.exe"`, which on a normal Windows install is the
 * full `C:\WINDOWS\system32\cmd.exe` — twenty characters longer than the
 * constant this started as. The drift test below caught that on its first run.
 */
function cmdWrapperOverhead(): number {
  return `${process.env["comspec"] || "cmd.exe"} /d /s /c ""`.length;
}

/**
 * cross-spawn's `escapeCommand`, replicated: meta chars only, no quoting.
 */
function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * cross-spawn's `escapeArgument`, replicated from `lib/util/escape.js`.
 *
 * REPLICATED, NOT ESTIMATED. The previous version added one character per
 * backslash, but backslashes are only doubled in a run immediately before a
 * quote or the end of the argument — so prompts full of Windows paths (~9%
 * backslashes) were over-counted and REFUSED although they ran: an
 * 804-character band, about 10% of the usable prompt, on the very route the
 * check was written for. Before that the same function under-counted spaces.
 * Both are the cost of hand-modelling something that already exists.
 */
function escapeCmdArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let out = quoteWindowsArgument(arg);
  out = out.replace(CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) out = out.replace(CMD_META_CHARS, "^$1");
  return out;
}

/**
 * The quoting half, which applies to EVERY Windows spawn — cmd.exe target or
 * not. Only the `^` meta escaping above is cmd-specific.
 *
 * Split out because the first version of the non-cmd branch counted
 * `arg.length + 3` and so ignored quote escaping entirely, which under-read a
 * quote-heavy prompt heading for a native `.exe`. Caught by the test written
 * for exactly that case one release earlier — the two branches need the same
 * quoting and differ only in what comes after it.
 */
function quoteWindowsArgument(arg: string): string {
  let out = String(arg);
  // A run of backslashes followed by a double quote: double the run, escape
  // the quote.
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // A run of backslashes at the end (about to be followed by the closing
  // quote): double it.
  out = out.replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${out}"`;
}

/**
 * How long the command line will actually be once escaped.
 *
 * Counting raw characters under-reads on Windows, where every `"` in an
 * argument is escaped to `\"` and every argument containing whitespace is
 * wrapped in quotes. A 31,000-character prompt that is ~10% quote characters —
 * ordinary for JSON or source code — measured under the budget and then threw
 * `spawn ENAMETOOLONG` anyway. Deliberately an over-estimate: refusing a
 * borderline prompt with an explanation beats spawning one that dies with an
 * errno.
 */
function commandLineLength(command: string, args: string[]): number {
  if (process.platform !== "win32") {
    return args.reduce((n, a) => n + a.length + 1, command.length);
  }
  if (commandLineBudget(command) !== WINDOWS_CMD_SHIM_MAX) {
    // Straight to CreateProcess: the same quoting, without cmd.exe's escaping.
    return args.reduce((n, a) => n + quoteWindowsArgument(a).length + 1, command.length);
  }
  // cmd.exe target. Build the escaped forms and MEASURE them, rather than
  // estimating from character counts — two releases running, the estimate was
  // wrong in one direction and then the other.
  const double = CMD_SHIM_DOUBLE_ESCAPE_RE.test(command);
  const parts = [escapeCmdCommand(command), ...args.map((a) => escapeCmdArgument(a, double))];
  // `cmd.exe /d /s /c "<line>"` — the wrapper cross-spawn actually spawns, and
  // it counts against the same 8,191 ceiling. Uncounted before, which put the
  // estimate a constant ~29 characters under the truth.
  return cmdWrapperOverhead() + parts.join(" ").length;
}

/** Walk a nested object by dotted path, e.g. "message.content". */
function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

function extractField(obj: unknown, fields: string[]): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  for (const field of fields) {
    const v = getPath(obj, field);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function parseJsonBlob(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Unique parent directories of absolute file paths, excluding workingDir itself — same rule for every harness. */
function includedDirectories(files: string[], workingDir: string): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    if (!path.isAbsolute(file)) continue;
    const dir = path.dirname(file);
    if (dir !== workingDir) dirs.add(dir);
  }
  return [...dirs];
}

function buildFullPrompt(protocol: CliProtocolConfig, prompt: string, files: string[]): string {
  if (files.length === 0 || !protocol.fileListHeader) return prompt;
  const bullet = protocol.fileListBullet ?? "  ";
  const fileList = files.map((p) => `${bullet}${p}`).join("\n");
  return `${prompt}\n\n${protocol.fileListHeader}\n${fileList}`;
}

/** Expand one `protocol.args` token into zero or more literal argv tokens — see CliProtocolConfig's doc comment for the token reference. */
function expandToken(
  token: string,
  protocol: CliProtocolConfig,
  prompt: string,
  files: string[],
  workingDir: string,
  effectiveModel: string | undefined,
  safetyProfile: SafetyProfile,
  nativeArgs: string[],
): string[] {
  switch (token) {
    case "{{prompt}}":
      return protocol.stdin ? [] : [prompt];
    case "{{model}}":
      return protocol.model && effectiveModel ? [protocol.model.flag, effectiveModel] : [];
    case "{{safety}}":
      return protocol.safety?.[safetyProfile] ? [...protocol.safety[safetyProfile]] : [];
    case "{{working_dir}}":
      return protocol.workingDir && workingDir
        ? [protocol.workingDir.flag, workingDir, ...(protocol.workingDir.extraArgsWhenSet ?? [])]
        : [];
    case "{{file_dirs}}":
      if (!protocol.fileDirs) return [];
      return includedDirectories(files, workingDir).flatMap((dir) => [protocol.fileDirs!.flag, dir]);
    case "{{native_args}}":
      return nativeArgs;
    default:
      return [token];
  }
}

function buildArgs(
  protocol: CliProtocolConfig,
  prefixArgs: string[],
  prompt: string,
  files: string[],
  workingDir: string,
  effectiveModel: string | undefined,
  nativeArgs: string[],
  opts: DispatchOpts,
): string[] {
  const safetyProfile: SafetyProfile = opts.safetyProfile ?? "workspace_edit";
  const args: string[] = [...prefixArgs];
  for (const token of protocol.args) {
    args.push(...expandToken(token, protocol, prompt, files, workingDir, effectiveModel, safetyProfile, nativeArgs));
  }
  return args;
}

/**
 * Event-rule-driven JSONL line handler — the declarative equivalent of
 * Codex's original hand-written `emitLine`. Mutates the shared accumulator
 * state and returns any mid-run DispatcherEvents this line produced.
 */
class JsonlAccumulator {
  lastText = "";
  inputTokens = 0;
  outputTokens = 0;
  sawUsage = false;
  sawAnyJson = false;
  /** Parsed event lines, for diagnosing a run that streamed and then produced nothing. */
  eventCount = 0;
  /**
   * The last `type` seen, whatever it was.
   *
   * A stream that stops after `turn.started` failed differently from one that
   * stops after `item.completed`, and neither is visible in an exit code. This
   * is diagnosis only — it never decides success, so a benign frame cannot
   * fail a healthy run.
   */
  lastEventType: string | undefined;
  /** Set by the first matching emit: "error" rule; last one wins if several match across the stream. */
  errorMessage: string | undefined;

  constructor(private readonly rules: CliEventRule[]) {}

  process(line: string): DispatcherEvent[] {
    const out: DispatcherEvent[] = [];
    const trimmed = line.trim();
    if (!trimmed) return out;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return out;
    }
    this.sawAnyJson = true;
    this.eventCount += 1;
    const eventType = getPath(event, "type");
    if (typeof eventType === "string") this.lastEventType = eventType;

    for (const rule of this.rules) {
      const matches = Object.entries(rule.when).every(([field, value]) => getPath(event, field) === value);
      if (!matches) continue;

      switch (rule.emit) {
        case "text": {
          const t = rule.textField ? getPath(event, rule.textField) : undefined;
          if (typeof t === "string" && t.length > 0) this.lastText = t;
          break;
        }
        case "tool_use": {
          const name = rule.nameField ? getPath(event, rule.nameField) : undefined;
          if (typeof name === "string") {
            out.push({ type: "tool_use", name, input: rule.inputField ? getPath(event, rule.inputField) : undefined });
          }
          break;
        }
        case "thinking": {
          const chunk = rule.chunkField ? getPath(event, rule.chunkField) : undefined;
          if (typeof chunk === "string" && chunk.length > 0) out.push({ type: "thinking", chunk });
          break;
        }
        case "usage": {
          const inTok = firstNumberAt(event, rule.inputTokenFields ?? []);
          const outTok = firstNumberAt(event, rule.outputTokenFields ?? []);
          if (inTok || outTok) {
            this.inputTokens += inTok;
            this.outputTokens += outTok;
            this.sawUsage = true;
          }
          break;
        }
        case "error": {
          const message = rule.messageField ? getPath(event, rule.messageField) : undefined;
          if (typeof message === "string" && message.length > 0) this.errorMessage = message;
          break;
        }
      }
    }
    return out;
  }
}

function firstNumberAt(obj: unknown, fields: string[]): number {
  for (const field of fields) {
    const v = getPath(obj, field);
    if (typeof v === "number") return v;
  }
  return 0;
}

/**
 * Every present field added together — for token counts a vendor SPLITS across
 * siblings rather than spelling differently. See CliProtocolConfig.output.usage
 * for why the two behaviours cannot be the same list.
 */
function sumNumbersAt(obj: unknown, fields: string[] | undefined): number {
  let total = 0;
  for (const field of fields ?? []) {
    const v = getPath(obj, field);
    if (typeof v === "number") total += v;
  }
  return total;
}

export class GenericCliDispatcher extends BaseDispatcher {
  readonly id: string;
  private readonly command: string;
  private readonly protocol: CliProtocolConfig | undefined;
  private readonly apiKey: string | undefined;
  private readonly configuredModel: string | undefined;
  private readonly endpointMode: ServiceConfig["endpointMode"];
  private readonly endpointProvider: ServiceConfig["endpointProvider"];
  private readonly siblingApiKeyEnvVars: ReadonlySet<string>;

  /**
   * @param siblingApiKeyEnvVars every api-key env var ANY route might use, so
   * this dispatch can clear the ones that aren't its own. Supplied by
   * dispatcher-factory, which is the only place that sees the whole config.
   * Optional so a hand-built dispatcher (tests, one-off scripts) still works;
   * it then falls back to clearing only its own, the previous behaviour.
   */
  constructor(svc?: ServiceConfig, siblingApiKeyEnvVars?: ReadonlySet<string>) {
    super();
    this.siblingApiKeyEnvVars = siblingApiKeyEnvVars ?? new Set();
    this.id = svc?.name ?? "generic";
    this.command = svc?.command ?? "";
    this.protocol = svc?.protocol;
    this.apiKey = svc?.apiKey;
    this.configuredModel = svc?.model;
    this.endpointMode = svc?.endpointMode;
    this.endpointProvider = svc?.endpointProvider;
  }

  isAvailable(): boolean {
    return Boolean(this.command) && Boolean(this.protocol) && commandAvailable(this.command);
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }

  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<DispatcherEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts,
  ): AsyncGenerator<DispatcherEvent> {
    const protocol = this.protocol;
    if (!this.command || !protocol) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error:
            `Route '${this.id}' is missing 'command' and/or 'protocol' — both are ` +
            "required for harness: generic. See README.md#adding-a-harness.",
        },
      };
      return;
    }
    const foundPath = await which(this.command, { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: `'${this.command}' not found on PATH`,
        },
      };
      return;
    }

    const effectiveWorkingDir =
      !workingDir && protocol.workingDir?.fallback === "home" ? os.homedir() : workingDir;
    const fullPrompt = buildFullPrompt(protocol, prompt, files);
    const effectiveModel = opts.modelOverride ?? this.configuredModel;
    const nativeArgs =
      this.endpointMode === "harness_native_endpoint" && this.endpointProvider
        ? (protocol.endpointNativeArgs?.[this.endpointProvider] ?? [])
        : [];

    const resolved = await resolveCliCommand(this.command);
    const args = buildArgs(
      protocol,
      resolved.prefixArgs,
      fullPrompt,
      files,
      effectiveWorkingDir,
      effectiveModel,
      nativeArgs,
      opts,
    );

    const extraEnv: Record<string, string> = {};
    // Clear every OTHER route's api-key variable that is present in this
    // process. The child inherits process.env wholesale, and there is no
    // reason for Codex to receive a Groq key. Blanking rather than deleting
    // because streamSubprocess merges over process.env; an empty value is
    // what the existing single-variable clear already used.
    for (const envVar of this.siblingApiKeyEnvVars) {
      if (envVar === protocol.apiKeyEnvVar) continue;
      if (process.env[envVar]) extraEnv[envVar] = "";
    }
    if (protocol.apiKeyEnvVar) {
      if (this.apiKey) {
        extraEnv[protocol.apiKeyEnvVar] = this.apiKey;
      } else if (process.env[protocol.apiKeyEnvVar]) {
        extraEnv[protocol.apiKeyEnvVar] = "";
      }
    }

    // A prompt too long for this route's COMMAND LINE, caught before spawning.
    //
    // A route that takes the prompt on argv is bounded by the OS: Windows caps
    // a whole command line at 32,767 characters, and POSIX caps a single
    // argument at 128 KiB. Past that the spawn failed with a raw
    // `spawn ENAMETOOLONG` — accurate, unexplained, and pointing at nothing
    // the caller could act on. Measured: 30k characters worked, 100k did not.
    //
    // Per route, not at the schema, because it is genuinely per route: codex
    // reads the prompt from stdin and has no such limit, so a boundary cap
    // would refuse work that route can do. Saying which routes CAN take it is
    // the useful half of the message.
    if (!protocol.stdin) {
      const budget = commandLineBudget(resolved.command);
      const commandLineChars = commandLineLength(resolved.command, args);
      if (commandLineChars > budget) {
        yield {
          type: "completion",
          result: {
            output: "",
            service: this.id,
            success: false,
            error:
              `prompt too long for ${this.id}: the command line would be about ` +
              `${commandLineChars.toLocaleString()} characters once escaped, and this ` +
              `command accepts ${budget.toLocaleString()}. ${this.id} passes the prompt as a ` +
              `command-line argument. Send the bulk as files instead of inline text, shorten ` +
              `the prompt, or use a route that reads the prompt from stdin (codex does).`,
            // Not the route's fault, so not the route's failure. See
            // DispatchResult.inputRejected.
            inputRejected: true,
            durationMs: 0,
          },
        };
        return;
      }
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (effectiveWorkingDir) subOpts.cwd = effectiveWorkingDir;
    if (protocol.stdin) subOpts.stdin = fullPrompt;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;
    // Cancellation reaches the child here, not by unwinding the iterator —
    // an agent CLI that has gone silent cannot be interrupted any other way.
    if (opts.signal) subOpts.signal = opts.signal;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    const eventDriven = protocol.output.mode === "jsonl_stream" && protocol.output.eventRules;
    const acc = eventDriven ? new JsonlAccumulator(protocol.output.eventRules!) : undefined;
    let lineBuffer = "";

    for await (const evt of streamSubprocess(resolved.command, args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
          if (acc) {
            lineBuffer += evt.chunk;
            let newlineIdx = lineBuffer.indexOf("\n");
            while (newlineIdx >= 0) {
              const line = lineBuffer.slice(0, newlineIdx);
              lineBuffer = lineBuffer.slice(newlineIdx + 1);
              for (const out of acc.process(line)) yield out;
              newlineIdx = lineBuffer.indexOf("\n");
            }
          }
        } else {
          stderrBuf.push(evt.chunk);
          yield { type: "stderr", chunk: evt.chunk };
        }
      } else {
        exitCode = evt.exitCode;
        durationMs = evt.durationMs;
        timedOut = evt.timedOut;
      }
    }
    if (acc && lineBuffer.length > 0) {
      for (const out of acc.process(lineBuffer)) yield out;
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: this.id,
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    let parsedOutput: string | undefined;
    let tokensUsed: { input: number; output: number } | undefined;
    /**
     * A structured, unambiguous error message extracted from a parsed CLI
     * response (event `emit: "error"` rule, or `output.error`'s boolean
     * field) — takes priority over exit code and raw-text heuristics below.
     * Exists because a CLI can report failure while exiting 0 (Claude
     * Code's is_error flag) or bury the real message behind an unrelated
     * exit-1 stderr banner (Codex — confirmed 2026-07-24: its actual error
     * is JSON on stdout; stderr is just "Reading additional input from
     * stdin...", which the old stderr-first fallback picked instead).
     */
    let structuredError: string | undefined;

    if (eventDriven && acc) {
      // Windows cmd /c can shuffle streams — if nothing parsed from stdout, retry stderr.
      if (!acc.sawAnyJson && stderr) {
        for (const line of stderr.split(/\r?\n/)) acc.process(line);
      }
      parsedOutput = acc.sawAnyJson ? acc.lastText.trim() || undefined : undefined;
      if (acc.sawUsage) tokensUsed = { input: acc.inputTokens, output: acc.outputTokens };
      structuredError = acc.errorMessage;
    } else {
      const fields = protocol.output.fields ?? ["result", "output", "text", "response"];
      switch (protocol.output.mode) {
        case "text":
          parsedOutput = stdout.trim() || undefined;
          break;
        case "json_field": {
          const stdoutJson = parseJsonBlob(stdout);
          const stdoutText = stdoutJson !== undefined ? extractField(stdoutJson, fields) : undefined;
          let usageSource = stdoutJson;
          if (stdoutText !== undefined) {
            parsedOutput = stdoutText;
          } else {
            const stderrJson = parseJsonBlob(stderr);
            parsedOutput = stderrJson !== undefined ? extractField(stderrJson, fields) : undefined;
            usageSource = stderrJson ?? stdoutJson;
          }
          if (usageSource !== undefined && protocol.output.usage) {
            const inTok =
              firstNumberAt(usageSource, protocol.output.usage.input) +
              sumNumbersAt(usageSource, protocol.output.usage.inputExtra);
            const outTok =
              firstNumberAt(usageSource, protocol.output.usage.output) +
              sumNumbersAt(usageSource, protocol.output.usage.outputExtra);
            if (inTok || outTok) tokensUsed = { input: inTok, output: outTok };
          }
          if (usageSource !== undefined && protocol.output.error) {
            const flagged = getPath(usageSource, protocol.output.error.field) === true;
            if (flagged) {
              const messageFields = protocol.output.error.messageFields ?? fields;
              structuredError =
                extractField(usageSource, messageFields) ??
                `CLI reported an error (${protocol.output.error.field} set) with no extractable message`;
            }
          }
          break;
        }
        case "jsonl_stream": {
          const parts: string[] = [];
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const text = extractField(JSON.parse(trimmed), fields);
              if (text) parts.push(text);
            } catch {
              // Non-JSON line — ignore rather than fail the whole parse.
            }
          }
          parsedOutput = parts.join("") || undefined;
          break;
        }
      }
    }

    const lenient = protocol.successRequiresOutput === false;

    // Checked before the success paths, and on BOTH streams: the harness
    // reports this on whichever one it likes while its real payload goes to
    // the other, and a lenient exit-0 route would otherwise return the
    // delegate's uninformed answer as a success.
    const envFailure = detectHarnessEnvironmentFailure(stdout, stderr);

    // A structured error overrides exit code entirely — a CLI that reports
    // failure in its own response body (is_error, a turn.failed event) is
    // reporting failure regardless of what the process exit code says.
    if (structuredError === undefined && envFailure === undefined) {
      if (lenient && exitCode === 0) {
        const output = parsedOutput ?? (stdout.trim() || stderr.trim());
        const result: DispatchResult = { output, service: this.id, success: true, durationMs };
        if (tokensUsed) result.tokensUsed = tokensUsed;
        yield { type: "completion", result };
        return;
      }
      if (!lenient && exitCode === 0 && parsedOutput) {
        const result: DispatchResult = { output: parsedOutput, service: this.id, success: true, durationMs };
        if (tokensUsed) result.tokensUsed = tokensUsed;
        yield { type: "completion", result };
        return;
      }
    }

    // Text-mode CLIs conventionally put real error text on stderr with
    // stdout empty; JSON-oriented modes (json_field/jsonl_stream) put their
    // real payload — errors included — on stdout, with stderr often just
    // decorative banner noise (see structuredError's doc comment). A
    // structuredError, when present, is authoritative over both.
    const rawErrorFallback =
      protocol.output.mode === "text"
        ? stderr.trim() || stdout.trim()
        : stdout.trim() || stderr.trim();
    // Event-driven modes only: there, rawErrorFallback IS the raw JSONL event
    // stream, so a CLI that emitted valid events and then exited non-zero
    // reported ~300 chars of {"type":"thread.started",...} as its error.
    // Observed across 9 real failures on 2026-08-03, after 11-88s waits, while
    // the parsed agent_message sat unused. Gated on eventDriven deliberately:
    // in text mode parsedOutput IS stdout, and preferring it would defeat the
    // stderr-first rule above (a real error on stderr losing to stray stdout).
    // structuredError still wins — a turn.failed reason beats the last
    // message — and rawErrorFallback still covers the nothing-parsed case.
    const parsedErrorDetail = eventDriven ? parsedOutput : undefined;
    // And when NOTHING parsed either, say what happened instead of dumping the
    // stream. That is the case the 9 failures above actually hit: no
    // agent_message was ever emitted, so parsedErrorDetail was undefined too
    // and rawErrorFallback won — 300 characters of JSONL, truncated
    // mid-sentence, as the caller's only explanation.
    //
    // Deliberately NOT a new event rule for Codex's nested
    // {"item":{"type":"error"}} frame, which is the obvious-looking fix and is
    // wrong: structuredError overrides the exit code, so the benign notice
    // that frame carries ("Skill descriptions were shortened... Codex can
    // still see every skill") would mark HEALTHY runs failed, charge the route
    // and move the breaker. This path only ever runs on a run that already
    // failed with nothing to show for it, so it cannot do that.
    const streamedNothing =
      eventDriven && acc && parsedOutput === undefined && acc.sawAnyJson
        ? `the harness streamed ${acc.eventCount} event${acc.eventCount === 1 ? "" : "s"} ` +
          `(last: ${acc.lastEventType ?? "unknown"}) and then stopped without producing an ` +
          `answer — exit code ${exitCode}. Its output is not an error message; there was no ` +
          `result to return. Retry, or send this task to a different route.`
        : undefined;
    // envFailure leads: it explains WHY whatever else is here is untrustworthy,
    // and the delegate's own last message ("Unable to read file.") is a symptom
    // that reads like a normal answer on its own.
    const errorDetail =
      envFailure ??
      structuredError ??
      parsedErrorDetail ??
      streamedNothing ??
      (rawErrorFallback || `Exit code ${exitCode}`);
    // Scan BOTH streams, not just whichever one errorDetail resolved to.
    // e78c87a narrowed this to detectRateLimit(errorDetail) while adding
    // structured-error support, so a 429 on the stream that lost the
    // errorDetail race stopped being detected — for jsonl_stream that means a
    // rate limit on stderr while stdout carries the event payload. The
    // message shown to the caller stays errorDetail; only the DETECTION
    // widens.
    const { rateLimited, retryAfter } = detectRateLimit(
      [errorDetail, rateLimitScanTail(stdout), rateLimitScanTail(stderr)]
        .filter(Boolean)
        .join("\n"),
    );
    const result: DispatchResult = {
      output: parsedOutput ?? errorDetail,
      service: this.id,
      success: false,
      error: errorDetail,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    if (tokensUsed) result.tokensUsed = tokensUsed;
    yield { type: "completion", result };
  }
}

/** Exported for the drift test against cross-spawn. Not part of the API. */
export const __commandLineLengthForTest = commandLineLength;
