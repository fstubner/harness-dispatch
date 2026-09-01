/**
 * What a config file is ALLOWED to say, and what to warn about when it says
 * something else.
 *
 * Split out of config.ts. This module exists because of a specific, repeated
 * failure: the parser reads what it recognises and cannot distinguish a key it
 * does not know from a key that is absent. Four silent-drop defects came from
 * that — a misspelled `workspace_policy` or `safety_profile` left the route
 * running under the LESS restrictive default, silently.
 *
 * So the legal surface is enumerated here rather than implied by whatever the
 * builders happen to read. Keeping it in one file is the point: a per-shape
 * copy is what drifted last time.
 */

import type { SafetyProfile } from "../types.js";
import { normalizeSafetyProfile } from "../safety.js";

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
 * direction for a safety control. The same parser already warns loudly for a
 * malformed `protocol` block, so this is consistency as much as safety.
 *
 * Walks the raw tree rather than hooking each builder: the same keys appear
 * under services:, clis:, endpoints: and overrides:, and a single walk cannot
 * miss a format the way four separate call sites can.
 */
export const FAIL_OPEN_ENUMS: Record<string, readonly string[]> = {
  // Billing enums, added after a review found `billing_kind: metered-api`
  // (hyphen, not underscore) silently resolving to the harness default of
  // `included_plan_then_flexible_credits` with paidUsagePossible false and no
  // warning. This block existed precisely for enums whose fallback is LESS
  // restrictive than the value attempted, and billing is the other hard
  // constraint the product states — a typo here silently marks a metered route
  // as free.
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
 * Every key this parser understands at the top level of config.yaml.
 *
 * `doctor` reported "no unrecognized config entries" while a typo'd or
 * invented top-level key produced no warning at all — the check's own name
 * promised something it never did. A misspelled `max_concurrent_runs` is
 * indistinguishable from not setting it, which is exactly the silent-default
 * class that has bitten this file twice already.
 */
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version",
  // Opt back into auto-detection when a config defines its own routes, or
  // opt out when it does not. See loadConfig for the three cases.
  "detect",
  "clis",
  "endpoints",
  "services",
  "disabled",
  "overrides",
  "api_keys",
  "protocols",
  "policy",
  "telemetry",
  "retention",
  "leaderboard",
  "max_concurrent_runs",
  "default_safety_profile",
  "workspace_policy",
  "protocol",
]);

/**
 * Every key a `clis:` or `endpoints:` entry may carry.
 *
 * ROOT-CAUSE FIX, not a fourth instance. Three separate silent-drop defects
 * were found in this file in one day — workspace_policy ignored for `clis:`,
 * api_keys ignored for `endpoints:`, unknown top-level keys unwarned — and
 * each was patched individually. Measured afterwards: a route carrying
 * `workspace_polcy`, `safety_profil` and `tierr` still produced ZERO warnings
 * and silently got none of the three.
 *
 * The mechanism is that this parser reads what it recognises and cannot
 * distinguish a key it does not know from a key that is absent. Nothing
 * enumerated the legal surface, so every future misspelling was guaranteed to
 * fail the same silent way — and these are safety and isolation controls, so
 * "silently absent" means "silently less restrictive".
 *
 * Kept as one list for both entry shapes on purpose. Splitting it per shape
 * would recreate the original defect, where two parallel field lists drifted
 * and each was missing something the other had.
 */
export const KNOWN_ROUTE_KEYS = new Set([
  "name", "harness", "type", "command", "enabled", "model", "models", "model_hint",
  "tier", "weight", "cli_capability", "capabilities", "timeout_ms",
  "max_input_tokens", "max_output_tokens", "thinking_level",
  "leaderboard_model", "escalate_model", "escalate_on", "resource_weight",
  "api_key", "base_url", "protocol", "filter",
  "provider", "surface", "auth_source", "billing_kind", "billing_confidence",
  "billing_notes", "paid_usage_possible", "allow_paid_usage",
  "safety_profile", "effective_safety", "workspace_policy",
  "endpoint_mode", "endpoint_provider", "wire_protocol",
]);

