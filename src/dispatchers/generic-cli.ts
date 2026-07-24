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

function detectRateLimit(text: string): { rateLimited: boolean; retryAfter: number | null } {
  const lowered = text.toLowerCase();
  const flagged =
    lowered.includes("rate limit") ||
    lowered.includes("quota exceeded") ||
    lowered.includes("resource_exhausted") ||
    lowered.includes("too many requests") ||
    // "usage limit" is OpenAI Codex's real phrasing (confirmed live,
    // 2026-07-24: "You've hit your usage limit... try again at Jul 28th,
    // 2026 10:16 PM.") — none of the phrases above matched it, so a real
    // Codex exhaustion was silently NOT flagged as rate-limited.
    lowered.includes("usage limit") ||
    text.includes("429");
  if (!flagged) return { rateLimited: false, retryAfter: null };
  const match = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = match?.[1] ? Number.parseFloat(match[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
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

function parseJsonField(stdout: string, fields: string[]): string | undefined {
  const parsed = parseJsonBlob(stdout);
  return parsed !== undefined ? extractField(parsed, fields) : undefined;
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

export class GenericCliDispatcher extends BaseDispatcher {
  readonly id: string;
  private readonly command: string;
  private readonly protocol: CliProtocolConfig | undefined;
  private readonly apiKey: string | undefined;
  private readonly configuredModel: string | undefined;
  private readonly endpointMode: ServiceConfig["endpointMode"];
  private readonly endpointProvider: ServiceConfig["endpointProvider"];

  constructor(svc?: ServiceConfig) {
    super();
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
    if (protocol.apiKeyEnvVar) {
      if (this.apiKey) {
        extraEnv[protocol.apiKeyEnvVar] = this.apiKey;
      } else if (process.env[protocol.apiKeyEnvVar]) {
        extraEnv[protocol.apiKeyEnvVar] = "";
      }
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (effectiveWorkingDir) subOpts.cwd = effectiveWorkingDir;
    if (protocol.stdin) subOpts.stdin = fullPrompt;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

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
            const inTok = firstNumberAt(usageSource, protocol.output.usage.input);
            const outTok = firstNumberAt(usageSource, protocol.output.usage.output);
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

    // A structured error overrides exit code entirely — a CLI that reports
    // failure in its own response body (is_error, a turn.failed event) is
    // reporting failure regardless of what the process exit code says.
    if (structuredError === undefined) {
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
    const errorDetail = structuredError ?? (rawErrorFallback || `Exit code ${exitCode}`);
    const { rateLimited, retryAfter } = detectRateLimit(errorDetail);
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
