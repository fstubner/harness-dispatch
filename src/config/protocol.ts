/**
 * Parsing for a route's `protocol:` block — how a CLI harness is actually
 * invoked and how its output is read.
 *
 * Split out of config.ts. This is the largest single concern in that file and
 * the most self-contained: it turns YAML into a CliProtocolConfig and knows
 * nothing about routes, billing, or defaults merging.
 *
 * It is also the reason `harness: generic` works at all — every CLI harness,
 * built-in or user-added, is driven by this structure rather than by
 * TypeScript. That is why a malformed protocol block skips the whole entry
 * with a warning instead of landing a route that would fail at dispatch time.
 */

import type {
  CliEventRule,
  CliProtocolConfig,
  EndpointProvider,
  SafetyProfile,
} from "../types.js";
import { bool, num, str } from "./coercions.js";

const SAFETY_PROFILES: readonly SafetyProfile[] = ["read_only", "workspace_edit", "full_auto"];

/**
 * Named protocols a route may reference by string or `extends:`.
 *
 * INJECTED rather than imported. config.ts builds presets by calling
 * this very function (via the shipped-harness loader), so importing it here
 * would be an initialisation cycle — protocol.ts would need a value that does
 * not exist until protocol.ts has finished running. Passing it in keeps the
 * dependency pointing one way.
 */
export type ProtocolPresets = Readonly<Record<string, CliProtocolConfig>>;

/** The full set of `{{name}}` tokens expandToken() in generic-cli.ts understands. */
export const KNOWN_ARG_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "{{prompt}}",
  "{{model}}",
  "{{safety}}",
  "{{working_dir}}",
  "{{file_dirs}}",
  "{{native_args}}",
]);

export function stringArrayFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Parse `protocol:` for any route (see CliProtocolConfig in types.ts).
 * Three shapes:
 *  - A string ("cursor", "codex", ...) — looked up in presets by
 *    name. Lets a config select a known protocol without retyping it, and
 *    is the extension point for "others add further protocols" — a new
 *    named entry in the shipped config.default.yaml is immediately selectable here,
 *    no code changes.
 *  - An object with `extends: <preset name>` — starts from that preset and
 *    overrides only the fields present, for the common "95% the same, one
 *    flag different" case. safety merges per-profile (overriding just
 *    full_auto doesn't erase read_only/workspace_edit from the preset).
 *  - A plain object — the full protocol, no preset involved (unchanged
 *    behavior from before presets existed).
 *
 * Returns undefined — with a warning — for anything malformed, so a broken
 * block degrades to "route unusable" (isAvailable() checks for a missing
 * protocol) rather than a half-built dispatcher silently doing the wrong
 * thing.
 */
