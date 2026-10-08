/**
 * What a config file is ALLOWED to say, and what to warn about when it says
 * something else.
 *
 * The parser reads what it recognises and cannot distinguish a key it does not
 * know from a key that is absent, so a misspelled `workspace_policy` or
 * `safety_profile` would leave the route running under the LESS restrictive
 * default, silently.
 *
 * So the legal surface is enumerated here rather than implied by whatever the
 * builders happen to read, and kept in one file rather than copied per entry
 * shape, where the copies drift.
 */

import { warnInstructions } from "./instructions.js";
import { MODEL_TIERS } from "../types.js";

/**
 * Warn on any unrecognised value for an enum that FAILS OPEN.
 *
 * Every *From() validator returns undefined on a mismatch and the caller
 * falls back to a default — silently. For most fields that is merely
 * annoying, but for these three the default is LESS restrictive than what the
 * operator asked for:
 *
 *   safety_profile: read_onlyy  -> undefined -> DEFAULT_SAFETY_PROFILE
 *                                            -> workspace_edit (write access)
 *   workspace_policy: coppy     -> undefined -> shared_locked
 *                                            -> a SHARED workspace, not an
 *                                               isolated copy
 *
 * A typo therefore quietly grants more than intended, which is the wrong
 * direction for a safety control.
 *
 * Walks the raw tree rather than hooking each builder: the same keys appear
 * under services:, clis:, endpoints: and overrides:, and a single walk cannot
 * miss a format the way four separate call sites can.
 */
export const FAIL_OPEN_ENUMS: Record<string, readonly string[]> = {
  // Billing enums belong here for the same reason: `billing_kind: metered-api`
  // (hyphen, not underscore) resolves to the harness default of
  // `included_plan_then_flexible_credits` with paidUsagePossible false, so a
  // typo marks a metered route as free.
  billing_kind: [
    "local_compute",
    "included_plan_usage",
    "included_plan_then_flexible_credits",
    "included_credit_then_optional_overage",
    "included_usage_then_on_demand",
    "metered_api",
    "free_quota",
    "unknown",
  ],
  billing_confidence: ["documented", "inferred", "unknown", "unsupported"],
  safety_profile: ["read_only", "workspace_edit", "full_auto"],
  effective_safety: ["read_only", "workspace_edit", "full_auto"],
  workspace_policy: ["shared", "shared_locked", "git_worktree", "copy"],
};

/**
 * Every key this parser understands at the top level of config.yaml. Without
 * the list, a misspelled `max_concurrent_runs` is indistinguishable from not
 * setting it and `doctor` cannot honestly claim there are no unrecognized
 * entries.
 */
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  // Opt back into auto-detection when a config defines its own routes, or
  // opt out when it does not. See loadConfig for the three cases.
  "detect",
  "clis",
  "endpoints",
  "services",
  "disabled",
  "overrides",
  "api_keys",
  "telemetry",
  "retention",
  "max_concurrent_runs",
  // Operator instructions for connecting agents — see config/instructions.ts.
  "instructions",
]);

/**
 * Every key a `clis:` or `endpoints:` entry may carry.
 *
 * Enumerating the legal surface is what makes a misspelling reportable at all:
 * the parser reads what it recognises and cannot distinguish a key it does not
 * know from a key that is absent, and for safety and isolation controls
 * "silently absent" means "silently less restrictive".
 *
 * Kept as one list for both entry shapes on purpose — two parallel field lists
 * drift, each missing something the other has.
 */
export const KNOWN_ROUTE_KEYS = new Set([
  "name", "harness", "type", "command", "enabled", "model", "models", "model_hint", "model_tiers", "api_key_file",
  "instructions",
  "tier", "weight", "cli_capability", "capabilities", "timeout_ms", "idle_timeout_ms",
  "max_input_tokens", "max_output_tokens", "thinking_level",
  "escalate_model", "escalate_on", "resource_weight",
  "api_key", "base_url", "protocol", "filter",
  "provider", "surface", "auth_source", "billing_kind", "billing_confidence",
  "billing_notes", "paid_usage_possible", "allow_paid_usage",
  "safety_profile", "effective_safety", "workspace_policy",
  "endpoint_mode", "endpoint_provider", "wire_protocol",
]);

/**
 * Route keys that used to do something and no longer do.
 *
 * Accepted, so a config written for an earlier version keeps loading, but
 * said out loud: a key that silently stopped meaning anything is the same
 * failure as a typo. They are reported on the legacy `services:` shape too,
 * which does not run the unknown-key check.
 */
