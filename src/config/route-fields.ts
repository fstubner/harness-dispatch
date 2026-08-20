/**
 * One field contract shared by every route shape.
 *
 * THE DEFECT THIS EXISTS TO RETIRE. `clis:`, `endpoints:` and the legacy
 * `services:` block each resolved route fields with their own hand-written
 * list, so a key added to one was easy to forget in the others. That produced
 * five separate silent-drop defects in one file, each the same shape: a
 * correctly-spelled, correctly-valued setting written in config and read by
 * nobody —
 *
 *   workspace_policy   honoured for services:/endpoints:, dropped for clis:
 *   api_keys           honoured for clis:,               dropped for endpoints:
 *   effective_safety   honoured for clis:/services:,      dropped for endpoints:
 *   escalate_model     honoured for clis:,               dropped for endpoints:
 *
 * These are safety and isolation controls, so "silently absent" means
 * "silently less restrictive" — a route asked to run `read_only` running with
 * write access, a route asked to run in an isolated copy running in the user's
 * repository. Nothing warns, because nothing is wrong with what was written.
 *
 * WHY A TABLE RATHER THAN A SHARED FUNCTION. The obvious unification — have
 * the CLI builder call the endpoint builder's `billingFields()` — is wrong,
 * and tests/route-field-parity.test.ts says why: the CLI path resolves
 * `entry.X ?? harnessDefaults.X` against the defaults shipped in
 * config.default.yaml, and `billingFields(raw)` has no defaults layer at all.
 * Collapsing them would silently drop the fallback every built-in harness
 * relies on — trading five silent-drop bugs for a bigger one. A table carries
 * the defaults layer explicitly: each field says how to parse it AND where its
 * fallback comes from, and a shape with no defaults (endpoints) simply passes
 * none.
 *
 * WHAT IS DELIBERATELY NOT HERE. Billing identity — provider, surface,
 * auth_source, billing_kind, paid_usage_possible — resolves differently per
 * shape for real reasons, not by accident: endpoints infer it from the base
 * URL (localhost is local_compute), while CLI routes factor in whether an
 * api_key is present (a key means a metered account exists whatever the
 * declared kind says). Those stay in their builders. Pretending they are
 * shared would be the same mistake in the other direction.
 *
 * tests/route-field-parity.test.ts still pins every key here against both
 * shapes. It is no longer the only thing standing between a new field and a
 * silent drop, but it is what proves this table is actually wired into both.
 */

import { normalizeSafetyProfile } from "../safety.js";
import type { SafetyProfile, ServiceConfig } from "../types.js";
import {
  confidenceFrom,
  str,
  thinkingFrom,
  workspacePolicyFrom,
} from "./coercions.js";
import { stringArrayFrom } from "./protocol.js";

/**
 * The subset of a harness's shipped defaults that shared fields fall back to.
 *
 * Structural on purpose: `CliDefaults` satisfies it without this module
 * needing to import config.ts (which imports this one).
 */
export type RouteFieldDefaults = Partial<
  Pick<
    ServiceConfig,
    | "leaderboardModel"
    | "thinkingLevel"
    | "maxOutputTokens"
    | "maxInputTokens"
    | "effectiveSafety"
    | "models"
    | "modelHint"
  >
>;

interface RouteFieldSpec {
  /** The key exactly as written in config.yaml. */
  key: string;
  /** The ServiceConfig property it populates. */
  field: keyof ServiceConfig;
  /** Parse a declared value. `undefined` means absent or unusable. */
  parse: (raw: unknown) => unknown;
  /**
   * Fallback when the entry does not declare the key. Omitted for fields
   * with no harness-level default (nothing ships an `escalate_model`).
   */
  fromDefaults?: (d: RouteFieldDefaults) => unknown;
}

/** A number only when it really is one — `int()`/`num()` coerce, and these must not. */
function numberOnly(raw: unknown): number | undefined {
  return typeof raw === "number" ? raw : undefined;
}

