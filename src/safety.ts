import type { SafetyProfile, ServiceConfig } from "./types.js";

export const DEFAULT_SAFETY_PROFILE: SafetyProfile = "workspace_edit";

const SAFETY_LEVEL: Record<SafetyProfile, number> = {
  read_only: 0,
  workspace_edit: 1,
  full_auto: 2,
};

export function normalizeSafetyProfile(value: unknown): SafetyProfile | undefined {
  if (value === "read_only" || value === "workspace_edit" || value === "full_auto") {
    return value;
  }
  return undefined;
}

export function requestedSafetyProfile(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): SafetyProfile {
  return requested ?? svc.safetyProfile ?? DEFAULT_SAFETY_PROFILE;
}

export function effectiveSafetyProfile(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): SafetyProfile {
  // A route's declared capability floor wins over any request — this comes
  // from config (`effective_safety:` on the route or its harness defaults),
  // NOT from harness-name special cases in code. openai_compatible is the
  // one structural rule: an HTTP endpoint has no file or shell access, so
  // it is read_only by construction.
  const declared = svc.effectiveSafety;
  if (typeof declared === "string") return declared;
  if (declared !== undefined && declared !== null) {
    // Per-request floor: a harness whose capability genuinely varies by mode.
    // An unlisted request falls through to the rules below rather than
    // defaulting to something permissive.
    const mapped = declared[requestedSafetyProfile(svc, requested)];
    if (mapped !== undefined) return mapped;
  }
  if (svc.type === "openai_compatible") return "read_only";

  // A CLI route that controls safety with FLAGS, asked for a profile it has no
  // flags for, runs unconstrained. Report that honestly instead of echoing the
  // request back.
  //
  // `{{safety}}` expands to the protocol's argument list for the requested
  // profile, and to `[]` when the profile is missing (generic-cli.ts). So a
  // route whose `protocol.safety` defines workspace_edit and full_auto but not
  // read_only launched the harness with NO safety arguments at all — and
  // because this function returned the REQUESTED profile, nothing skipped the
  // route and the dispatch log recorded `safetyProfile: read_only` for a run
  // that carried no restriction. An acceptance pass measured the child's argv:
  // just the prompt.
  //
  // The shipped harnesses are unaffected — they define all three profiles, or
  // pin the gaps with `effective_safety`. This is the user-added route case,
  // where nothing required either.
  //
  // Reporting `full_auto` here is what makes `safetyProfileCompatible` refuse
  // the route for a stricter request, which is the safe direction: a route that
  // cannot prove it constrains anything is treated as constraining nothing.
  if (svc.protocol?.safety !== undefined) {
    const request = requestedSafetyProfile(svc, requested);
    if (svc.protocol.safety[request] === undefined) return "full_auto";
  }

  return requestedSafetyProfile(svc, requested);
}

export function safetyProfileCompatible(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): boolean {
  const request = requestedSafetyProfile(svc, requested);
  const effective = effectiveSafetyProfile(svc, requested);
  return SAFETY_LEVEL[effective] <= SAFETY_LEVEL[request];
}
