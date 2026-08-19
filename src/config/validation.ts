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
  "leaderboard_model", "escalate_model", "escalate_on",
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
 */
const ACCEPTED_BUT_UNIMPLEMENTED = new Set(["protocols", "default_safety_profile"]);

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