const REMOVED_ROUTE_KEY_PHRASE = "removed, has no effect";
const REMOVED_TOP_LEVEL_STATUS = "REMOVED";

/**
 * Is this config warning about a key that was removed, as opposed to one that
 * is misspelled or was never implemented? A removed key is harmless to leave
 * behind (the file still loads and nothing changed under it), so `doctor`
 * reports it as a warning. The others can leave a setting silently not in
 * effect, and keep failing it. Built from the same constants the warnings are,
 * so rewording one cannot silently turn this check off.
 */
export function isRemovedKeyWarning(warning: string): boolean {
  return (
    warning.includes(`: ${REMOVED_ROUTE_KEY_PHRASE} —`) ||
    warning.includes(`recognised but ${REMOVED_TOP_LEVEL_STATUS} —`)
  );
}

const REMOVED_ROUTE_KEYS: Record<string, string> = {
  leaderboard_model:
    `${REMOVED_ROUTE_KEY_PHRASE} — the Arena-ELO leaderboard was cut. Routing is tier, then ` +
    "weight x capability, then fallback, so `tier:` alone sets the order. Delete the line.",
};

export function warnRemovedRouteKeys(
  entry: Record<string, unknown>,
  label: string,
  warnings: string[],
): void {
  for (const [key, why] of Object.entries(REMOVED_ROUTE_KEYS)) {
    if (entry[key] !== undefined) warnings.push(`${label}: ${key}: ${why}`);
  }
}

export function warnUnknownRouteKeys(
  entry: Record<string, unknown>,
  label: string,
  warnings: string[],
): void {
  warnRemovedRouteKeys(entry, label, warnings);
  for (const key of Object.keys(entry)) {
    if (KNOWN_ROUTE_KEYS.has(key) || Object.hasOwn(REMOVED_ROUTE_KEYS, key)) continue;
    warnings.push(
      `${label}: unknown key "${key}" — IGNORED. If this was meant to be a ` +
        `safety or workspace setting, it is NOT in effect; check the spelling.`,
    );
  }
  warnMistypedRouteValues(entry, label, warnings);
}

const ESCALATE_ON_VALUES: readonly string[] = ["execute", "plan", "review", "local"];

/** Recognised keys whose value must be a number, and what they mean if lost. */
const NUMERIC_ROUTE_KEYS = new Set([
  "tier",
  "weight",
  "cli_capability",
  "max_output_tokens",
  "max_input_tokens",
  "timeout_ms",
  "idle_timeout_ms",
]);

/**
 * The smallest value each numeric route key can carry and still mean anything.
 *
 * Every one of these is positive-only, and being in range is not a style
 * preference — the router multiplies three of them together
 * (`quality * cli_capability * capability * quota * weight`) and orders by
 * `tier` ASCENDING. A negative pair therefore does not degrade a route, it
 * PROMOTES it: `tier: -5, weight: -100, cli_capability: -3` scores two orders
 * of magnitude above a normal route, from a tier that sorts ahead of every
 * real one, and wins every routing decision.
 *
 * `tier` starts at 1 because tier 1 is the frontier band and lower sorts
 * first; 0 and below are ahead of a band that already means "best". The rest
 * are exclusive of 0 (a zero weight or capability multiplies the score to
 * nothing, and a zero timeout is not a timeout).
 *
 * No upper bounds. `cli_capability: 1.1` ships in this repo's own default
 * config as deliberate tuning, so a cap would reject a documented value; what
 * is constrained here is sign, not magnitude.
 */
const NUMERIC_ROUTE_MINIMUMS: Record<string, { min: number; exclusive: boolean }> = {
  tier: { min: 1, exclusive: false },
  weight: { min: 0, exclusive: true },
  cli_capability: { min: 0, exclusive: true },
  max_output_tokens: { min: 0, exclusive: true },
  max_input_tokens: { min: 0, exclusive: true },
  timeout_ms: { min: 0, exclusive: true },
  idle_timeout_ms: { min: 0, exclusive: true },
};

/**
 * Of those, the ones the router actually multiplies into a score.
 *
 * Only these three get the "PROMOTES the route" explanation. Giving that
 * reason for `timeout_ms` or a token cap would tell the operator something
 * untrue about their own config: routing multiplies neither.
 */
const ROUTING_SCORED_KEYS = new Set(["tier", "weight", "cli_capability"]);

