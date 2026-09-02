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
  // The flag-gap check runs FIRST, ahead of any declared floor, because no
  // declaration can conjure a flag that does not exist.
  //
  // It used to run last, so `effective_safety` returned before ever reaching
  // it — and a route pinning `effective_safety: read_only` while defining
  // flags for only `workspace_edit` launched its harness with NO safety
  // argument, reported `read_only` on every surface including the dispatch
  // log, and wrote a file into the project under a read_only dispatch. An
  // acceptance pass measured the argv and the resulting file. Worse, this
  // file's own comment below offered pinning as the REMEDY for a flag gap,
  // when it was the way to silence the check.
  //
  // A pin is still honoured for a route that is not flag-controlled at all
  // (`protocol.safety` undefined) — that is a route saying "I am capped by
  // construction", which is the case the pin exists for, and the one an
  // endpoint or a wrapper script is in.
  //
  // `{{safety}}` expands to the protocol's argument list for the requested
  // profile, and to `[]` when the profile is missing (generic-cli.ts), so a
  // gap means the harness launches with no safety argument at all. Reporting
  // `full_auto` is what makes `safetyProfileCompatible` refuse the route for a
  // stricter request — the safe direction: a route that cannot prove it
  // constrains anything is treated as constraining nothing.
  //
  // NOT true of every shipped harness, and this comment said it was:
  // `cursor_cli` declares `safety:` with `read_only` only, deliberately (the
  // other profiles run print mode with no extra flags). So the gap check
  // fires on a SHIPPED route for two of the three profiles, reporting
  // `full_auto` — the safe direction, and the reason it is not a defect, but
  // an operator reading "the shipped harnesses are unaffected" would not
  // expect it and could not explain what they were seeing.
  if (svc.protocol?.safety !== undefined) {
    const request = requestedSafetyProfile(svc, requested);
    if (svc.protocol.safety[request] === undefined) return "full_auto";
  }

  // A route's declared capability floor wins over the request — this comes
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
