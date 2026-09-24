/**
 * Config-driven CLI dispatcher for harness-dispatch.
 *
 * Every part of the invocation comes from `svc.protocol` (CliProtocolConfig in
 * types.ts): prompt input style, working-dir flag, per-file directory flags,
 * model flag, per-safety-profile args, API-key env injection, and (via
 * `eventRules`) tool_use/thinking/usage streaming-event semantics. This is the
 * ONE interpreter for every CLI harness, with no hardcoded knowledge of any
 * specific CLI, so a new harness needs zero new TypeScript.
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
import { DEFAULT_MAX_OUTPUT_BYTES, streamSubprocess } from "./shared/stream-subprocess.js";
import { redactSecretValue } from "../status.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";
import { commandAvailable } from "./shared/which-available.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * "429" only counts next to HTTP context, with nothing but separators between:
 * a bare includes("429") flags any failed run whose transcript mentions the
 * number at all — a port, a line number, a test count — and one flag trips the
 * breaker with NO threshold, blocking the route for 300s. The phrase list
 * below covers limiters that spell it out; this covers the ones that send only
 * the status code.
 */
const HTTP_429_RE =
  /\b(?:http|status(?:[_\s]?code)?|error(?:[_\s]?code)?|code)\b["'\s:=_,-]{0,4}429\b|\b429\b[\s:-]{0,3}too many requests/i;

/**
 * Text that is TALKING ABOUT a 429 rather than reporting one.
 *
 * "expected error code 429 but got 200" is a test suite the delegate RAN, not
 * a limiter the delegate HIT, and flagging it blocks the route for 300
 * seconds. Checked per line, so an assertion elsewhere in a long transcript
 * cannot mask a genuine 429 on its own line. The tick/cross and "Test
 * Files"/"Tests " markers cover vitest output, where a test NAME containing
 * "usage limit" carries no assertion keyword at all.
 *
 * A HEURISTIC: separating "hit a limiter" from "printed the words" is
 * undecidable from text alone, and every widening risks the worse failure, a
 * MISSED limit that leaves the router hammering an exhausted route. Hence no
 * `should` (it would discard "429 received; the request should be retried")
 * and no discrimination by stream (some CLIs print limiter errors to stdout).
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
 * Only the TAIL of each stream is scanned, per stream, before joining. Failed
 * runs carry up to 10 MB of agent transcript and a limiter message a CLI died
 * from is at the end of its output; scanning the rest mostly adds chances for
 * an innocent mention in the AGENT'S OWN WORK to block the route.
 */
const RATE_LIMIT_SCAN_TAIL_BYTES = 16 * 1024;

export function rateLimitScanTail(text: string): string {
  return text.length > RATE_LIMIT_SCAN_TAIL_BYTES ? text.slice(-RATE_LIMIT_SCAN_TAIL_BYTES) : text;
}

/** Phrases a limiter actually uses, matched per line. */
const LIMITER_PHRASES = [
  "rate limit",
  // Anthropic's own error type, and OpenAI's 429 body text — neither is
  // covered by the spaced `rate limit` / `quota exceeded` forms, and a missed
  // limiter is the worse direction: the router keeps hammering a route that
  // has already said stop.
  "rate_limit_error",
  "rate-limited",
  "quota exceeded",
  "exceeded your quota",
  "exceeded your current quota",
  "resource_exhausted",
  "too many requests",
  // OpenAI Codex's phrasing ("You've hit your usage limit... try again at
  // ..."), which none of the phrases above match.
  "usage limit",
];

/** Exported for tests: the false-positive space here is what trips breakers. */
export function detectRateLimit(text: string): { rateLimited: boolean; retryAfter: number | null } {
  // PER LINE, and past the assertion filter — like the 429 check beside it.
  // Matching these phrases against the whole blob unfiltered lets this
  // repository's own vitest output flag as rate-limited, tripping the breaker
  // with no threshold on a delegated "run the tests" task.
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
 * Codex's Windows sandbox can fail to spawn ANY child on a deep path
 * (`CreateProcessAsUserW failed: 5 (Access is denied)`). The delegate, unable
 * to read anything, answers something like "Unable to read file.", the process
 * exits 0, and a lenient harness would report `success: true` — a counted
 * success, a breaker left closed, and a router that keeps choosing a route
 * which can do nothing.
 *
 * Erring toward failure is deliberate: a wrongly failed run costs one retry
 * elsewhere, the other direction costs plausible garbage and real quota with
 * no way for the user to tell.
 *
 * Deliberately NOT a general "did any tool call fail" check — an agent working
 * around a permission error is normal. This matches the harness reporting that
 * it could not START a process at all, which no prompt can work around.
 */
export function detectHarnessEnvironmentFailure(...streams: string[]): string | undefined {
  // TWO DIAGNOSTIC LINES, in each stream's TAIL.
  //
  // This overrides a SUCCESSFUL exit code, so a false positive is expensive:
  // it charges the route a failure and tells the caller its answer was
  // produced without reading or running anything. Bare mentions do not
  // separate the cases — a delegate's prose ABOUT this function is a realistic
  // thing to receive, since this project delegates work on this very file.
  // SHAPE does: the harness attaches the errno ("CreateProcessAsUserW failed:
  // 5 (Access is denied)") where prose shortens to the phrase, and a sandbox
  // that cannot spawn fails EVERY attempt, so a real diagnostic repeats.
  //
  // Narrower, not closed, both ways: prose QUOTING the full diagnostic on two
  // lines still fires, and only `failed: <digits>` matches — `failed (5)` or
  // the errno on the next line are missed, deliberately, rather than widening
  // a false-positive surface to cover output nobody has seen.
  //
  // Each stream is tailed SEPARATELY, like the rate-limit scanner: real
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
 * Command-line budgets, deliberately a little under the true limits, so the
 * refusal comes from here with an explanation rather than from the OS as a bare
 * ENAMETOOLONG. Windows: CreateProcess caps the whole command line at 32,767
 * characters. POSIX: MAX_ARG_STRLEN caps a SINGLE argument at 128 KiB, and the
 * prompt is one argument, so that binds before ARG_MAX.
 */
const WINDOWS_CMDLINE_MAX = 32_000;
const POSIX_ARG_MAX = 128 * 1024 - 2048;
/**
 * cmd.exe's own limit, and the one that actually binds on Windows more often
 * than the CreateProcess figure above.
 *
 * A `.cmd`/`.bat` target is re-spawned through `cmd.exe`, which caps a command
 * line at exactly 8,191 characters — a quarter of the CreateProcess limit. The
 * shipped Cursor route (a `cursor-agent.CMD` wrapper handed straight to
 * cross-spawn) hits it at ~9k characters.
 *
 * Only eleven characters of margin, because commandLineLength measures
 * cross-spawn's own escaped forms rather than estimating, and wider slack
 * costs ~10% of the usable prompt.
 *
 * One case that margin would NOT cover: cross-spawn keys its escaping on the
 * SHEBANG-RESOLVED file and unshifts the interpreter path as an extra
 * argument, ~60 characters this does not count. Unreachable through these
 * dispatchers — resolveCliCommand hands over a `which`-resolved path — but a
 * future caller passing an unresolved command is the way in.
 */
const WINDOWS_CMD_SHIM_MAX = 8_180;

/**
 * The limit that applies to THIS command, not to the platform in general.
 *
 * Keyed on what cross-spawn will actually DO, not on the extension string.
 * cross-spawn routes through cmd.exe for anything that is not `.com` or `.exe`
 * (lib/parse.js), so an extensionless target, a `.ps1`, or a hand-rolled shim
 * gets the same 8,191-character ceiling as a `.cmd`, rather than the
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
 * INCLUDING THE SPACE, which is why hand-modelling the escaped length does not
 * work: ordinary prose is ~15% spaces, so counting only `"` and `\` puts a
 * line that dies at ~6,600 characters well under an 8,000 budget.
 *
 * Copied rather than imported because it lives in cross-spawn's internals,
 * which are not part of its public API. A copy at least fails visibly if
 * cross-spawn changes, and the tests pin the shapes that matter.
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * cross-spawn double-escapes meta chars for an npm-style cmd shim
 * (`node_modules/.bin/x.cmd`) — `isCmdShimRegExp` in its `lib/parse.js`.
 *
 * Counting them once under-reads such a target badly enough for the guard to
 * stay silent while cmd.exe refuses the line.
 */
const CMD_SHIM_DOUBLE_ESCAPE_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

/**
 * `<comspec> /d /s /c "` … `"` — what cross-spawn actually spawns, and it
 * counts against the same ceiling.
 *
 * comspec, not the literal "cmd.exe": cross-spawn uses
 * `process.env.comspec || "cmd.exe"`, which on a normal Windows install is the
 * full `C:\WINDOWS\system32\cmd.exe` — twenty characters longer than the bare
 * name.
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
 * REPLICATED, NOT ESTIMATED. Backslashes are only doubled in a run immediately
 * before a quote or the end of the argument, so a per-backslash estimate
 * over-counts prompts full of Windows paths and refuses work that would have
 * run — about 10% of the usable prompt on the route this check was written for.
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
 * Split out because both branches need the same quoting and differ only in
 * what comes after it; without it, the non-cmd branch under-reads a
 * quote-heavy prompt heading for a native `.exe`.
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
 * wrapped in quotes: a 31,000-character prompt that is ~10% quote characters,
 * ordinary for JSON or source code, measures under the budget and then throws
 * `spawn ENAMETOOLONG`. Deliberately an over-estimate — refusing a borderline
 * prompt with an explanation beats spawning one that dies with an errno.
 */
function commandLineLength(command: string, args: string[]): number {
  if (process.platform !== "win32") {
    // BYTES, not code units. The kernel counts bytes (MAX_ARG_STRLEN is
    // 131072 per argument); `String.length` counts UTF-16 units, so 100,000
    // CJK characters in one argument measure as 100,021 against a 129,024
    // budget — the guard would not fire — while the kernel sees 300,000 bytes
    // and the spawn dies with E2BIG. Reachable in practice: the guard only
    // runs when a protocol does NOT use stdin, and antigravity_cli puts the
    // prompt in argv while advertising a two-million-token input.
    return args.reduce((n, a) => n + Buffer.byteLength(a, "utf8") + 1, Buffer.byteLength(command, "utf8"));
  }
  if (commandLineBudget(command) !== WINDOWS_CMD_SHIM_MAX) {
    // Straight to CreateProcess: the same quoting, without cmd.exe's escaping.
    return args.reduce((n, a) => n + quoteWindowsArgument(a).length + 1, command.length);
  }
  // cmd.exe target. Build the escaped forms and MEASURE them, rather than
  // estimating from character counts.
  const double = CMD_SHIM_DOUBLE_ESCAPE_RE.test(command);
  const parts = [escapeCmdCommand(command), ...args.map((a) => escapeCmdArgument(a, double))];
  // `cmd.exe /d /s /c "<line>"` — the wrapper cross-spawn actually spawns, and
  // it counts against the same 8,191 ceiling.
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
 * Event-rule-driven JSONL line handler. Mutates the shared accumulator state
 * and returns any mid-run DispatcherEvents this line produced.
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
   * The last `type` seen, whatever it was: a stream that stops after
   * `turn.started` failed differently from one that stops after
   * `item.completed`, and neither is visible in an exit code. Diagnosis only —
   * it never decides success, so a benign frame cannot fail a healthy run.
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

      out.push(...this.#apply(rule, event));
    }
    return out;
  }

  /** One matched rule, applied. Each arm is independent of the rule loop. */
  #apply(rule: CliEventRule, event: unknown): DispatcherEvent[] {
    if (rule.emit === "text") {
      const text = rule.textField ? getPath(event, rule.textField) : undefined;
      if (typeof text === "string" && text.length > 0) this.lastText = text;
      return [];
    }

    if (rule.emit === "tool_use") {
      const name = rule.nameField ? getPath(event, rule.nameField) : undefined;
      if (typeof name !== "string") return [];
      return [
        {
          type: "tool_use",
          name,
          input: rule.inputField ? getPath(event, rule.inputField) : undefined,
        },
      ];
    }

    if (rule.emit === "thinking") {
      const chunk = rule.chunkField ? getPath(event, rule.chunkField) : undefined;
      return typeof chunk === "string" && chunk.length > 0 ? [{ type: "thinking", chunk }] : [];
    }

    if (rule.emit === "usage") {
      const inTok = firstNumberAt(event, rule.inputTokenFields ?? []);
      const outTok = firstNumberAt(event, rule.outputTokenFields ?? []);
      if (inTok || outTok) {
        this.inputTokens += inTok;
        this.outputTokens += outTok;
        this.sawUsage = true;
      }
      return [];
    }

    if (rule.emit === "error") {
      const message = rule.messageField ? getPath(event, rule.messageField) : undefined;
      if (typeof message === "string" && message.length > 0) this.errorMessage = message;
    }
    return [];
  }
}

/**
 * Every requested field, concatenated across a whole JSONL transcript.
 *
 * The fallback for a harness whose protocol declares no `eventRules`: no line
 * is authoritative, so every one that yields text contributes. Non-JSON lines
 * are skipped, because harnesses interleave plain log lines with their events.
 */
function concatJsonlFields(stdout: string, fields: string[]): string | undefined {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const text = extractField(JSON.parse(trimmed), fields);
      if (text) parts.push(text);
    } catch {
      // Not JSON — a log line, not an event.
    }
  }
  return parts.join("") || undefined;
}

