/**
 * Rendering a live RouterConfig back into config.yaml.
 *
 * The dangerous half of `configure`: a mistake here writes live credentials
 * into the output (including --print, the form people paste into bug reports),
 * or drops settings on a round-trip so `configure --yes --force` destroys them.
 *
 * The governing rule: emit what the USER set, never what a default computed.
 * Billing fields are deliberately absent (they are recomputed from harness
 * defaults on every load, so writing them freezes a snapshot that silently
 * stops tracking); top-level settings are deliberately present (nothing
 * recomputes those, so a dropped one is simply gone).
 */

import { createHash } from "node:crypto";
import yaml from "js-yaml";

import type { RouterConfig, ServiceConfig } from "./types.js";

/**
 * Common fields between clis: and endpoints: entries. Billing fields
 * (provider/surface/auth_source/billing_kind/paid_usage_possible/
 * billing_confidence/billing_notes) are deliberately NOT emitted — they're
 * computed from the harness/endpoint defaults every time the config loads
 * (see buildRouteBilling), so writing them out freezes a snapshot that stops
 * tracking future default changes and looks like a deliberate user override.
 * `allow_paid_usage` is the one real opt-in flag here, so it's always
 * written; `billing_confidence` is written only where the user wrote it.
 *
 * `safety_profile`/`effective_safety` are only emitted when the service
 * actually carries an explicit value — never a fallback default. Baking in
 * `requestedSafetyProfile()`'s "workspace_edit" fallback would write it onto a
 * route whose real effective_safety (the capability floor that governs it) is
 * full_auto, making the file self-contradictory next to `status`.
 */
function commonEntryFields(svc: ServiceConfig, config: RouterConfig): Record<string, unknown> {
  const wrote = (key: string): boolean => config.userRouteKeys?.get(svc.name)?.has(key) ?? false;
  return {
    enabled: svc.enabled ? undefined : false,
    model: svc.model,
    tier: svc.tier,
    weight: svc.weight,
    cli_capability: svc.cliCapability,
    leaderboard_model: svc.leaderboardModel,
    thinking_level: svc.thinkingLevel,
    escalate_model: svc.escalateModel,
    escalate_on: svc.escalateOn.length > 0 ? svc.escalateOn : undefined,
    capabilities:
      Object.keys(svc.capabilities).length > 0 ? svc.capabilities : undefined,
    timeout_ms: svc.timeoutMs,
    max_output_tokens: svc.maxOutputTokens,
    max_input_tokens: svc.maxInputTokens,
    allow_paid_usage: svc.allowPaidUsage ? true : undefined,
    safety_profile: svc.safetyProfile,
    effective_safety: svc.effectiveSafety,
    endpoint_mode: svc.endpointMode,
    endpoint_provider: svc.endpointProvider,
    wire_protocol: svc.wireProtocol,
    workspace_policy: svc.workspacePolicy,
    models: svc.models && svc.models.length > 0 ? svc.models : undefined,
    model_hint: svc.modelHint,
    // No default exists, so the loaded value is always the user's own.
    resource_weight: svc.resourceWeight,
    // Inferred on load when absent, so written only when the user wrote it:
    // `unknown` is how a route is marked untrusted, and dropping it on a
    // rewrite made that route trusted again.
    billing_confidence: wrote("billing_confidence") ? svc.billingConfidence : undefined,
  };
}

/**
 * A base_url safe to print, with the same rules the api_key gets: one carrying
 * `user:password@` or `?key=` discloses a credential just as an api_key does.
 *
 * An `${VAR}`-written base_url comes back as its reference. A literal one keeps
 * everything diagnostic — scheme, host, port, path — and loses only the
 * credential-bearing parts, so the preview still says which endpoint a route
 * points at.
 */
function baseUrlForYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): string | undefined {
  const raw = svc.baseUrl;
  if (raw === undefined || raw === "") return raw;
  // This route's OWN reference — never another route's whose variable merely
  // resolves to the same text (see RouterConfig.fieldRefs).
  const ref = config.fieldRefs?.get(svc.name)?.baseUrl;
  if (ref !== undefined) return ref;
  if (!opts.redactLiterals) return raw;
  try {
    const url = new URL(raw);
    if (url.password !== "") url.password = "REDACTED";
    if (url.username !== "") url.username = "REDACTED";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    // Unparseable: nothing can be taken apart with confidence, and echoing it
    // whole is what this function exists to stop.
    return "<unparseable base_url, redacted>";
  }
}

/**
 * Render a route's api_key WITHOUT materialising the secret.
 *
 * `svc.apiKey` is the RESOLVED value — config.ts interpolates `${VAR}` at load
 * time, so by here the reference is gone, and emitting it verbatim writes live
 * credentials into config.yaml and echoes them on `configure --print`. It also
 * breaks the project's own invariant (plugin/commands/setup.md: "API keys MUST
 * be written as ${ENV_VAR} references — never literal").
 *
 * `config.fieldRefs` holds each route's own raw `api_key` text, read before
 * interpolation, so a key from `${GROQ_API_KEY}` round-trips exactly and a
 * literal never picks up another route's reference. `config.apiKeyRefs` covers
 * the whole-`${VAR}` case, including a variable that is unset here.
 *
 * A key written as a LITERAL has no reference to restore, and that case splits
 * by destination: `--yes` writes to disk, where the literal already lives and
 * dropping it would break a working config; `--print` goes to a terminal and a
 * bug report, so it is redacted to the placeholder below.
 */
function apiKeyForYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: { redactLiterals: boolean },
): string | undefined {
  // An UNSET ${VAR} resolves to "", so an empty apiKey is ambiguous: either
  // the route never had a key, or it had a reference whose variable was not
  // exported in this shell. config.apiKeyRefs, read before interpolation,
  // tells the two apart — without it, `configure --yes --force` on such a
  // shell silently rewrites a working config with the key deleted.
  if (svc.apiKey === undefined || svc.apiKey === "") return config.apiKeyRefs?.get(svc.name);
  const ref = config.fieldRefs?.get(svc.name)?.apiKey ?? config.apiKeyRefs?.get(svc.name);
  if (ref !== undefined) return ref;
  if (!opts.redactLiterals) return svc.apiKey;
  // protocol.apiKeyEnvVar is the var the CHILD CLI reads, which is only a
  // suggestion for what to name the config reference — they need not match,
  // and endpoint routes have no protocol at all. Hence the generic fallback.
  const envVar = svc.protocol?.apiKeyEnvVar ?? "YOUR_API_KEY_ENV_VAR";
  return `\${${envVar}}`;
}

export interface YamlOpts {
  redactLiterals: boolean;
}

function cliEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  // `harness: generic` has NO shipped preset behind it, so anything omitted
  // here is not recoverable on reload — it is gone. Dropping `protocol:` is
  // fatal: config.ts refuses a generic entry without one, so a round-trip would
  // delete every user-added harness (the documented README#adding-a-harness
  // path) and `configure --yes --force` would write that over their file.
  //
  // Built-in harnesses keep the lean output: their preset supplies protocol and
  // billing, and emitting a copy would freeze a snapshot — the same reasoning
  // commonEntryFields gives for omitting billing fields generally.
  const isGeneric = svc.harness === "generic";
  return {
    name: svc.name,
    harness: svc.harness,
    command: svc.command,
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc, config),
    ...(isGeneric
      ? {
          provider: svc.provider,
          surface: svc.surface,
          auth_source: svc.authSource,
          billing_kind: svc.billingKind,
          paid_usage_possible: svc.paidUsagePossible,
          billing_notes: svc.billingNotes,
          protocol: svc.protocol,
        }
      : {}),
  };
}

function endpointEntryToYaml(
  svc: ServiceConfig,
  config: RouterConfig,
  opts: YamlOpts,
): Record<string, unknown> {
  return {
    name: svc.name,
    base_url: baseUrlForYaml(svc, config, opts),
    api_key: apiKeyForYaml(svc, config, opts),
    ...commonEntryFields(svc, config),
    // Endpoints have no shipped preset behind them, so an omitted billing
    // field is not recomputed on reload — it is lost. An endpoint declaring
    // `billing_kind: local_compute` and `paid_usage_possible: false` would come
    // back undefined, flipping it to paid=possible and getting it skipped by
    // billing policy. Same reasoning as `harness: generic` CLI routes; built-in
    // harnesses keep the lean output because their preset supplies these.
    provider: svc.provider,
    surface: svc.surface,
    auth_source: svc.authSource,
    billing_kind: svc.billingKind,
    paid_usage_possible: svc.paidUsagePossible,
    billing_notes: svc.billingNotes,
  };
}

/**
 * Top-level settings a user set and that have no defaults to track.
 *
 * Unlike the billing fields (see commonEntryFields — omitted deliberately so
 * they keep following harness defaults), nothing recomputes these: a dropped
 * `max_concurrent_runs` is simply gone, and `configure --yes --force` writes
 * the result over the user's file.
 */
function topLevelToYaml(config: RouterConfig, definesRoutes: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // FIRST, and unconditionally when the file stated it.
  //
  // `detect` is the only setting that isolates a machine from its installed
  // paid CLIs. Dropping it turns `detect: false` into a config that routes to
  // every real subscription on the machine, and the safety warning does not
  // fire because the emptied document fails its own trigger condition.
  if (config.detect !== undefined) out.detect = config.detect;
  // `disabled:` only means something to AUTO-DETECTION. A config that lists its
  // own routes is authoritative and detection is off, so there a disabled route
  // is simply absent and carrying the name forward breaks the file (`doctor`
  // warns that it had no effect and exits 1). But `detect: true` turns
  // detection back on beside the listed routes, and dropping `disabled:` there
  // brought the excluded harness back — a paid CLI the user had switched off,
  // routable again after `configure --yes --force`. Kept whenever detection
  // runs, which is the same rule the loader applies.
  const detectionRuns = config.detect ?? !definesRoutes;
  if (detectionRuns && config.disabled && config.disabled.length > 0) {
    out.disabled = [...config.disabled];
  }
  if (config.maxConcurrentRuns !== undefined) out.max_concurrent_runs = config.maxConcurrentRuns;
  if (config.retention?.jobsDays !== undefined) {
    out.retention = { jobs_days: config.retention.jobsDays };
  }
  if (config.telemetry?.enabled !== undefined) {
    out.telemetry = { enabled: config.telemetry.enabled };
  }
  if (config.leaderboard?.enabled !== undefined) {
    out.leaderboard = { enabled: config.leaderboard.enabled };
  }
  return out;
}