export function warnUnknownRouteKeys(
  entry: Record<string, unknown>,
  label: string,
  warnings: string[],
): void {
  for (const key of Object.keys(entry)) {
    if (KNOWN_ROUTE_KEYS.has(key)) continue;
    warnings.push(
      `${label}: unknown key "${key}" — IGNORED. If this was meant to be a ` +
        `safety or workspace setting, it is NOT in effect; check the spelling.`,
    );
  }
  warnMistypedRouteValues(entry, label, warnings);
}

/** Recognised keys whose value must be a number, and what they mean if lost. */
const NUMERIC_ROUTE_KEYS = new Set([
  "tier",
  "weight",
  "cli_capability",
  "max_output_tokens",
  "max_input_tokens",
  "timeout_ms",
]);

/**
 * The smallest value each numeric route key can carry and still mean anything.
 *
 * Every one of these is positive-only, and being in range is not a style
 * preference — the router multiplies three of them together
 * (`quality * cli_capability * capability * quota * weight`) and orders by
 * `tier` ASCENDING. A negative pair therefore does not degrade a route, it
 * PROMOTES it: an acceptance pass measured `tier: -5, weight: -100,
 * cli_capability: -3` scoring 299.8 against a normal route's 0.88, from a
 * tier that sorts ahead of every real one — a route that wins every routing
 * decision, silently, with no warning anywhere.
 *
 * `tier` starts at 1 because tier 1 is the frontier band and lower sorts
 * first; 0 and below are ahead of a band that already means "best". The rest
 * are exclusive of 0 (a zero weight or capability multiplies the score to
 * nothing, and a zero timeout is not a timeout).
 *
 * No upper bounds. `cli_capability: 1.1` ships in this repo's own default
 * config as deliberate tuning, so a cap would reject a documented value; the
 * defect being fixed is sign, not magnitude.
 */
const NUMERIC_ROUTE_MINIMUMS: Record<string, { min: number; exclusive: boolean }> = {
  tier: { min: 1, exclusive: false },
  weight: { min: 0, exclusive: true },
  cli_capability: { min: 0, exclusive: true },
  max_output_tokens: { min: 0, exclusive: true },
  max_input_tokens: { min: 0, exclusive: true },
  timeout_ms: { min: 0, exclusive: true },
};

/**
 * Of those, the ones the router actually multiplies into a score.
 *
 * Only these three get the "PROMOTES the route" explanation. Giving that
 * reason for `timeout_ms` or a token cap told the operator something untrue
 * about their own config: routing multiplies neither.
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
 * Finite on both branches, and the string branch is the one that was wrong:
 * `Number("1e999")` is `Infinity`, and `!Number.isNaN(Infinity)` is true, so a
 * YAML `weight: 1e999` (which parses as a string, not a number) sailed through
 * as "reads as a number", then sailed through the range check too — `Infinity`
 * is not below any minimum. An acceptance pass measured it loading as
 * `weight = Infinity` with NO warning of any kind.
 *
 * `Number.isFinite` on both branches closes that: `.inf`, `-.inf`, `.nan` and
 * `1e999` are all unusable, whichever way YAML happened to type them.
 */
function readsAsNumber(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v !== "" && Number.isFinite(Number(v));
}