/** Recognised keys whose value must be a boolean. */
const BOOLEAN_ROUTE_KEYS = new Set([
  "enabled",
  "paid_usage_possible",
  "allow_paid_usage",
  "stdin",
]);

/**
 * Is this a value that reads as a USABLE number?
 *
 * `Number.isFinite` on BOTH branches, not `!Number.isNaN`: `Number("1e999")`
 * is `Infinity`, so a YAML `weight: 1e999` (which parses as a string, not a
 * number) would read as a usable number and then clear the range check too,
 * since `Infinity` is below no minimum. As written, `.inf`, `-.inf`, `.nan`
 * and `1e999` are all unusable, whichever way YAML happened to type them.
 */
function readsAsNumber(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v !== "" && Number.isFinite(Number(v));
}

/**
 * How to name the offending value back to the operator.
 *
 * `JSON.stringify` has no representation for the non-finite numbers and emits
 * `null`, so a warning about YAML's `-.inf` would read "tier is null" — naming
 * a value that appears nowhere in the file the reader is being asked to fix.
 */
function describeValue(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return JSON.stringify(v);
}

/**
 * A RECOGNISED key carrying the wrong TYPE of value.
 *
 * The unknown-key warner above covers a misspelled key. It does not cover a
 * correctly-spelled one whose value cannot be read: the coercions in
 * coercions.ts drop on mismatch and the caller supplies a default, silently.
 * So `tier: metered` runs at the default tier 3 and `weight: very-high`
 * becomes 1.0, both feeding routing decisions with nothing said.
 *
 * Reports rather than rejects, like every other warning here: the config still
 * loads, and `doctor` exits non-zero so the signal is not merely decorative.
 *
 * The one thing it does beyond reporting is DELETE an out-of-range numeric
 * value from the entry, so the built-in default applies. A non-numeric
 * `tier: metered` already ends up at the default because `num()` cannot read
 * it; `tier: -5` differs only in that the coercion CAN read it, which is
 * exactly why it is dangerous — it reaches routing and wins. Deleting the key
 * makes both unusable cases behave the way either warning says they do
 * ("IGNORED, and the built-in default applies instead").
 *
 * Every caller warns before it parses the same object, so the deletion is
 * visible to the parse that follows.
 */