export function protocolFrom(
  raw: unknown,
  routeLabel: string,
  warnings: string[],
  // REQUIRED, deliberately not defaulted to {}. A default made a forgotten
  // argument resolve every preset name to nothing — silently, at runtime,
  // which is the exact failure mode this file's own history is made of. As a
  // required parameter the compiler catches it instead.
  presets: ProtocolPresets,
): CliProtocolConfig | undefined {
  if (typeof raw === "string") {
    const preset = presets[raw];
    if (!preset) {
      warnings.push(
        `${routeLabel}: protocol "${raw}" is not a known preset (expected one of: ` +
          `${Object.keys(presets).join(", ")}) — entry ignored.`,
      );
      return undefined;
    }
    return preset;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  let base: CliProtocolConfig | undefined;
  if (typeof r.extends === "string") {
    base = presets[r.extends];
    if (!base) {
      warnings.push(
        `${routeLabel}: protocol.extends "${r.extends}" is not a known preset (expected one of: ` +
          `${Object.keys(presets).join(", ")}) — entry ignored.`,
      );
      return undefined;
    }
  }
  return parseProtocolFields(r, routeLabel, warnings, base);
}

export function parseProtocolFields(
  r: Record<string, unknown>,
  routeLabel: string,
  warnings: string[],
  base: CliProtocolConfig | undefined,
): CliProtocolConfig | undefined {
  const args = stringArrayFrom(r.args) ?? base?.args;
  if (args === undefined) {
    warnings.push(`${routeLabel}: protocol.args is required — entry ignored.`);
    return undefined;
  }

  const outputRaw = r.output;
  let output: CliProtocolConfig["output"] | undefined = base?.output;
  if (outputRaw !== undefined) {
    if (outputRaw === null || typeof outputRaw !== "object") {
      warnings.push(`${routeLabel}: protocol.output must be an object — entry ignored.`);
      return undefined;
    }
    const o = outputRaw as Record<string, unknown>;
    if (o.mode !== "text" && o.mode !== "json_field" && o.mode !== "jsonl_stream") {
      warnings.push(
        `${routeLabel}: protocol.output.mode must be one of text | json_field | jsonl_stream — entry ignored.`,
      );
      return undefined;
    }
    output = { mode: o.mode };
    const fields = stringArrayFrom(o.fields);
    if (fields !== undefined) output.fields = fields;
    const usageRaw = o.usage;
    if (usageRaw !== null && typeof usageRaw === "object") {
      const u = usageRaw as Record<string, unknown>;
      const input = stringArrayFrom(u.input);
      const outputTokens = stringArrayFrom(u.output);
      if (input !== undefined && outputTokens !== undefined) output.usage = { input, output: outputTokens };
    }
    const eventRulesRaw = o.event_rules;
    if (Array.isArray(eventRulesRaw)) {
      const eventRules: CliEventRule[] = [];
      for (const [i, ruleRaw] of eventRulesRaw.entries()) {
        const rule = eventRuleFrom(ruleRaw, `${routeLabel}: protocol.output.event_rules[${i}]`, warnings);
        if (rule) eventRules.push(rule);
      }
      if (eventRules.length > 0) output.eventRules = eventRules;
    }
    const errorRaw = o.error;
    if (errorRaw !== null && typeof errorRaw === "object") {
      const e = errorRaw as Record<string, unknown>;
      const field = str(e.field);
      if (field !== undefined) {
        const messageFields = stringArrayFrom(e.message_fields);
        output.error = messageFields !== undefined ? { field, messageFields } : { field };
      } else {
        warnings.push(`${routeLabel}: protocol.output.error.field is required — error detection ignored.`);
      }
    }
  }
  if (output === undefined) {
    warnings.push(`${routeLabel}: protocol.output is required — entry ignored.`);
    return undefined;
  }

  const protocol: CliProtocolConfig = { args, output };

  const stdin = typeof r.stdin === "boolean" ? r.stdin : base?.stdin;
  if (stdin !== undefined) protocol.stdin = stdin;

  const modelRaw = r.model;
  if (modelRaw !== undefined && modelRaw !== null) {
    const m = modelRaw as Record<string, unknown>;
    if (typeof m.flag === "string" && m.flag) {
      protocol.model = { flag: m.flag };
    } else {
      warnings.push(`${routeLabel}: protocol.model set but missing a "flag" string — ignored.`);
    }
  } else if (base?.model) {
    protocol.model = base.model;
  }

  const workingDirRaw = r.working_dir;
  if (workingDirRaw !== undefined && workingDirRaw !== null) {
    const wd = workingDirRaw as Record<string, unknown>;
    if (typeof wd.flag === "string" && wd.flag) {
      protocol.workingDir = { flag: wd.flag };
      const extraArgsWhenSet = stringArrayFrom(wd.extra_args_when_set);
      if (extraArgsWhenSet !== undefined) protocol.workingDir.extraArgsWhenSet = extraArgsWhenSet;
      if (wd.fallback === "home") protocol.workingDir.fallback = "home";
    } else {
      warnings.push(`${routeLabel}: protocol.working_dir set but missing a "flag" string — ignored.`);
    }
  } else if (base?.workingDir) {
    protocol.workingDir = base.workingDir;
  }

  const fileDirsRaw = r.file_dirs;
  if (fileDirsRaw !== undefined && fileDirsRaw !== null) {
    const fd = fileDirsRaw as Record<string, unknown>;
    if (typeof fd.flag === "string" && fd.flag) {
      protocol.fileDirs = { flag: fd.flag };
    } else {
      warnings.push(`${routeLabel}: protocol.file_dirs set but missing a "flag" string — ignored.`);
    }
  } else if (base?.fileDirs) {
    protocol.fileDirs = base.fileDirs;
  }

  const fileListHeader = str(r.file_list_header) ?? base?.fileListHeader;
  if (fileListHeader !== undefined) protocol.fileListHeader = fileListHeader;
  const fileListBullet =
    (typeof r.file_list_bullet === "string" ? r.file_list_bullet : undefined) ?? base?.fileListBullet;
  if (fileListBullet !== undefined) protocol.fileListBullet = fileListBullet;
  const apiKeyEnvVar = str(r.api_key_env_var) ?? base?.apiKeyEnvVar;
  if (apiKeyEnvVar !== undefined) protocol.apiKeyEnvVar = apiKeyEnvVar;

  const safetyRaw = r.safety;
  const safety: Partial<Record<SafetyProfile, string[]>> = { ...base?.safety };
  if (safetyRaw !== null && typeof safetyRaw === "object") {
    for (const profile of SAFETY_PROFILES) {
      const profileArgs = stringArrayFrom((safetyRaw as Record<string, unknown>)[profile]);
      if (profileArgs !== undefined) safety[profile] = profileArgs;
    }
  }
  if (Object.keys(safety).length > 0) protocol.safety = safety;

  if (typeof r.success_requires_output === "boolean") {
    protocol.successRequiresOutput = r.success_requires_output;
  } else if (base?.successRequiresOutput !== undefined) {
    protocol.successRequiresOutput = base.successRequiresOutput;
  }

  const endpointNativeArgsRaw = r.endpoint_native_args;
  if (endpointNativeArgsRaw !== null && typeof endpointNativeArgsRaw === "object") {
    const ena: Partial<Record<EndpointProvider, string[]>> = {};
    for (const [k, v] of Object.entries(endpointNativeArgsRaw as Record<string, unknown>)) {
      const args2 = stringArrayFrom(v);
      if (args2 !== undefined) ena[k as EndpointProvider] = args2;
    }
    if (Object.keys(ena).length > 0) protocol.endpointNativeArgs = ena;
  } else if (base?.endpointNativeArgs) {
    protocol.endpointNativeArgs = base.endpointNativeArgs;
  }

  // Placeholder sanity checks on the FINAL merged args (so `extends:` results
  // are covered too). A typo'd placeholder is the most likely user error in a
  // hand-written protocol, and without these warnings it doesn't just fail
  // silently — it "succeeds": the CLI receives the literal "{{promt}}" token,
  // never receives the prompt, exits 0, and the run reports ok.
  // Matches embedded forms too ("--flag={{prompt}}"), not just whole-token
  // typos — expansion only ever substitutes a token that IS a placeholder,
  // so anything merely containing one goes through literally.
  for (const token of protocol.args) {
    if (token.includes("{{") && !KNOWN_ARG_PLACEHOLDERS.has(token)) {
      warnings.push(
        `${routeLabel}: protocol.args contains unrecognized placeholder "${token}" — it will be ` +
          `passed to the CLI as a literal argument, not substituted. Placeholders only work as ` +
          `a whole standalone argument. Known placeholders: ` +
          `${[...KNOWN_ARG_PLACEHOLDERS].join(", ")}.`,
      );
    }
  }
  if (!protocol.stdin && !protocol.args.includes("{{prompt}}")) {
    warnings.push(
      `${routeLabel}: protocol.args has no {{prompt}} placeholder and stdin is not true — ` +
        `the prompt is never sent to the CLI. Add "{{prompt}}" to args, or set stdin: true.`,
    );
  }

  return protocol;
}

export function eventRuleFrom(raw: unknown, label: string, warnings: string[]): CliEventRule | undefined {
  if (raw === null || typeof raw !== "object") {
    warnings.push(`${label}: must be an object — ignored.`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  // "when" is optional — omitted or {} means "matches every line" (e.g. a
  // usage rule that should fire regardless of event type, matching Codex's
  // original unconditional `if (event.usage) {...}` check).
  const whenRaw = r.when ?? {};
  if (whenRaw === null || typeof whenRaw !== "object" || Array.isArray(whenRaw)) {
    warnings.push(`${label}: "when" must be a {field: value} map — ignored.`);
    return undefined;
  }
  const when: Record<string, string> = {};
  for (const [k, v] of Object.entries(whenRaw as Record<string, unknown>)) {
    if (typeof v === "string") when[k] = v;
  }
  const emit = r.emit;
  if (
    emit !== "text" &&
    emit !== "tool_use" &&
    emit !== "thinking" &&
    emit !== "usage" &&
    emit !== "error"
  ) {
    warnings.push(
      `${label}: "emit" must be one of text | tool_use | thinking | usage | error — ignored.`,
    );
    return undefined;
  }
  const rule: CliEventRule = { when, emit };
  const textField = str(r.text_field);
  if (textField !== undefined) rule.textField = textField;
  const nameField = str(r.name_field);
  if (nameField !== undefined) rule.nameField = nameField;
  const inputField = str(r.input_field);
  if (inputField !== undefined) rule.inputField = inputField;
  const chunkField = str(r.chunk_field);
  if (chunkField !== undefined) rule.chunkField = chunkField;
  const inputTokenFields = stringArrayFrom(r.input_token_fields);
  if (inputTokenFields !== undefined) rule.inputTokenFields = inputTokenFields;
  const outputTokenFields = stringArrayFrom(r.output_token_fields);
  if (outputTokenFields !== undefined) rule.outputTokenFields = outputTokenFields;
  const messageField = str(r.message_field);
  if (messageField !== undefined) rule.messageField = messageField;
  return rule;
}