export function configToYaml(config: RouterConfig, opts: YamlOpts): string {
  const clis: Record<string, unknown>[] = [];
  const endpoints: Record<string, unknown>[] = [];
  for (const svc of Object.values(config.services)) {
    if (svc.type === "cli") clis.push(cliEntryToYaml(svc, config, opts));
    else endpoints.push(endpointEntryToYaml(svc, config, opts));
  }
  const definesRoutes = clis.length > 0 || endpoints.length > 0;
  const doc: Record<string, unknown> = { ...topLevelToYaml(config, definesRoutes) };
  if (clis.length > 0) doc.clis = clis;
  if (endpoints.length > 0) doc.endpoints = endpoints;
  const body = yaml.dump(doc, { noRefs: true, lineWidth: 100 });
  // `{}` is what js-yaml emits for an empty document, and it is what a machine
  // with no harness CLI installed produces — the ordinary first-run case on
  // Linux. Valid YAML, and useless: it says nothing about why it is empty or
  // what to put in it, so the replacement says what `doctor` would, in the
  // place someone who opens the file is looking.
  return body.trim() === "{}" ? EMPTY_CONFIG_BODY : body;
}

/**
 * The body written in place of `{}`. Comments only, so it parses to the same
 * empty document and `detect`/`disabled` are unaffected — nothing here changes
 * what the router does, it just stops the file being a dead end.
 */
const EMPTY_CONFIG_BODY = `# This config defines no routes. On a fresh machine that means no harness CLI
# was found on PATH (claude, codex, cursor-agent, agy). Two ways forward:
#
#   1. Install a harness CLI and re-run \`harness-dispatch configure\` — an
#      unedited file like this one is regenerated from a fresh detection.
#   2. Add an HTTP endpoint below. Endpoints need no CLI. They are read_only
#      (no agent loop, no file access), so they serve plan and review work,
#      never execute.
#
# endpoints:
#   - name: ollama
#     base_url: http://localhost:11434/v1
#     model: llama3.2
#     billing_kind: local_compute
#     tier: 3
#
# \`harness-dispatch doctor\` says which of the two applies here. The shipped
# config.default.yaml in the installed package carries a worked example of
# every field.
`;

/**
 * `configure` stamps what it writes so a later run can tell its own unedited
 * output from a file someone has worked on.
 *
 * The refusal to overwrite ("already exists ... --force") exists because
 * overwriting a hand-written config is unrecoverable, and that reason does not
 * apply to a file configure itself wrote and nobody has touched — the natural
 * first-run order, where configure runs once with no harness installed and
 * again after installing one. The fingerprint is a sha256 of everything after
 * the header; the header lines are comments, so the file loads unchanged.
 *
 * Only a leading block of `#` lines may sit above the fingerprint line. An
 * edit inserted ABOVE it — `detect: false` at the top of the file, say — is
 * still an edit, and a check that skipped to the fingerprint would miss it.
 */
const FINGERPRINT_LINE = /^# harness-dispatch configure: fingerprint=([0-9a-f]{64})$/m;

const HEADER = [
  "# Written by `harness-dispatch configure`. Re-running configure regenerates this",
  "# file from a fresh detection for as long as it is unedited; change anything in it",
  "# and it will refuse to overwrite without --force. The fingerprint is how it tells.",
].join("\n");

function fingerprint(body: string): string {
  // Line endings and trailing whitespace are not an edit: an editor that
  // saves CRLF, or strips the final newline, changed nothing the loader can
  // see.
  return createHash("sha256")
    .update(body.replace(/\r\n/g, "\n").replace(/\s+$/, ""))
    .digest("hex");
}

export function stampGenerated(body: string): string {
  return [HEADER, `# harness-dispatch configure: fingerprint=${fingerprint(body)}`, body].join("\n");
}

export function isUneditedGenerated(text: string): boolean {
  const normalised = text.replace(/\r\n/g, "\n");
  const match = FINGERPRINT_LINE.exec(normalised);
  if (match === null || match.index === undefined) return false;
  // Exactly our header, nothing else: accepting ANY comment lines above the
  // fingerprint would regenerate away a `# note to self` a user put at the top.
  if (normalised.slice(0, match.index) !== `${HEADER}\n`) return false;
  const body = normalised.slice(match.index + match[0].length + 1);
  return fingerprint(body) === match[1];
}