/**
 * Token counts out of whichever JSON body carried them, or undefined.
 *
 * Returning undefined rather than mutating a variable in the caller is what
 * lets the call site be one line: "these counts, if there are any".
 */
function readUsage(
  source: unknown,
  usage: CliProtocolConfig["output"]["usage"],
): { input: number; output: number } | undefined {
  if (source === undefined || !usage) return undefined;
  const input = firstNumberAt(source, usage.input) + sumNumbersAt(source, usage.inputExtra);
  const output = firstNumberAt(source, usage.output) + sumNumbersAt(source, usage.outputExtra);
  return input || output ? { input, output } : undefined;
}

/**
 * The error a CLI declared in its own output, or undefined.
 *
 * The fallback message matters: a harness that sets its error flag and gives
 * nothing readable would otherwise fail with an empty string, which reads as
 * a success with no output.
 */
function readStructuredError(
  source: unknown,
  error: CliProtocolConfig["output"]["error"],
  fallbackFields: string[],
): string | undefined {
  if (source === undefined || !error) return undefined;
  if (getPath(source, error.field) !== true) return undefined;
  return (
    extractField(source, error.messageFields ?? fallbackFields) ??
    `CLI reported an error (${error.field} set) with no extractable message`
  );
}

/**
 * Complete lines out of a buffer, and whatever is left over.
 *
 * The remainder is the point: a real pipe splits wherever it flushes, so the
 * tail of a chunk is routinely half a JSON line that only completes on the
 * next read.
 */
