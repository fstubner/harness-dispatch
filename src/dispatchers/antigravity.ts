/**
 * Antigravity CLI dispatcher for harness-router.
 *
 * Dispatch: agy [--model <override>] [safety] [--add-dir <dir>] --print <prompt>
 *
 * Antigravity is Google's successor to Gemini CLI. It keeps model and
 * permission settings in its own profile, so it deliberately does not reuse
 * Gemini's temporary ~/.gemini/settings.json thinking-level override.
 */

import path from "node:path";
import which from "which";

import type {
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

function antigravitySafetyArgs(profile: SafetyProfile): string[] {
  switch (profile) {
    case "read_only":
      // plan mode is read-only by contract; --sandbox additionally restricts
      // the terminal in case the model attempts tool use anyway.
      return ["--mode", "plan", "--sandbox"];
    case "workspace_edit":
      // Auto-accept file edits so non-TTY print runs never hang on the
      // default request-review approval prompt.
      return ["--mode", "accept-edits"];
    case "full_auto":
      return ["--dangerously-skip-permissions"];
  }
}

function buildPrompt(prompt: string, files: string[]): string {
  if (files.length === 0) return prompt;
  const fileList = files.map((file) => "  " + file).join("\n");
  return prompt + "\n\nFiles to work with:\n" + fileList;
}

function includedDirectories(files: string[], workingDir: string): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    if (!path.isAbsolute(file)) continue;
    const dir = path.dirname(file);
    if (dir !== workingDir) dirs.add(dir);
  }
  return [...dirs];
}

function detectRateLimit(text: string): {
  rateLimited: boolean;
  retryAfter: number | null;
} {
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
    retryAfter:
      retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}

export class AntigravityDispatcher extends BaseDispatcher {
  readonly id = "antigravity_cli";
  private readonly configuredModel: string | undefined;
  private readonly command: string;

  constructor(svc?: ServiceConfig) {
    super();
    this.configuredModel = svc?.model;
    this.command = svc?.command ?? "agy";
  }

  isAvailable(): boolean {
    return commandAvailable(this.command);
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "antigravity_cli", source: "unknown" };
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
    const foundPath = await which(this.command, { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "antigravity_cli",
          success: false,
          error: "Antigravity CLI (agy) not found",
        },
      };
      return;
    }

    const resolved = await resolveCliCommand(this.command);
    const args: string[] = [...resolved.prefixArgs];
    const effectiveModel = opts.modelOverride ?? this.configuredModel;
    if (effectiveModel) args.push("--model", effectiveModel);
    args.push(...antigravitySafetyArgs(opts.safetyProfile ?? "workspace_edit"));
    for (const dir of includedDirectories(files, workingDir)) {
      args.push("--add-dir", dir);
    }
    args.push("--print", buildPrompt(prompt, files));

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;

    const events: DispatcherEvent[] = [];
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    for await (const event of streamSubprocess(
      resolved.command,
      args,
      subOpts,
    )) {
      if ("stream" in event) {
        if (event.stream === "stdout") {
          stdoutBuf.push(event.chunk);
          events.push({ type: "stdout", chunk: event.chunk });
        } else {
          stderrBuf.push(event.chunk);
          events.push({ type: "stderr", chunk: event.chunk });
        }
      } else {
        exitCode = event.exitCode;
        durationMs = event.durationMs;
        timedOut = event.timedOut;
      }
    }

    for (const event of events) yield event;

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");
    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "antigravity_cli",
          success: false,
          error: "Timed out after " + timeoutMs + "ms",
          durationMs,
        },
      };
      return;
    }

    if (exitCode === 0) {
      yield {
        type: "completion",
        result: {
          output: stdout.trim() || stderr.trim(),
          service: "antigravity_cli",
          success: true,
          durationMs,
        },
      };
      return;
    }

    const combined = stdout + "\n" + stderr;
    const { rateLimited, retryAfter } = detectRateLimit(combined);
    const result: DispatchResult = {
      output: stdout.trim(),
      service: "antigravity_cli",
      success: false,
      error: stderr.trim() || stdout.trim() || "Exit code " + exitCode,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    yield { type: "completion", result };
  }
}