/**
 * How to name the offending value back to the operator.
 *
 * `JSON.stringify` has no representation for the non-finite numbers and emits
 * `null`, so a warning about YAML's `-.inf` read "tier is null" — naming a
 * value that appears nowhere in the file the reader is being asked to fix.
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
 * That file's own header names this gap and points at the unknown-key warning
 * as the mitigation — which does not cover it, because the key is not unknown.
 *
 * Found live on the maintainer's machine by an acceptance pass: four routes
 * carrying `tier: metered`, which is not a number, silently running at the
 * default tier 3. Nothing had ever said so. `weight: very-high` becomes 1.0 the
 * same way, and both feed routing decisions.
 *
 * Reports rather than rejects, like every other warning here: the config still
 * loads, and `doctor` exits non-zero so the signal is not merely decorative.
 *
 * The one thing it does beyond reporting is DELETE an out-of-range numeric
 * value from the entry, so the built-in default applies. That is not a second
 * behaviour bolted on: a non-numeric `tier: metered` already ends up at the
 * default, because `num()` cannot read it. `tier: -5` is different only in
 * that the coercion CAN read it, which is exactly why it is dangerous — it
 * reaches routing and wins. Deleting the key makes the two unusable cases
 * behave the same way, which is what an operator reading either warning
 * ("IGNORED, and the built-in default applies instead") is being told.
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
    if (NUMERIC_ROUTE_KEYS.has(key) && !readsAsNumber(value)) {
      // Per field, for the same reason the range branch varies its text: the
      // routing sentence was emitted for all six keys, and routing does not
      // read `timeout_ms` or the token caps. The very next acceptance pass
      // found this branch still saying it after the other was fixed — the
      // same defect one branch over, in one function.
      warnings.push(
        `${label}: ${key} is ${describeValue(value)}, which is not a number — ` +
          `IGNORED, and the built-in default applies instead. ` +
          (ROUTING_SCORED_KEYS.has(key)
            ? `Routing reads this field, so the route is not behaving the way this ` +
              `line says it does.`
            : `The route runs with the built-in ${key}, not the one written here.`),
      );
      // This branch WARNED without neutralising, and for a plain unreadable
      // value that was harmless — `num()` returns the default anyway, so the
      // warning was true by accident. `.inf` and `.nan` are `typeof "number"`,
      // so `num()` hands them straight back: the route loaded at
      // `tier=-Infinity, weight=Infinity` — ahead of every tier and above
      // every score — underneath a warning reading "IGNORED, and the built-in
      // default applies instead". The message asserted the opposite of what
      // happened, which is worse than the silence it replaced.
      delete entry[key];
    } else if (NUMERIC_ROUTE_KEYS.has(key)) {
      const bound = NUMERIC_ROUTE_MINIMUMS[key];
      const n = Number(value);
      if (bound !== undefined && (bound.exclusive ? n <= bound.min : n < bound.min)) {
        // The consequence differs by field, and stating the routing one for
        // all six was simply false: routing does not multiply `timeout_ms` or
        // the token caps. A warning that explains the wrong mechanism teaches
        // the reader something untrue about their own config.
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
 * gone. An acceptance pass measured the consequence: a first entry setting
 * `safety_profile: read_only` and `workspace_policy: copy` was replaced by a
 * second with neither, and the surviving route ran `workspace_edit` /
 * `shared_locked` — silently LESS restrictive than what was written, with no
 * warning on any surface.
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
 * Keys the parser ACCEPTS and nothing reads.
 *
 * Silently allowing them is worse than rejecting them: `default_safety_profile`
 * is a safety-control name that does nothing at all, which is the exact
 * failure this module exists to prevent. They stay allow-listed (so they are
 * not reported as typos) but say plainly that setting them has no effect.
 *
 * Verified read-nowhere in src/ at the time of writing; if one is implemented
 * later, delete it from here and the warning goes away.
 *
 * `policy` and `workspace_policy` were added after an acceptance pass found
 * them allow-listed at top level and read nowhere — top-level isolation
 * controls that do nothing, the same shape as `default_safety_profile` above.
 * Both names ARE real per-route keys (see KNOWN_ROUTE_KEYS), which is what
 * makes the top-level spelling plausible enough to write by mistake: it looks
 * like a global default for the per-route setting, and there is no such thing.
 * Re-verified read-nowhere at top level on 2026-08-31 — `raw?.policy` in
 * jobs.ts reads a JOB MANIFEST, not this config file.
 */
const ACCEPTED_BUT_UNIMPLEMENTED = new Set([
  "protocols",
  "default_safety_profile",
  "policy",
  "workspace_policy",
]);

export function warnUnknownTopLevelKeys(raw: Record<string, unknown>, warnings: string[]): void {
  for (const key of Object.keys(raw)) {
    if (ACCEPTED_BUT_UNIMPLEMENTED.has(key)) {
      warnings.push(
        `${key}: recognised but NOT IMPLEMENTED — setting it has no effect. ` +
          `Remove it, or track the gap; it is not a typo.`,
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