function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
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
   * it then clears only its own.
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
    return this.#scrubbed(this.#runStream(prompt, files, workingDir, opts));
  }

  /**
   * Remove this route's own api key from everything the child process said.
   *
   * A CLI harness is handed its credential in an environment variable, and a
   * harness reporting an auth failure can quote it back (`auth error: rejected
   * key <key>` on stderr), reaching the terminal AND `logs/dispatches.jsonl`.
   *
   * Wrapped around the whole stream rather than applied at each result site:
   * `#runStream` has five result sites plus the chunk events, and a sixth added
   * later would silently miss a per-site scrub. Chunks are scrubbed too — they
   * become `partialOutput` and `stdout.log` on disk, the same disclosure a beat
   * earlier. Costs nothing when the route has no key, which is every
   * subscription CLI.
   */
  async *#scrubbed(inner: AsyncIterable<DispatcherEvent>): AsyncIterable<DispatcherEvent> {
    if (this.apiKey === undefined || this.apiKey === "") {
      yield* inner;
      return;
    }
    const clean = (text: string): string => redactSecretValue(text, this.apiKey);
    for await (const evt of inner) {
      if (evt.type === "stdout" || evt.type === "stderr") {
        yield { ...evt, chunk: clean(evt.chunk) };
        continue;
      }
      if (evt.type === "completion") {
        const result = { ...evt.result, output: clean(evt.result.output) };
        if (result.error !== undefined) result.error = clean(result.error);
        yield { ...evt, result };
        continue;
      }
      yield evt;
    }
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
    // because streamSubprocess merges over process.env.
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

    // A prompt too long for this route's COMMAND LINE, caught before spawning:
    // past the OS limit the spawn fails with a raw `spawn ENAMETOOLONG`,
    // pointing at nothing the caller could act on.
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
    let truncated = false;

    const eventDriven = protocol.output.mode === "jsonl_stream" && protocol.output.eventRules;
    const acc = eventDriven ? new JsonlAccumulator(protocol.output.eventRules!) : undefined;
    let lineBuffer = "";

    for await (const evt of streamSubprocess(resolved.command, args, subOpts)) {
      // One `continue` per event kind, rather than nested ifs, so the part
      // that has to be exactly right — holding a partial line across reads —
      // sits at the top level of the loop.
      if (!("stream" in evt)) {
        exitCode = evt.exitCode;
        durationMs = evt.durationMs;
        timedOut = evt.timedOut;
        truncated = evt.truncated;
        continue;
      }

      if (evt.stream === "stderr") {
        stderrBuf.push(evt.chunk);
        yield { type: "stderr", chunk: evt.chunk };
        continue;
      }

      stdoutBuf.push(evt.chunk);
      yield { type: "stdout", chunk: evt.chunk };
      if (!acc) continue;

      lineBuffer += evt.chunk;
      const split = takeCompleteLines(lineBuffer);
      lineBuffer = split.rest;
      for (const line of split.lines) {
        for (const out of acc.process(line)) yield out;
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

    // The output cap stopped this run. stream-subprocess kills the child and
    // flags it; without reading the flag the caller gets a bare `Exit code N`
    // with no hint the run was killed for volume — or, if the child exited
    // before the kill landed, a success whose answer was quietly cut off.
    // What arrived before the cap is kept.
    if (truncated) {
      const capMb = Math.round(DEFAULT_MAX_OUTPUT_BYTES / (1024 * 1024));
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: this.id,
          success: false,
          error:
            `Stopped: the harness wrote more than the ${capMb} MB output limit, so the run ` +
            `was killed and everything after the limit was discarded. The output up to the ` +
            `limit is kept here.`,
          durationMs,
        },
      };
      return;
    }

    let parsedOutput: string | undefined;
    let tokensUsed: { input: number; output: number } | undefined;
    /**
     * A structured error message from a parsed CLI response (event
     * `emit: "error"` rule, or `output.error`'s boolean field) — takes priority
     * over exit code and the raw-text heuristics below, because a CLI can
     * report failure while exiting 0 (Claude Code's is_error flag) or bury the
     * real message behind an unrelated exit-1 stderr banner (Codex puts its
     * error in JSON on stdout, with stderr carrying only "Reading additional
     * input from stdin...").
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
          tokensUsed = readUsage(usageSource, protocol.output.usage) ?? tokensUsed;
          structuredError =
            readStructuredError(usageSource, protocol.output.error, fields) ?? structuredError;
          break;
        }
        case "jsonl_stream": {
          parsedOutput = concatJsonlFields(stdout, fields);
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

    // Text-mode CLIs put real error text on stderr with stdout empty;
    // JSON-oriented modes put their payload — errors included — on stdout, with
    // stderr often just banner noise. structuredError outranks both.
    const rawErrorFallback =
      protocol.output.mode === "text"
        ? stderr.trim() || stdout.trim()
        : stdout.trim() || stderr.trim();
    // Event-driven modes only: there, rawErrorFallback IS the raw JSONL event
    // stream, so a CLI that emits valid events and then exits non-zero would
    // report ~300 chars of {"type":"thread.started",...} as its error while the
    // parsed agent_message sat unused. Gated on eventDriven because in text
    // mode parsedOutput IS stdout, and preferring it would defeat the
    // stderr-first rule above.
    const parsedErrorDetail = eventDriven ? parsedOutput : undefined;
    // And when NOTHING parsed either, say what happened instead of dumping the
    // stream: with no agent_message emitted, rawErrorFallback wins and the
    // caller's only explanation is 300 characters of JSONL truncated
    // mid-sentence.
    //
    // Deliberately NOT a new event rule for Codex's nested
    // {"item":{"type":"error"}} frame, which looks like the fix and is wrong:
    // structuredError overrides the exit code, so the benign notice that frame
    // carries ("Skill descriptions were shortened...") would mark HEALTHY runs
    // failed and move the breaker. This path only runs on a run that already
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
    // Scan BOTH streams, not just whichever one errorDetail resolved to: a 429
    // on the stream that lost the errorDetail race would otherwise go
    // undetected — for jsonl_stream, a rate limit on stderr while stdout
    // carries the event payload. The message shown to the caller stays
    // errorDetail; only the DETECTION widens.
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