export function warnMistypedRouteValues(
  entry: Record<string, unknown>,
  label: string,
  warnings: string[],
): void {
  for (const [key, value] of Object.entries(entry)) {
    if (value === null || value === undefined) continue;
    if (key === "instructions") {
      warnInstructions(value, label, warnings);
      continue;
    }
    if (key === "escalate_on") {
      // A list of task types. Anything else is dropped by the parser; `[]` is
      // honoured ("never escalate"), so a typo here is not the same as `[]`
      // and must say what happened instead of quietly meaning something else.
      if (!Array.isArray(value)) {
        warnings.push(
          `${label}: escalate_on is ${describeValue(value)}, which is not a list — IGNORED, ` +
            `and the default (plan, review) applies instead.`,
        );
      } else {
        const bad = value.filter((v) => !ESCALATE_ON_VALUES.includes(v as string));
        if (bad.length > 0) {
          warnings.push(
            `${label}: escalate_on has ${bad.map(describeValue).join(", ")}, which ` +
              `${bad.length === 1 ? "is not a task type" : "are not task types"} ` +
              `(${ESCALATE_ON_VALUES.join(", ")}) — IGNORED. ` +
              (bad.length === value.length
                ? `Nothing valid is left, so this route never escalates to its escalate_model.`
                : `The valid ones still apply.`),
          );
        }
      }
      continue;
    }
    if (key === "model_tiers") {
      // A misspelled tier (`strongest:`) is otherwise dropped by the parser,
      // and a dispatch asking for that tier quietly runs the route's default.
      if (typeof value !== "object" || Array.isArray(value)) {
        warnings.push(
          `${label}: model_tiers is ${describeValue(value)}, which is not a map of ` +
            `tier to model id — IGNORED.`,
        );
        continue;
      }
      for (const [tier, model] of Object.entries(value as Record<string, unknown>)) {
        if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
          warnings.push(
            `${label}: model_tiers has "${tier}", which is not a tier ` +
              `(${MODEL_TIERS.join(", ")}) — IGNORED.`,
          );
        } else if (typeof model !== "string" || model === "") {
          warnings.push(
            `${label}: model_tiers.${tier} is ${describeValue(model)}, which is not a ` +
              `model id — IGNORED, and this route runs its default model for that tier.`,
          );
        }
      }
      continue;
    }
    if (key === "capabilities" && typeof value === "object" && !Array.isArray(value)) {
      // Nested, so the per-key checks below never saw these. They are
      // multiplied straight into the route's score: `review: .inf` made a
      // route win every comparison, `.nan` left the order to config position,
      // and a word like `review: high` silently became full capability, 1.0 —
      // all without a warning. Dropped, like the fields below, so the default
      // really does apply.
      const caps = value as Record<string, unknown>;
      for (const task of ["execute", "plan", "review"] as const) {
        const v = caps[task];
        if (v === undefined || v === null) continue;
        if (!readsAsNumber(v) || Number(v) < 0) {
          warnings.push(
            `${label}: capabilities.${task} is ${describeValue(v)}, which is not a number ` +
              `of 0 or more — IGNORED, and the built-in default applies instead. Routing ` +
              `multiplies this into the route's score for ${task} tasks.`,
          );
          delete caps[task];
        }
      }
      continue;
    }
    if (NUMERIC_ROUTE_KEYS.has(key) && !readsAsNumber(value)) {
      // Per field, for the same reason the range branch varies its text:
      // routing does not read `timeout_ms` or the token caps, so the routing
      // sentence must not be emitted for them.
      warnings.push(
        `${label}: ${key} is ${describeValue(value)}, which is not a number — ` +
          `IGNORED, and the built-in default applies instead. ` +
          (ROUTING_SCORED_KEYS.has(key)
            ? `Routing reads this field, so the route is not behaving the way this ` +
              `line says it does.`
            : `The route runs with the built-in ${key}, not the one written here.`),
      );
      // Warning alone would not be enough here. `.inf` and `.nan` are
      // `typeof "number"`, so `num()` hands them straight back and the route
      // loads at `tier=-Infinity, weight=Infinity` — ahead of every tier and
      // above every score — underneath a warning claiming the built-in default
      // applies.
      delete entry[key];
    } else if (NUMERIC_ROUTE_KEYS.has(key)) {
      const bound = NUMERIC_ROUTE_MINIMUMS[key];
      const n = Number(value);
      if (bound !== undefined && (bound.exclusive ? n <= bound.min : n < bound.min)) {
        // The consequence differs by field: routing does not multiply
        // `timeout_ms` or the token caps, and a warning that explains the
        // wrong mechanism teaches the reader something untrue about their own
        // config.
        const consequence = ROUTING_SCORED_KEYS.has(key)
          ? `Routing multiplies these fields and orders tiers ascending, so a ` +
            `negative one PROMOTES the route over every other rather than demoting it.`
          : `A value at or below ${bound.min} here does not mean "no limit"; it ` +
            `describes a route that can never do any work.`;
        warnings.push(
          `${label}: ${key} is ${describeValue(value)}, which is below the minimum ` +
            `of ${bound.min}${bound.exclusive ? " (exclusive)" : ""} — IGNORED, and the ` +
            `built-in default applies instead. ${consequence}`,
        );
        delete entry[key];
      }
    }
    if (BOOLEAN_ROUTE_KEYS.has(key) && typeof value !== "boolean") {
      // A quoted "true"/"false" is accepted by bool() and is not a mistake
      // worth reporting; anything else selects the default silently.
      if (value === "true" || value === "false") continue;
      warnings.push(
        `${label}: ${key} is ${describeValue(value)}, which is not true or false — ` +
          `IGNORED, and the built-in default applies instead.`,
      );
    }
  }
}

/**
 * Two route entries sharing one name.
 *
 * The later entry wins outright, so everything the earlier one declared is
 * gone: a first entry setting `safety_profile: read_only` and
 * `workspace_policy: copy`, replaced by a second with neither, leaves the
 * surviving route running `workspace_edit` / `shared_locked` — silently LESS
 * restrictive than what was written.
 */
export function warnDuplicateRouteNames(
  names: Array<string | undefined>,
  block: string,
  warnings: string[],
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of names) {
    if (name === undefined || name === "") continue;
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    if (reported.has(name)) continue;
    reported.add(name);
    warnings.push(
      `${block}: "${name}" is declared more than once — only the LAST entry ` +
        `survives, and every field the earlier one set is discarded, including ` +
        `safety_profile and workspace_policy. If the earlier entry restricted ` +
        `this route, that restriction is NOT in effect.`,
    );
  }
}

