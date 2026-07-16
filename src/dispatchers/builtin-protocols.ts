/**
 * CliProtocolConfig definitions for the 4 built-in harnesses — Claude Code,
 * Codex, Cursor, Antigravity — expressed as data through the same
 * GenericCliDispatcher every user-added `harness: generic` route uses.
 *
 * These are transcribed field-for-field from what were previously 4
 * independent hand-written dispatcher classes, verified against their exact
 * argv construction and output parsing. Two narrow, deliberate simplifications
 * from that transcription (neither observable in any existing test):
 *  - Claude Code's original stdout-JSON parser never fell back to stderr;
 *    this shares the same stdout-then-stderr fallback the other 3 always
 *    used. Harmless — Claude's CLI puts its JSON result on stdout.
 *  - Token-usage extraction here accepts either input or output tokens
 *    present (not strictly both), where Claude's original required both.
 * Everything else — flags, safety-profile mappings, output parsing, API-key
 * env injection, event semantics — is unchanged.
 */

import type { CliEventRule, CliProtocolConfig } from "../types.js";

export const CLAUDE_CODE_PROTOCOL: CliProtocolConfig = {
  promptInput: { mode: "flag", flag: "-p" },
  fileListHeader: "Files to work with:",
  fileListBullet: "  ",
  modelFlag: "--model",
  extraArgs: ["--output-format", "json"],
  safetyArgs: {
    read_only: ["--allowedTools", "Read", "--permission-mode", "plan"],
    workspace_edit: ["--allowedTools", "Read,Edit,Write", "--permission-mode", "acceptEdits"],
    full_auto: ["--allowedTools", "Bash,Read,Edit,Write", "--permission-mode", "acceptEdits"],
  },
  outputMode: "json_field",
  outputFields: ["result", "response", "text"],
  usageFields: { inputFields: ["usage.input_tokens"], outputFields: ["usage.output_tokens"] },
  successRequiresOutput: false,
};

const CODEX_EVENT_RULES: CliEventRule[] = [
  { when: { type: "item.completed", "item.type": "agent_message" }, emit: "text", textField: "item.text" },
  { when: { type: "message" }, emit: "text", textField: "message.content" },
  { when: { "item.type": "tool_use" }, emit: "tool_use", nameField: "item.name", inputField: "item.input" },
  { when: { type: "thinking" }, emit: "thinking", chunkField: "item.text" },
  {
    when: {}, // unconditional — matches the original's plain `if (event.usage) {...}`
    emit: "usage",
    inputTokenFields: ["usage.input_tokens", "usage.prompt_tokens"],
    outputTokenFields: ["usage.output_tokens", "usage.completion_tokens"],
  },
];

export const CODEX_PROTOCOL: CliProtocolConfig = {
  promptInput: { mode: "stdin", sentinelArg: "-" },
  leadingArgs: ["exec"],
  workingDir: { flag: "--cd", extraArgsWhenSet: ["--skip-git-repo-check"] },
  fileListHeader: "Files to work with:",
  fileListBullet: "  ",
  modelFlag: "--model",
  extraArgs: ["--json"],
  safetyArgs: {
    read_only: ["--sandbox", "read-only"],
    workspace_edit: ["--sandbox", "workspace-write"],
    full_auto: ["--full-auto"],
  },
  apiKeyEnvVar: "OPENAI_API_KEY",
  outputMode: "jsonl_stream",
  eventRules: CODEX_EVENT_RULES,
  successRequiresOutput: false,
};

export const CURSOR_PROTOCOL: CliProtocolConfig = {
  promptInput: { mode: "positional" },
  workingDir: { flag: "--workspace" },
  fileListHeader: "Focus on these files:",
  fileListBullet: "  - ",
  modelFlag: "--model",
  extraArgs: ["-p", "--trust", "--output-format", "json"],
  apiKeyEnvVar: "CURSOR_API_KEY",
  outputMode: "json_field",
  outputFields: ["result", "output", "text"],
  usageFields: { inputFields: ["usage.input_tokens", "usage.prompt_tokens"], outputFields: ["usage.output_tokens", "usage.completion_tokens"] },
  // successRequiresOutput omitted -> defaults to true (strict): matches
  // Cursor's original `if (exitCode === 0 && parsedText)` requirement.
};

export const ANTIGRAVITY_PROTOCOL: CliProtocolConfig = {
  promptInput: { mode: "flag", flag: "--print", position: "late" },
  fileDirsFlag: "--add-dir",
  fileListHeader: "Files to work with:",
  fileListBullet: "  ",
  modelFlag: "--model",
  safetyArgs: {
    read_only: ["--mode", "plan", "--sandbox"],
    workspace_edit: ["--mode", "accept-edits"],
    full_auto: ["--dangerously-skip-permissions"],
  },
  outputMode: "text",
  successRequiresOutput: false,
};