/** Likewise for booleans: an absent flag must stay absent, not become false. */
function booleanOnly(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * `effective_safety` is either one profile for every request, or a per-request
 * map. Shared by all three shapes; lived in config.ts before this table.
 */
export function effectiveSafetyFrom(
  raw: unknown,
): SafetyProfile | Partial<Record<SafetyProfile, SafetyProfile>> | undefined {
  const single = normalizeSafetyProfile(raw);
  if (single !== undefined) return single;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Partial<Record<SafetyProfile, SafetyProfile>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const requested = normalizeSafetyProfile(key);
    const floor = normalizeSafetyProfile(value);
    if (requested !== undefined && floor !== undefined) out[requested] = floor;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Every optional field that means the same thing on every route shape.
 *
 * Adding a route setting means adding ONE row here (plus its key to
 * KNOWN_ROUTE_KEYS in validation.ts, which is what catches misspellings) and
 * it works on `clis:`, `endpoints:` and `services:` at once. That is the whole
 * point: the old failure mode was a field that existed in one list and not the
 * others.
 */
const SHARED_ROUTE_FIELDS: RouteFieldSpec[] = [
  { key: "leaderboard_model", field: "leaderboardModel", parse: str, fromDefaults: (d) => d.leaderboardModel },
  { key: "thinking_level", field: "thinkingLevel", parse: thinkingFrom, fromDefaults: (d) => d.thinkingLevel },
  { key: "escalate_model", field: "escalateModel", parse: str },
  { key: "max_output_tokens", field: "maxOutputTokens", parse: numberOnly, fromDefaults: (d) => d.maxOutputTokens },
  { key: "max_input_tokens", field: "maxInputTokens", parse: numberOnly, fromDefaults: (d) => d.maxInputTokens },
  { key: "timeout_ms", field: "timeoutMs", parse: numberOnly },
  { key: "resource_weight", field: "resourceWeight", parse: numberOnly },
  // Safety and isolation. Four of the five original silent drops were here.
  { key: "safety_profile", field: "safetyProfile", parse: normalizeSafetyProfile },
  { key: "effective_safety", field: "effectiveSafety", parse: effectiveSafetyFrom, fromDefaults: (d) => d.effectiveSafety },
  { key: "workspace_policy", field: "workspacePolicy", parse: workspacePolicyFrom },
  // Billing fields that are plain declarations. The INFERRED ones
  // (provider/surface/auth_source/billing_kind/paid_usage_possible) stay in
  // the builders — see the header.
  { key: "allow_paid_usage", field: "allowPaidUsage", parse: booleanOnly },
  { key: "billing_confidence", field: "billingConfidence", parse: confidenceFrom },
  { key: "billing_notes", field: "billingNotes", parse: str },
  { key: "models", field: "models", parse: stringArrayFrom, fromDefaults: (d) => d.models },
  { key: "model_hint", field: "modelHint", parse: str, fromDefaults: (d) => d.modelHint },
];

/** The YAML keys this table owns — used by tests to prove both shapes are wired to it. */
export const SHARED_ROUTE_FIELD_KEYS: readonly string[] = SHARED_ROUTE_FIELDS.map((f) => f.key);

/**
 * Resolve every shared field for one route entry.
 *
 * A field is emitted only when it resolves to something, so callers can spread
 * the result over a partially-built ServiceConfig without overwriting anything
 * with `undefined`.
 *
 * @param raw the route entry as written in config.yaml
 * @param defaults the harness's shipped defaults, for shapes that have them
 * (`clis:`). Endpoint entries pass nothing — they have no defaults layer, and
 * inventing one is the mistake this table's header warns about.
 */
export function resolveSharedRouteFields(
  raw: Record<string, unknown>,
  defaults?: RouteFieldDefaults,
): Partial<ServiceConfig> {
  const out: Record<string, unknown> = {};
  for (const spec of SHARED_ROUTE_FIELDS) {
    const declared = spec.parse(raw[spec.key]);
    const value = declared ?? (defaults !== undefined ? spec.fromDefaults?.(defaults) : undefined);
    if (value !== undefined) out[spec.field] = value;
  }
  return out as Partial<ServiceConfig>;
}