/**
 * Top-level keys the parser ACCEPTS and nothing reads, each with what to do
 * instead.
 *
 * Silently allowing them is worse than rejecting them: `default_safety_profile`
 * is a safety-control name that does nothing at all, which is the exact
 * failure this module exists to prevent. They stay allow-listed (so they are
 * not reported as typos, and an older file keeps loading) but say plainly that
 * setting them has no effect.
 *
 * If one is implemented later, delete it from here and the warning goes away.
 *
 * `policy` and `workspace_policy` are here because both names ARE real
 * per-route keys (see KNOWN_ROUTE_KEYS), which makes the top-level spelling
 * plausible enough to write by mistake: it looks like a global default for the
 * per-route setting, and there is no such thing. (`raw?.policy` in jobs.ts
 * reads a JOB MANIFEST, not this config file.) `protocol` is the same shape of
 * mistake: it is a real key INSIDE a `clis:` entry, never at the top level.
 *
 * `leaderboard` is here for a different reason: it was implemented and then
 * removed (see REMOVED_ROUTE_KEYS), and a config that still sets it must be
 * told so rather than left believing it is scoring by benchmark.
 */
const ACCEPTED_BUT_IGNORED: Record<string, { status: string; instead: string }> = {
  version: { status: "NEVER READ", instead: "Remove it." },
  protocol: {
    status: "NEVER READ at the top level",
    instead:
      "A protocol block belongs inside a `clis:` entry (see " +
      "docs/configuration.md#adding-a-harness). Remove it from here.",
  },
  protocols: {
    status: "NOT IMPLEMENTED",
    instead: "Define the protocol inside the `clis:` entry that needs it.",
  },
  default_safety_profile: {
    status: "NOT IMPLEMENTED",
    instead:
      "Set `safety_profile:` on each `clis:` / `endpoints:` entry; until then routes run " +
      "under the built-in default.",
  },
  policy: {
    status: "NOT IMPLEMENTED",
    instead: "`policy` is not a global setting; see the per-route keys.",
  },
  workspace_policy: {
    status: "NOT IMPLEMENTED",
    instead:
      "Set `workspace_policy:` on each route, or pass `workspacePolicy` per dispatch.",
  },
  leaderboard: {
    status: REMOVED_TOP_LEVEL_STATUS,
    instead:
      "The Arena-ELO leaderboard was cut. Routing is tier, then weight x capability, " +
      "then fallback. Delete the block.",
  },
};

export function warnUnknownTopLevelKeys(raw: Record<string, unknown>, warnings: string[]): void {
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(ACCEPTED_BUT_IGNORED, key)) {
      const { status, instead } = ACCEPTED_BUT_IGNORED[key]!;
      warnings.push(
        `${key}: recognised but ${status} — setting it has no effect. ${instead} ` +
          `It is not a typo.`,
      );
      continue;
    }
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue;
    if (key.endsWith("_api_key")) continue; // documented per-route shorthand
    warnings.push(
      `unknown top-level config key: ${key} — IGNORED. Check the spelling against ` +
        `the documented keys (${[...KNOWN_TOP_LEVEL_KEYS].slice(0, 6).join(", ")}, ...).`,
    );
  }
}

export function warnUnknownSafetyEnums(node: unknown, warnings: string[], where = ""): void {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) warnUnknownSafetyEnums(v, warnings, `${where}[${i}]`);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const label =
    typeof obj.name === "string" && obj.name !== "" ? String(obj.name) : where || "config";
  for (const [key, allowed] of Object.entries(FAIL_OPEN_ENUMS)) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value === "string" && allowed.includes(value)) continue;
    // effective_safety may also be a per-request map; validate it entry by
    // entry so a typo in one key still warns without condemning the whole
    // block. See effectiveSafetyFrom().
    if (key === "effective_safety" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      const bad = entries.filter(
        ([k, v]) => !allowed.includes(k) || typeof v !== "string" || !allowed.includes(v),
      );
      if (bad.length === 0) continue;
      warnings.push(
        `${label}: effective_safety: ${bad.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} ` +
          `is not a ${allowed.join("/")} pair — IGNORED for those requests.`,
      );
      continue;
    }
    warnings.push(
      `${label}: ${key}: ${JSON.stringify(value)} is not one of ${allowed.join(", ")} — ` +
        `IGNORED, and the default applies instead, which is less restrictive than what ` +
        `this looks like it was meant to set. Fix the value.`,
    );
  }
  for (const [k, v] of Object.entries(obj)) {
    warnUnknownSafetyEnums(v, warnings, where ? `${where}.${k}` : k);
  }
}
