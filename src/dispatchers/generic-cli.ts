/**
 * Config-driven CLI dispatcher for harness-router.
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

function buildArgs(
  protocol: CliProtocolConfig,
  prefixArgs: string[],
  prompt: string,
  files: string[],
  workingDir: string,
  effectiveModel: string | undefined,
  opts: DispatchOpts,
): string[] {
  const args: string[] = [...prefixArgs];

  if (protocol.leadingArgs) args.push(...protocol.leadingArgs);
  if (protocol.promptInput.mode === "flag" && (protocol.promptInput.position ?? "early") === "early") {
    args.push(protocol.promptInput.flag, prompt);
  }
  if (protocol.workingDir && workingDir) {
    args.push(protocol.workingDir.flag, workingDir);
    if (protocol.workingDir.extraArgsWhenSet) args.push(...protocol.workingDir.extraArgsWhenSet);
  }
  if (protocol.fileDirsFlag) {
    for (const dir of includedDirectories(files, workingDir)) {
      args.push(protocol.fileDirsFlag, dir);
    }
  }
  if (protocol.extraArgs) args.push(...protocol.extraArgs);
  const safetyProfile: SafetyProfile = opts.safetyProfile ?? "workspace_edit";
  const safetyArgs = protocol.safetyArgs?.[safetyProfile];
  if (safetyArgs) args.push(...safetyArgs);
  if (protocol.modelFlag && effectiveModel) {
    args.push(protocol.modelFlag, effectiveModel);
  }
  if (protocol.promptInput.mode === "flag" && protocol.promptInput.position === "late") {
    args.push(protocol.promptInput.flag, prompt);
  }
  if (protocol.promptInput.mode === "positional") {
    args.push(prompt);
  }
  if (protocol.promptInput.mode === "stdin" && protocol.promptInput.sentinelArg) {
    args.push(protocol.promptInput.sentinelArg);
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

  constructor(svc?: ServiceConfig) {
    super();
    this.id = svc?.name ?? "generic";
    this.command = svc?.command ?? "";
    this.protocol = svc?.protocol;
    this.apiKey = svc?.apiKey;
    this.configuredModel = svc?.model;
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

    const fullPrompt = buildFullPrompt(protocol, prompt, files);
    const effectiveModel = opts.modelOverride ?? this.configuredModel;

    const resolved = await resolveCliCommand(this.command);
    const args = buildArgs(protocol, resolved.prefixArgs, fullPrompt, files, workingDir, effectiveModel, opts);

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
    if (workingDir) subOpts.cwd = workingDir;
    if (protocol.promptInput.mode === "stdin") subOpts.stdin = fullPrompt;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    const eventDriven = protocol.outputMode === "jsonl_stream" && protocol.eventRules;
    const acc = eventDriven ? new JsonlAccumulator(protocol.eventRules!) : undefined;
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

    if (eventDriven && acc) {
      // Windows cmd /c can shuffle streams — if nothing parsed from stdout, retry stderr.
      if (!acc.sawAnyJson && stderr) {
        for (const line of stderr.split(/\r?\n/)) acc.process(line);
      }
      parsedOutput = acc.sawAnyJson ? acc.lastText.trim() || undefined : undefined;
      if (acc.sawUsage) tokensUsed = { input: acc.inputTokens, output: acc.outputTokens };
    } else {
      const fields = protocol.outputFields ?? ["result", "output", "text", "response"];
      switch (protocol.outputMode) {
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
          if (usageSource !== undefined && protocol.usageFields) {
            const inTok = firstNumberAt(usageSource, protocol.usageFields.inputFields);
            const outTok = firstNumberAt(usageSource, protocol.usageFields.outputFields);
            if (inTok || outTok) tokensUsed = { input: inTok, output: outTok };
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

    const combined = `${stdout}\n${stderr}`;
    const { rateLimited, retryAfter } = detectRateLimit(combined);
    const errorDetail = stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;
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
